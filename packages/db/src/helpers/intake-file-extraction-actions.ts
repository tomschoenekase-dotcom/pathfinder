import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const terminalInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    runId: z.string().trim().min(1).max(191),
    uploadId: z.string().trim().min(1).max(191),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    outcome: z.enum(['SUCCEEDED', 'FAILED']),
    sourceObjectGeneration: z.string().uuid(),
    sourceStorageVersionId: z.string().trim().min(1).max(1024),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceByteSize: z.number().int().min(1).max(10_485_760),
    sourceMimeType: z.enum([
      'application/json',
      'application/pdf',
      'text/plain',
      'text/markdown',
      'text/csv',
    ]),
    extractor: z.enum(['pathfinder-utf8-document', 'pathfinder-pdfjs-document']),
    extractorVersion: z.literal('1'),
    extractedText: z.string().min(1).max(1_000_000).optional(),
    extractedTextHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    extractedCharacterCount: z.number().int().min(0).max(500_000),
    extractedLineCount: z.number().int().min(0).max(500_000),
    errorCode: z.string().trim().min(1).max(64).optional(),
    errorMessage: z.string().trim().min(1).max(500).optional(),
    createdBy: z.string().trim().min(1).max(191),
  })
  .strict()
  .superRefine((value, context) => {
    const pdfSource = value.sourceMimeType === 'application/pdf'
    const extractorMatchesSource = pdfSource
      ? value.extractor === 'pathfinder-pdfjs-document'
      : value.extractor === 'pathfinder-utf8-document' && value.sourceByteSize <= 2_097_152
    if (!extractorMatchesSource) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['extractor'],
        message: 'File extraction source and bounded extractor do not match.',
      })
    }
    const successful = value.outcome === 'SUCCEEDED'
    const successShape =
      Boolean(value.extractedText) &&
      Boolean(value.extractedTextHash) &&
      value.extractedCharacterCount > 0 &&
      value.extractedLineCount > 0 &&
      !value.errorCode &&
      !value.errorMessage
    const failureShape =
      !value.extractedText &&
      !value.extractedTextHash &&
      value.extractedCharacterCount === 0 &&
      value.extractedLineCount === 0 &&
      Boolean(value.errorCode) &&
      Boolean(value.errorMessage)
    if ((successful && !successShape) || (!successful && !failureShape)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'File extraction terminal evidence does not match its outcome.',
      })
    }
    if (value.extractedText && [...value.extractedText].length !== value.extractedCharacterCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['extractedCharacterCount'],
        message: 'Extracted character count does not match the retained text.',
      })
    }
    if (
      value.extractedText &&
      value.extractedText.split('\n').length !== value.extractedLineCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['extractedLineCount'],
        message: 'Extracted line count does not match the retained text.',
      })
    }
  })

export type RecordIntakeFileExtractionReceiptInput = z.infer<typeof terminalInput>

type IntakeFileExtractionActionClient = Pick<
  typeof db,
  | 'intakeRun'
  | 'intakeUpload'
  | 'intakeFileExtractionReceipt'
  | 'intakeRunEvent'
  | 'auditLog'
  | '$transaction'
>

export class IntakeFileExtractionActionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeFileExtractionActionError'
  }
}

const receiptSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  runId: true,
  uploadId: true,
  requestId: true,
  requestHash: true,
  outcome: true,
  sourceObjectGeneration: true,
  sourceStorageVersionId: true,
  sourceSha256: true,
  sourceByteSize: true,
  sourceMimeType: true,
  extractor: true,
  extractorVersion: true,
  extractedText: true,
  extractedTextHash: true,
  extractedCharacterCount: true,
  extractedLineCount: true,
  errorCode: true,
  errorMessage: true,
  createdBy: true,
  createdAt: true,
} as const

function exactReplay(
  receipt: Record<string, unknown> | null,
  input: RecordIntakeFileExtractionReceiptInput,
) {
  return Boolean(
    receipt &&
    receipt.tenantId === input.tenantId &&
    receipt.venueId === input.venueId &&
    receipt.runId === input.runId &&
    receipt.uploadId === input.uploadId &&
    receipt.requestId === input.operationId &&
    receipt.requestHash === input.requestHash &&
    receipt.outcome === input.outcome &&
    receipt.sourceObjectGeneration === input.sourceObjectGeneration &&
    receipt.sourceStorageVersionId === input.sourceStorageVersionId &&
    receipt.sourceSha256 === input.sourceSha256 &&
    receipt.sourceByteSize === input.sourceByteSize &&
    receipt.sourceMimeType === input.sourceMimeType &&
    receipt.extractor === input.extractor &&
    receipt.extractorVersion === input.extractorVersion &&
    receipt.extractedText === (input.extractedText ?? null) &&
    receipt.extractedTextHash === (input.extractedTextHash ?? null) &&
    receipt.extractedCharacterCount === input.extractedCharacterCount &&
    receipt.extractedLineCount === input.extractedLineCount &&
    receipt.errorCode === (input.errorCode ?? null) &&
    receipt.errorMessage === (input.errorMessage ?? null) &&
    receipt.createdBy === input.createdBy,
  )
}

function result(receipt: { id: string; outcome: string; createdAt: Date }, replayed: boolean) {
  return {
    receiptId: receipt.id,
    outcome: receipt.outcome,
    createdAt: receipt.createdAt,
    replayed,
    reviewRequired: receipt.outcome === 'SUCCEEDED',
    packageDraftCreated: false as const,
    autoApproved: false as const,
    autoApplied: false as const,
    autoPublished: false as const,
  }
}

export async function recordIntakeFileExtractionReceiptAction(
  rawInput: RecordIntakeFileExtractionReceiptInput,
  client: IntakeFileExtractionActionClient = db,
) {
  const parsed = terminalInput.safeParse(rawInput)
  if (!parsed.success) {
    throw new IntakeFileExtractionActionError(
      'INVALID_INPUT',
      'Invalid file extraction terminal evidence.',
    )
  }
  const input = parsed.data
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-file-extraction:${input.tenantId}:${input.venueId}:${input.uploadId}`}, 0))`
    const replay = await tx.intakeFileExtractionReceipt.findUnique({
      where: {
        tenantId_requestId: { tenantId: input.tenantId, requestId: input.operationId },
      },
      select: receiptSelect,
    })
    if (replay) {
      if (!exactReplay(replay, input)) {
        throw new IntakeFileExtractionActionError(
          'CONFLICT',
          'The operation ID is already bound to different file extraction evidence.',
        )
      }
      return result(replay, true)
    }

    const run = await tx.intakeRun.findFirst({
      where: {
        id: input.runId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        sourceKind: 'FILE_UPLOAD',
        status: 'AWAITING_REVIEW',
      },
      select: {
        id: true,
        evidence: {
          select: { sourceKind: true, locator: true, normalizedHash: true, confidence: true },
        },
      },
    })
    if (!run) throw new IntakeFileExtractionActionError('NOT_FOUND', 'File intake run not found.')
    const upload = await tx.intakeUpload.findFirst({
      where: {
        id: input.uploadId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        intakeRunId: input.runId,
        status: 'AWAITING_REVIEW',
      },
      select: {
        id: true,
        objectGeneration: true,
        storageVersionId: true,
        sha256: true,
        byteSize: true,
        mimeType: true,
        verificationReceipts: {
          select: {
            kind: true,
            verdict: true,
            objectGeneration: true,
            storageVersionId: true,
            computedByteSize: true,
            computedSha256: true,
          },
        },
      },
    })
    if (!upload) {
      throw new IntakeFileExtractionActionError('NOT_FOUND', 'Verified file upload not found.')
    }
    const exactSource =
      upload.objectGeneration === input.sourceObjectGeneration &&
      upload.storageVersionId === input.sourceStorageVersionId &&
      upload.sha256 === input.sourceSha256 &&
      upload.byteSize === input.sourceByteSize &&
      upload.mimeType === input.sourceMimeType
    const expectedVerdicts = new Map([
      ['PRECHECK', 'PASSED'],
      ['RESOURCE_SAFETY', 'PASSED'],
      ['MALWARE', 'CLEAN'],
    ])
    const exactReceipts =
      upload.verificationReceipts.length === expectedVerdicts.size &&
      upload.verificationReceipts.every(
        (receipt) =>
          expectedVerdicts.get(receipt.kind) === receipt.verdict &&
          receipt.objectGeneration === input.sourceObjectGeneration &&
          receipt.storageVersionId === input.sourceStorageVersionId &&
          receipt.computedByteSize === input.sourceByteSize &&
          receipt.computedSha256 === input.sourceSha256,
      )
    const exactEvidence =
      run.evidence.length === 1 &&
      run.evidence[0]?.sourceKind === 'FILE_UPLOAD' &&
      run.evidence[0].locator === `intake-upload:${input.uploadId}` &&
      run.evidence[0].normalizedHash === input.sourceSha256 &&
      Number(run.evidence[0].confidence) === 1
    if (!exactSource || !exactReceipts || !exactEvidence) {
      throw new IntakeFileExtractionActionError(
        'CONFLICT',
        'Stored upload verification evidence no longer matches this exact file source.',
      )
    }

    const prior = await tx.intakeFileExtractionReceipt.findFirst({
      where: {
        uploadId: input.uploadId,
        extractor: input.extractor,
        extractorVersion: input.extractorVersion,
      },
      select: receiptSelect,
    })
    if (prior) {
      throw new IntakeFileExtractionActionError(
        'CONFLICT',
        'This exact file and extractor version already have terminal extraction evidence.',
      )
    }

    const receipt = await tx.intakeFileExtractionReceipt.create({
      data: {
        id: input.operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        uploadId: input.uploadId,
        requestId: input.operationId,
        requestHash: input.requestHash,
        outcome: input.outcome,
        sourceObjectGeneration: input.sourceObjectGeneration,
        sourceStorageVersionId: input.sourceStorageVersionId,
        sourceSha256: input.sourceSha256,
        sourceByteSize: input.sourceByteSize,
        sourceMimeType: input.sourceMimeType,
        extractor: input.extractor,
        extractorVersion: input.extractorVersion,
        ...(input.extractedText ? { extractedText: input.extractedText } : {}),
        ...(input.extractedTextHash ? { extractedTextHash: input.extractedTextHash } : {}),
        extractedCharacterCount: input.extractedCharacterCount,
        extractedLineCount: input.extractedLineCount,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        createdBy: input.createdBy,
      },
      select: { id: true, outcome: true, createdAt: true },
    })
    await tx.intakeRunEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        kind: 'FILE_EXTRACTION_RECORDED',
        actorId: input.createdBy,
        metadata: {
          receiptId: receipt.id,
          requestHash: input.requestHash,
          sourceSha256: input.sourceSha256,
          sourceMimeType: input.sourceMimeType,
          extractor: input.extractor,
          extractorVersion: input.extractorVersion,
          outcome: input.outcome,
          extractedTextHash: input.extractedTextHash ?? null,
          extractedCharacterCount: input.extractedCharacterCount,
          extractedLineCount: input.extractedLineCount,
          errorCode: input.errorCode ?? null,
          reviewRequired: input.outcome === 'SUCCEEDED',
          packageDraftCreated: false,
          autoApproved: false,
          autoApplied: false,
          autoPublished: false,
        },
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: 'PLATFORM_ADMIN',
        action: 'intake.file-extraction-recorded',
        targetType: 'IntakeFileExtractionReceipt',
        targetId: receipt.id,
        afterState: {
          runId: input.runId,
          uploadId: input.uploadId,
          requestHash: input.requestHash,
          sourceSha256: input.sourceSha256,
          sourceMimeType: input.sourceMimeType,
          extractor: input.extractor,
          extractorVersion: input.extractorVersion,
          outcome: input.outcome,
          extractedTextHash: input.extractedTextHash ?? null,
          extractedCharacterCount: input.extractedCharacterCount,
          extractedLineCount: input.extractedLineCount,
          errorCode: input.errorCode ?? null,
          reviewRequired: input.outcome === 'SUCCEEDED',
          packageDraftCreated: false,
          autoApproved: false,
          autoApplied: false,
          autoPublished: false,
        },
      },
      tx,
    )
    return result(receipt, false)
  })
}
