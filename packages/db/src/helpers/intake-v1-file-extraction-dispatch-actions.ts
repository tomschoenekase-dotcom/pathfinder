import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { db } from '../client'
import { intakeV1ManifestHash } from './intake-v1-manifest-hash'
import { IntakeV1ProcessingDispatchError } from './intake-v1-processing-dispatch-actions'

import {
  INTAKE_V1_FILE_EXTRACTION_POLICY_VERSION,
  isIntakeV1FileExtractionSupported,
} from './intake-v1-file-extraction-policy'
export {
  INTAKE_V1_FILE_EXTRACTION_POLICY_VERSION,
  isIntakeV1FileExtractionSupported,
} from './intake-v1-file-extraction-policy'
const LEASE_MS = 120_000
const MAX_ATTEMPTS = 3
type Client = Pick<typeof db, '$transaction' | '$queryRaw'>
type Transaction = Parameters<Parameters<typeof db.$transaction>[0]>[0]
const exactSchema = z
  .object({
    id: z.string().min(1).max(191),
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    operationId: z.string().uuid(),
    leaseToken: z.string().uuid(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
type Exact = z.infer<typeof exactSchema>
export type IntakeV1FileExtractionLease = Exact
export type LeasedIntakeV1FileExtractionDispatch = Exact & {
  revisionId: string
  memberId: string
  intakeRunId: string
  uploadId: string
  policyVersion: string
  attempts: number
}

async function loadLocked(tx: Transaction, id: string) {
  // Every lifecycle operation locks the immutable upload first, serializing revisions
  // of one source before taking their individual dispatch locks.
  await tx.$queryRaw`SELECT upload.id FROM intake_uploads upload
    JOIN intake_v1_submission_members member ON member.intake_upload_id=upload.id
      AND member.tenant_id=upload.tenant_id AND member.venue_id=upload.venue_id
    JOIN intake_v1_processing_dispatches dispatch ON dispatch.member_id=member.id
      AND dispatch.revision_id=member.revision_id AND dispatch.tenant_id=member.tenant_id AND dispatch.venue_id=member.venue_id
    WHERE dispatch.id=${id} FOR UPDATE OF upload`
  await tx.$queryRaw`SELECT id FROM intake_v1_processing_dispatches WHERE id=${id} FOR UPDATE`
  return tx.intakeV1ProcessingDispatch.findUnique({
    where: { id },
    include: {
      intakeRun: { select: { status: true, sourceKind: true } },
      member: {
        include: {
          intakeUpload: {
            include: {
              verificationReceipts: {
                where: { kind: 'MALWARE', verdict: 'CLEAN' },
                select: {
                  uploadId: true,
                  verdictHash: true,
                  computedSha256: true,
                  computedByteSize: true,
                  objectGeneration: true,
                  storageVersionId: true,
                },
              },
            },
          },
        },
      },
    },
  })
}
type Row = NonNullable<Awaited<ReturnType<typeof loadLocked>>>
async function databaseNow(tx: Transaction) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  if (!(rows[0]?.now instanceof Date))
    throw new IntakeV1ProcessingDispatchError('CONFLICT', 'Database clock unavailable.')
  return rows[0].now
}
function sourceValid(row: Row) {
  const upload = row.member.intakeUpload
  const receipt = upload?.verificationReceipts[0]
  return Boolean(
    row.kind === 'FILE_EXTRACTION' &&
    row.policyVersion === INTAKE_V1_FILE_EXTRACTION_POLICY_VERSION &&
    upload &&
    receipt &&
    row.intakeRun.sourceKind === 'FILE_UPLOAD' &&
    upload.intakeRunId === row.intakeRunId &&
    row.sourceHash === row.member.immutableHash &&
    isIntakeV1FileExtractionSupported(upload.mimeType, upload.byteSize) &&
    receipt.objectGeneration === upload.objectGeneration &&
    receipt.storageVersionId === upload.storageVersionId &&
    receipt.computedSha256 === upload.sha256 &&
    receipt.computedByteSize === upload.byteSize &&
    intakeV1ManifestHash({ id: upload.id, receipt }) === row.sourceHash,
  )
}
function leased(row: Row): LeasedIntakeV1FileExtractionDispatch {
  if (!row.leaseToken || !row.member.intakeUpload)
    throw new IntakeV1ProcessingDispatchError('CONFLICT', 'File dispatch lease unavailable.')
  return {
    id: row.id,
    tenantId: row.tenantId,
    venueId: row.venueId,
    operationId: row.operationId,
    leaseToken: row.leaseToken,
    sourceHash: row.sourceHash,
    revisionId: row.revisionId,
    memberId: row.memberId,
    intakeRunId: row.intakeRunId,
    uploadId: row.member.intakeUpload.id,
    policyVersion: row.policyVersion,
    attempts: row.attempts,
  }
}
function assertActive(row: Row | null, exact: Exact, now: Date): asserts row is Row {
  if (
    !row ||
    !sourceValid(row) ||
    row.tenantId !== exact.tenantId ||
    row.venueId !== exact.venueId ||
    row.operationId !== exact.operationId ||
    row.sourceHash !== exact.sourceHash ||
    row.leaseToken !== exact.leaseToken ||
    row.status !== 'LEASED' ||
    !row.leaseExpiresAt ||
    row.leaseExpiresAt <= now
  )
    throw new IntakeV1ProcessingDispatchError(
      'CONFLICT',
      'Exact file extraction lease is no longer active.',
    )
}
async function existingReceipt(tx: Transaction, row: Row, receiptId?: string) {
  const upload = row.member.intakeUpload!
  const receipt = await tx.intakeFileExtractionReceipt.findFirst({
    where: {
      ...(receiptId ? { id: receiptId } : {}),
      tenantId: row.tenantId,
      venueId: row.venueId,
      runId: row.intakeRunId,
      uploadId: upload.id,
      sourceObjectGeneration: upload.objectGeneration,
      sourceStorageVersionId: upload.storageVersionId!,
      sourceSha256: upload.sha256,
      sourceByteSize: upload.byteSize,
      sourceMimeType: upload.mimeType,
      extractor:
        upload.mimeType === 'application/pdf'
          ? 'pathfinder-pdfjs-document'
          : 'pathfinder-utf8-document',
      extractorVersion: '1',
    },
    select: {
      id: true,
      requestId: true,
      outcome: true,
      extractedText: true,
      extractedTextHash: true,
    },
  })
  if (
    receipt?.outcome === 'SUCCEEDED' &&
    (!receipt.extractedText ||
      createHash('sha256').update(receipt.extractedText).digest('hex') !==
        receipt.extractedTextHash)
  )
    throw new IntakeV1ProcessingDispatchError(
      'CONFLICT',
      'Retained file extraction text hash is inconsistent.',
    )
  return receipt
}
async function inherit(
  tx: Transaction,
  row: Row,
  receipt: NonNullable<Awaited<ReturnType<typeof existingReceipt>>>,
  now: Date,
) {
  const status = receipt.outcome === 'SUCCEEDED' ? ('COMPLETED' as const) : ('HELD' as const)
  await tx.intakeV1ProcessingDispatch.update({
    where: { id: row.id },
    data: {
      status,
      fileExtractionReceiptId: receipt.id,
      holdReason: status === 'HELD' ? 'FILE_EXTRACTION_FAILED' : null,
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: now,
      lastError: null,
    },
  })
  if (status === 'COMPLETED' && receipt.extractedTextHash) {
    await tx.intakeSourceAgentDispatch.upsert({
      where: { extractionDispatchId: row.id, tenantId: row.tenantId },
      create: {
        tenantId: row.tenantId,
        venueId: row.venueId,
        extractionDispatchId: row.id,
        intakeRunId: row.intakeRunId,
        receiptId: receipt.id,
        extractedTextHash: receipt.extractedTextHash,
      },
      update: {},
    })
  }
  return { status }
}

export async function listPendingIntakeV1FileExtractionDispatchIds(
  input: { limit?: number },
  client: Pick<typeof db, '$queryRaw'> = db,
) {
  const { limit } = z
    .object({ limit: z.number().int().min(1).max(100).default(25) })
    .strict()
    .parse(input)
  return client.$queryRaw<Array<{ id: string }>>`SELECT id FROM intake_v1_processing_dispatches
    WHERE kind='FILE_EXTRACTION' AND ((status='PENDING' AND attempts < ${MAX_ATTEMPTS})
      OR (status='LEASED' AND lease_expires_at <= clock_timestamp()))
    ORDER BY created_at,id LIMIT ${limit}`
}

export async function claimIntakeV1FileExtractionDispatch(
  input: { dispatchId: string; leaseOwner: string },
  client: Client = db,
) {
  const value = z
    .object({
      dispatchId: z.string().min(1).max(191),
      leaseOwner: z.string().trim().min(1).max(191),
    })
    .strict()
    .parse(input)
  return client.$transaction(async (tx) => {
    const row = await loadLocked(tx, value.dispatchId)
    const now = await databaseNow(tx)
    if (
      !row ||
      !sourceValid(row) ||
      !['PENDING', 'LEASED'].includes(row.status) ||
      (row.status === 'LEASED' && row.leaseExpiresAt && row.leaseExpiresAt > now)
    )
      return null
    const receipt = await existingReceipt(tx, row)
    if (receipt) {
      await inherit(tx, row, receipt, now)
      return null
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      await tx.intakeV1ProcessingDispatch.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          leaseToken: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          lastError: 'File extraction lease expired after the final attempt.',
        },
      })
      return null
    }
    if (
      row.intakeRun.status !== 'AWAITING_REVIEW' ||
      row.member.intakeUpload?.status !== 'AWAITING_REVIEW'
    ) {
      await tx.intakeV1ProcessingDispatch.update({
        where: { id: row.id },
        data: {
          status: 'HELD',
          holdReason: 'FILE_SOURCE_NOT_REVIEWABLE',
          leaseToken: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      })
      return null
    }
    const active = await tx.intakeV1ProcessingDispatch.findFirst({
      where: {
        id: { not: row.id },
        tenantId: row.tenantId,
        venueId: row.venueId,
        intakeRunId: row.intakeRunId,
        kind: 'FILE_EXTRACTION',
        status: 'LEASED',
        leaseExpiresAt: { gt: now },
      },
      select: { id: true },
    })
    if (active) return null
    const updated = await tx.intakeV1ProcessingDispatch.update({
      where: { id: row.id },
      data: {
        status: 'LEASED',
        attempts: { increment: 1 },
        leaseToken: randomUUID(),
        leaseOwner: value.leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        lastError: null,
      },
    })
    return leased({ ...row, ...updated })
  })
}

export async function preflightIntakeV1FileExtractionDispatch(
  input: Exact & { policyVersion: string },
  client: Client = db,
) {
  const { policyVersion, ...exact } = exactSchema
    .extend({ policyVersion: z.literal(INTAKE_V1_FILE_EXTRACTION_POLICY_VERSION) })
    .parse(input)
  void policyVersion
  return client.$transaction(async (tx) => {
    const row = await loadLocked(tx, exact.id)
    const now = await databaseNow(tx)
    assertActive(row, exact, now)
    const receipt = await existingReceipt(tx, row)
    if (receipt)
      return { state: 'INHERITED' as const, dispatch: await inherit(tx, row, receipt, now) }
    if (
      row.intakeRun.status !== 'AWAITING_REVIEW' ||
      row.member.intakeUpload?.status !== 'AWAITING_REVIEW'
    )
      throw new IntakeV1ProcessingDispatchError('CONFLICT', 'File source is no longer reviewable.')
    return { state: 'EXECUTE' as const, dispatch: leased(row) }
  })
}
export async function completeIntakeV1FileExtractionDispatch(
  input: Exact & { receiptId: string },
  client: Client = db,
) {
  const { receiptId, ...exact } = exactSchema.extend({ receiptId: z.string().uuid() }).parse(input)
  return client.$transaction(async (tx) => {
    const row = await loadLocked(tx, exact.id)
    const now = await databaseNow(tx)
    assertActive(row, exact, now)
    const receipt = await existingReceipt(tx, row, receiptId)
    if (!receipt || receipt.requestId !== row.operationId)
      throw new IntakeV1ProcessingDispatchError('CONFLICT', 'Exact extraction receipt unavailable.')
    return inherit(tx, row, receipt, now)
  })
}
export async function failIntakeV1FileExtractionDispatch(
  input: Exact & { error: string },
  client: Client = db,
) {
  const { error, ...exact } = exactSchema.extend({ error: z.string().min(1).max(500) }).parse(input)
  void error
  return client.$transaction(async (tx) => {
    const row = await loadLocked(tx, exact.id)
    const now = await databaseNow(tx)
    assertActive(row, exact, now)
    // A storage/parser call can commit its receipt and then lose its response.
    // Recover while holding the same upload lock, including on the final attempt.
    const receipt = await existingReceipt(tx, row)
    if (receipt) return inherit(tx, row, receipt, now)
    const status = row.attempts >= MAX_ATTEMPTS ? ('FAILED' as const) : ('PENDING' as const)
    await tx.intakeV1ProcessingDispatch.update({
      where: { id: row.id },
      data: {
        status,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: status === 'FAILED' ? now : null,
        lastError: 'File extraction ended with an uncertain canonical receipt outcome.',
      },
    })
    return { status }
  })
}

/** Fences a new extraction receipt inside its canonical write transaction. */
export async function assertIntakeV1FileExtractionReceiptLeaseInTransaction(
  tx: Transaction,
  input: Exact & { intakeRunId: string; uploadId: string },
): Promise<void> {
  const { intakeRunId, uploadId, ...exact } = exactSchema
    .extend({
      intakeRunId: z.string().min(1).max(191),
      uploadId: z.string().min(1).max(191),
    })
    .parse(input)
  const row = await loadLocked(tx, exact.id)
  const now = await databaseNow(tx)
  assertActive(row, exact, now)
  if (
    row.intakeRunId !== intakeRunId ||
    row.member.intakeUpload?.id !== uploadId ||
    row.intakeRun.status !== 'AWAITING_REVIEW'
  )
    throw new IntakeV1ProcessingDispatchError(
      'CONFLICT',
      'Exact file receipt lease source is unavailable.',
    )
}
