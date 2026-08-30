import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  IntakeFileExtractionActionError,
  recordIntakeFileExtractionReceiptAction,
} from './intake-file-extraction-actions'

const findUnique = vi.fn()
const findPrior = vi.fn()
const createReceipt = vi.fn()
const findRun = vi.fn()
const findUpload = vi.fn()
const createEvent = vi.fn()
const createAudit = vi.fn()
const executeRaw = vi.fn()
const client = {
  intakeRun: { findFirst: findRun },
  intakeUpload: { findFirst: findUpload },
  intakeFileExtractionReceipt: { findUnique, findFirst: findPrior, create: createReceipt },
  intakeRunEvent: { create: createEvent },
  auditLog: { create: createAudit },
  $executeRaw: executeRaw,
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(client)),
}

const operationId = '568c2e1a-8ece-47ad-98dc-e4bde64872ca'
const generation = '1c246794-ecde-4666-a925-47de3c9f3e0b'
const sourceHash = 'a'.repeat(64)
const textHash = 'b'.repeat(64)
const createdAt = new Date('2026-08-29T03:30:00.000Z')

function input(overrides: Record<string, unknown> = {}) {
  return {
    operationId,
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    runId: 'run-a',
    uploadId: 'upload-a',
    requestHash: 'c'.repeat(64),
    outcome: 'SUCCEEDED',
    sourceObjectGeneration: generation,
    sourceStorageVersionId: 'version-a',
    sourceSha256: sourceHash,
    sourceByteSize: 18,
    sourceMimeType: 'text/plain',
    extractor: 'pathfinder-utf8-document',
    extractorVersion: '1',
    extractedText: 'Line one\nLine two',
    extractedTextHash: textHash,
    extractedCharacterCount: 17,
    extractedLineCount: 2,
    createdBy: 'admin-a',
    ...overrides,
  }
}

describe('intake file extraction receipt action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findUnique.mockResolvedValue(null)
    findPrior.mockResolvedValue(null)
    findRun.mockResolvedValue({
      id: 'run-a',
      evidence: [
        {
          sourceKind: 'FILE_UPLOAD',
          locator: 'intake-upload:upload-a',
          normalizedHash: sourceHash,
          confidence: 1,
        },
      ],
    })
    findUpload.mockResolvedValue({
      id: 'upload-a',
      objectGeneration: generation,
      storageVersionId: 'version-a',
      sha256: sourceHash,
      byteSize: 18,
      mimeType: 'text/plain',
      verificationReceipts: ['PRECHECK', 'RESOURCE_SAFETY', 'MALWARE'].map((kind) => ({
        kind,
        verdict: kind === 'MALWARE' ? 'CLEAN' : 'PASSED',
        objectGeneration: generation,
        storageVersionId: 'version-a',
        computedByteSize: 18,
        computedSha256: sourceHash,
      })),
    })
    createReceipt.mockResolvedValue({ id: operationId, outcome: 'SUCCEEDED', createdAt })
    createEvent.mockResolvedValue({ id: 'event-a' })
    createAudit.mockResolvedValue({ id: 'audit-a' })
    executeRaw.mockResolvedValue(1)
  })

  it('records exact terminal evidence, event, and audit with no downstream authority', async () => {
    const result = await recordIntakeFileExtractionReceiptAction(input() as never, client as never)

    expect(createReceipt).toHaveBeenCalledOnce()
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'FILE_EXTRACTION_RECORDED',
          metadata: expect.objectContaining({
            reviewRequired: true,
            packageDraftCreated: false,
            autoApproved: false,
            autoApplied: false,
            autoPublished: false,
          }),
        }),
      }),
    )
    expect(createAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'intake.file-extraction-recorded' }),
      }),
    )
    expect(result).toMatchObject({
      replayed: false,
      reviewRequired: true,
      packageDraftCreated: false,
      autoApproved: false,
      autoApplied: false,
      autoPublished: false,
    })
  })

  it('admits exact verified PDF terminal evidence through the PDF extractor only', async () => {
    findUpload.mockResolvedValueOnce({
      ...(await findUpload()),
      byteSize: 4_000_000,
      mimeType: 'application/pdf',
      verificationReceipts: ['PRECHECK', 'RESOURCE_SAFETY', 'MALWARE'].map((kind) => ({
        kind,
        verdict: kind === 'MALWARE' ? 'CLEAN' : 'PASSED',
        objectGeneration: generation,
        storageVersionId: 'version-a',
        computedByteSize: 4_000_000,
        computedSha256: sourceHash,
      })),
    })
    await recordIntakeFileExtractionReceiptAction(
      input({
        sourceByteSize: 4_000_000,
        sourceMimeType: 'application/pdf',
        extractor: 'pathfinder-pdfjs-document',
      }) as never,
      client as never,
    )

    expect(createReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceMimeType: 'application/pdf',
          extractor: 'pathfinder-pdfjs-document',
        }),
      }),
    )
  })

  it('rejects source and extractor mismatches before any transaction', async () => {
    await expect(
      recordIntakeFileExtractionReceiptAction(
        input({ sourceMimeType: 'application/pdf' }) as never,
        client as never,
      ),
    ).rejects.toThrow()
    await expect(
      recordIntakeFileExtractionReceiptAction(
        input({ sourceByteSize: 2_097_153 }) as never,
        client as never,
      ),
    ).rejects.toThrow()
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('derives failure detail from the bounded code and rejects unknown codes', async () => {
    createReceipt.mockResolvedValueOnce({ id: operationId, outcome: 'FAILED', createdAt })
    await recordIntakeFileExtractionReceiptAction(
      input({
        outcome: 'FAILED',
        extractedText: undefined,
        extractedTextHash: undefined,
        extractedCharacterCount: 0,
        extractedLineCount: 0,
        errorCode: 'INVALID_UTF8',
      }) as never,
      client as never,
    )

    expect(createReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: 'INVALID_UTF8',
          errorMessage: 'The verified document is not valid UTF-8 text.',
        }),
      }),
    )

    vi.clearAllMocks()
    await expect(
      recordIntakeFileExtractionReceiptAction(
        input({
          outcome: 'FAILED',
          extractedText: undefined,
          extractedTextHash: undefined,
          extractedCharacterCount: 0,
          extractedLineCount: 0,
          errorCode: 'SECRET_PROVIDER_FAILURE',
        }) as never,
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('replays only the exact operation identity and rejects conflicting reuse', async () => {
    findUnique.mockResolvedValue({
      id: operationId,
      requestId: operationId,
      createdAt,
      ...input(),
      errorCode: null,
      errorMessage: null,
    })
    await expect(
      recordIntakeFileExtractionReceiptAction(input() as never, client as never),
    ).resolves.toMatchObject({ replayed: true })
    expect(findRun).not.toHaveBeenCalled()

    await expect(
      recordIntakeFileExtractionReceiptAction(
        input({ requestHash: 'd'.repeat(64) }) as never,
        client as never,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<IntakeFileExtractionActionError>>({ code: 'CONFLICT' }),
    )
  })

  it('rejects any missing exact verification receipt before mutation', async () => {
    findUpload.mockResolvedValueOnce({
      ...(await findUpload()),
      verificationReceipts: [],
    })
    await expect(
      recordIntakeFileExtractionReceiptAction(input() as never, client as never),
    ).rejects.toEqual(
      expect.objectContaining<Partial<IntakeFileExtractionActionError>>({ code: 'CONFLICT' }),
    )
    expect(createReceipt).not.toHaveBeenCalled()
    expect(createEvent).not.toHaveBeenCalled()
    expect(createAudit).not.toHaveBeenCalled()
  })
})
