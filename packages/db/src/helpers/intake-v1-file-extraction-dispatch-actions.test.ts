import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { intakeV1ManifestHash } from './intake-v1-submission-actions'
import {
  INTAKE_V1_FILE_EXTRACTION_POLICY_VERSION,
  assertIntakeV1FileExtractionReceiptLeaseInTransaction,
  claimIntakeV1FileExtractionDispatch,
  completeIntakeV1FileExtractionDispatch,
  failIntakeV1FileExtractionDispatch,
  preflightIntakeV1FileExtractionDispatch,
} from './intake-v1-file-extraction-dispatch-actions'

const now = new Date('2026-09-08T12:00:00.000Z')
const operationId = '1eb69bbd-9d96-4742-b55a-3e82fa4891a8'
const leaseToken = '01ba25e5-f5bf-48bc-ad04-a91247732e58'
const receiptId = 'aa3acfe7-edb6-49dd-a684-87af0a214df5'

function fixture(overrides: Record<string, unknown> = {}) {
  const upload = {
    id: 'upload-a',
    intakeRunId: 'run-a',
    status: 'AWAITING_REVIEW',
    mimeType: 'application/pdf',
    byteSize: 1024,
    sha256: 'b'.repeat(64),
    objectGeneration: 'generation-a',
    storageVersionId: 'version-a',
  }
  const clean = {
    uploadId: upload.id,
    verdictHash: 'c'.repeat(64),
    computedSha256: upload.sha256,
    computedByteSize: upload.byteSize,
    objectGeneration: upload.objectGeneration,
    storageVersionId: upload.storageVersionId,
  }
  const sourceHash = intakeV1ManifestHash({ id: upload.id, receipt: clean })
  return {
    id: 'dispatch-a',
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    revisionId: 'revision-a',
    memberId: 'member-a',
    intakeRunId: 'run-a',
    kind: 'FILE_EXTRACTION',
    policyVersion: INTAKE_V1_FILE_EXTRACTION_POLICY_VERSION,
    operationId,
    sourceHash,
    status: 'PENDING',
    attempts: 0,
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    intakeRun: { status: 'AWAITING_REVIEW', sourceKind: 'FILE_UPLOAD' },
    member: {
      immutableHash: sourceHash,
      intakeUpload: { ...upload, verificationReceipts: [clean] },
    },
    ...overrides,
  }
}

function client(row: ReturnType<typeof fixture>, receipt: unknown = null) {
  const update = vi
    .fn()
    .mockImplementation(({ data }) =>
      Promise.resolve({ ...row, ...data, attempts: row.attempts + (data.attempts ? 1 : 0) }),
    )
  const tx = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ now }]),
    intakeV1ProcessingDispatch: {
      findUnique: vi.fn().mockResolvedValue(row),
      findFirst: vi.fn().mockResolvedValue(null),
      update,
    },
    intakeSourceAgentDispatch: { upsert: vi.fn() },
    intakeFileExtractionReceipt: { findFirst: vi.fn().mockResolvedValue(receipt) },
  }
  return {
    value: { $transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx) },
    tx,
    update,
  }
}

function exact(row: ReturnType<typeof fixture>) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    venueId: row.venueId,
    operationId: row.operationId,
    leaseToken,
    sourceHash: row.sourceHash,
  }
}

describe('V1 file extraction dispatch lifecycle', () => {
  it('claims only the canonical clean upload source and preserves its identity', async () => {
    const row = fixture()
    const { value, update } = client(row)
    const claimed = await claimIntakeV1FileExtractionDispatch(
      { dispatchId: row.id, leaseOwner: 'worker-a' },
      value as never,
    )
    expect(claimed).toMatchObject({
      id: row.id,
      uploadId: 'upload-a',
      operationId,
      sourceHash: row.sourceHash,
      policyVersion: INTAKE_V1_FILE_EXTRACTION_POLICY_VERSION,
      attempts: 1,
    })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'LEASED' }) }),
    )
  })

  it.each([
    ['changed member hash', { member: { ...fixture().member, immutableHash: 'd'.repeat(64) } }],
    [
      'moved upload',
      {
        member: {
          ...fixture().member,
          intakeUpload: { ...fixture().member.intakeUpload!, intakeRunId: 'run-b' },
        },
      },
    ],
    [
      'changed object version',
      {
        member: {
          ...fixture().member,
          intakeUpload: { ...fixture().member.intakeUpload!, storageVersionId: 'version-b' },
        },
      },
    ],
    ['unsupported profile', { policyVersion: 'future-policy' }],
  ])('refuses a claim for %s', async (_label, overrides) => {
    const row = fixture(overrides)
    const { value, update } = client(row)
    await expect(
      claimIntakeV1FileExtractionDispatch(
        { dispatchId: row.id, leaseOwner: 'worker-a' },
        value as never,
      ),
    ).resolves.toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('inherits an exact source receipt from a prior operation without issuing a lease', async () => {
    const row = fixture()
    const text = 'Retained canonical text'
    const receipt = {
      id: receiptId,
      requestId: '36483c9c-337b-4563-ae8b-6ed55d8113f8',
      outcome: 'SUCCEEDED',
      extractedText: text,
      extractedTextHash: createHash('sha256').update(text).digest('hex'),
    }
    const { value, update, tx } = client(row, receipt)
    await expect(
      claimIntakeV1FileExtractionDispatch(
        { dispatchId: row.id, leaseOwner: 'worker-a' },
        value as never,
      ),
    ).resolves.toBeNull()
    expect(tx.intakeSourceAgentDispatch.upsert).toHaveBeenCalledWith({
      where: { extractionDispatchId: row.id, tenantId: row.tenantId },
      create: {
        tenantId: row.tenantId,
        venueId: row.venueId,
        extractionDispatchId: row.id,
        intakeRunId: row.intakeRunId,
        receiptId,
        extractedTextHash: receipt.extractedTextHash,
      },
      update: {},
    })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETED', fileExtractionReceiptId: receiptId }),
      }),
    )
  })

  it('preflight inherits a replay receipt and rejects a forged retained text hash', async () => {
    const leased = fixture({
      status: 'LEASED',
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + 1000),
    })
    const receipt = {
      id: receiptId,
      requestId: operationId,
      outcome: 'SUCCEEDED',
      extractedText: 'actual text',
      extractedTextHash: 'f'.repeat(64),
    }
    const bad = client(leased, receipt)
    await expect(
      preflightIntakeV1FileExtractionDispatch(
        { ...exact(leased), policyVersion: INTAKE_V1_FILE_EXTRACTION_POLICY_VERSION },
        bad.value as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(bad.update).not.toHaveBeenCalled()
  })

  it('completes only from the exact active lease and operation receipt', async () => {
    const leased = fixture({
      status: 'LEASED',
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + 1000),
    })
    const receipt = {
      id: receiptId,
      requestId: operationId,
      outcome: 'FAILED',
      extractedText: null,
      extractedTextHash: null,
    }
    const good = client(leased, receipt)
    await expect(
      completeIntakeV1FileExtractionDispatch({ ...exact(leased), receiptId }, good.value as never),
    ).resolves.toEqual({ status: 'HELD' })
    expect(good.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'HELD', holdReason: 'FILE_EXTRACTION_FAILED' }),
      }),
    )

    for (const changed of [
      { tenantId: 'tenant-b' },
      { leaseToken: 'b72a61c6-9a50-48d9-93cb-4a7645b07571' },
      { sourceHash: 'e'.repeat(64) },
    ]) {
      const attempt = client(leased, receipt)
      await expect(
        completeIntakeV1FileExtractionDispatch(
          { ...exact(leased), ...changed, receiptId },
          attempt.value as never,
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(attempt.update).not.toHaveBeenCalled()
    }
  })

  it('rejects expired preflight and requeues failures until exact attempt exhaustion', async () => {
    const expired = fixture({ status: 'LEASED', attempts: 1, leaseToken, leaseExpiresAt: now })
    await expect(
      preflightIntakeV1FileExtractionDispatch(
        { ...exact(expired), policyVersion: INTAKE_V1_FILE_EXTRACTION_POLICY_VERSION },
        client(expired).value as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    for (const [attempts, status] of [
      [1, 'PENDING'],
      [3, 'FAILED'],
    ] as const) {
      const row = fixture({
        status: 'LEASED',
        attempts,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + 1000),
      })
      const harness = client(row)
      await expect(
        failIntakeV1FileExtractionDispatch(
          { ...exact(row), error: 'worker uncertainty' },
          harness.value as never,
        ),
      ).resolves.toEqual({ status })
      expect(harness.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status }) }),
      )
    }
  })

  it('holds a review-moved source instead of leasing it', async () => {
    const row = fixture({ intakeRun: { status: 'COMPLETED', sourceKind: 'FILE_UPLOAD' } })
    const { value, update } = client(row)
    await expect(
      claimIntakeV1FileExtractionDispatch(
        { dispatchId: row.id, leaseOwner: 'worker-a' },
        value as never,
      ),
    ).resolves.toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'HELD', holdReason: 'FILE_SOURCE_NOT_REVIEWABLE' }),
      }),
    )
  })

  it.each([
    ['expired lease', { leaseExpiresAt: now }, {}],
    ['mismatched source', {}, { sourceHash: 'e'.repeat(64) }],
  ])('rejects receipt authorization for a %s', async (_label, rowChanges, exactChanges) => {
    const row = fixture({
      status: 'LEASED',
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + 1000),
      ...rowChanges,
    })
    const harness = client(row)
    await expect(
      assertIntakeV1FileExtractionReceiptLeaseInTransaction(harness.tx as never, {
        ...exact(row),
        ...exactChanges,
        intakeRunId: row.intakeRunId,
        uploadId: row.member.intakeUpload!.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(harness.update).not.toHaveBeenCalled()
  })

  it('authorizes the exact active lease and upload lineage', async () => {
    const row = fixture({
      status: 'LEASED',
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + 1000),
    })
    const harness = client(row)
    await expect(
      assertIntakeV1FileExtractionReceiptLeaseInTransaction(harness.tx as never, {
        ...exact(row),
        intakeRunId: row.intakeRunId,
        uploadId: row.member.intakeUpload!.id,
      }),
    ).resolves.toBeUndefined()
  })
})

it.each(['SUCCEEDED', 'FAILED'] as const)(
  'recovers a committed %s receipt before exhausting the final attempt',
  async (outcome) => {
    const row = fixture({
      status: 'LEASED',
      attempts: 3,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + 1000),
    })
    const text = 'Retained reviewed source'
    const receipt = {
      id: receiptId,
      requestId: operationId,
      outcome,
      extractedText: outcome === 'SUCCEEDED' ? text : null,
      extractedTextHash:
        outcome === 'SUCCEEDED' ? createHash('sha256').update(text).digest('hex') : null,
    }
    const harness = client(row, receipt)
    const status = outcome === 'SUCCEEDED' ? 'COMPLETED' : 'HELD'
    await expect(
      failIntakeV1FileExtractionDispatch(
        { ...exact(row), error: 'Response lost after receipt commit' },
        harness.value as never,
      ),
    ).resolves.toEqual({ status })
    expect(harness.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status,
          fileExtractionReceiptId: receiptId,
          lastError: null,
        }),
      }),
    )
  },
)
