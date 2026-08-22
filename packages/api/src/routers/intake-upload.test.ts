import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  renew: vi.fn(),
  reject: vi.fn(),
  finalize: vi.fn(),
  settleAuthoritative: vi.fn(),
  scanner: null as null | { engine: string; engineVersion: string; scan: ReturnType<typeof vi.fn> },
  rejectPrecheck: vi.fn(),
  list: vi.fn(),
  sign: vi.fn(),
  inspect: vi.fn(),
  remove: vi.fn(),
  read: vi.fn(),
  verifyBytes: vi.fn(),
  bindMultipart: vi.fn(),
  getMultipart: vi.fn(),
  completeMultipartAction: vi.fn(),
  cancelMultipartAction: vi.fn(),
  beginMultipart: vi.fn(),
  listMultipart: vi.fn(),
  signMultipart: vi.fn(),
  completeMultipartStorage: vi.fn(),
  abortMultipart: vi.fn(),
}))

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  reserveIntakeUploadAction: mocks.reserve,
  claimIntakeUploadVerificationAction: mocks.claim,
  releaseIntakeUploadVerificationAction: mocks.release,
  renewIntakeUploadVerificationLeaseAction: mocks.renew,
  rejectIntakeUploadAction: mocks.reject,
  recordIntakeUploadPrecheckAction: mocks.finalize,
  settleIntakeUploadAuthoritativeVerificationAction: mocks.settleAuthoritative,
  recordRejectedIntakeUploadPrecheckAction: mocks.rejectPrecheck,
  listIntakeUploadsAction: mocks.list,
  bindIntakeUploadMultipartAction: mocks.bindMultipart,
  getIntakeUploadMultipartAction: mocks.getMultipart,
  completeIntakeUploadMultipartAction: mocks.completeMultipartAction,
  cancelIntakeUploadMultipartAction: mocks.cancelMultipartAction,
}))

vi.mock('../lib/intake-upload-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/intake-upload-storage')>()),
  signIntakeUploadPut: mocks.sign,
  inspectIntakeUpload: mocks.inspect,
  deleteInvalidIntakeUploadVersion: mocks.remove,
  readIntakeUploadVersion: mocks.read,
  beginIntakeUploadMultipart: mocks.beginMultipart,
  listIntakeUploadMultipartParts: mocks.listMultipart,
  signIntakeUploadPart: mocks.signMultipart,
  completeIntakeUploadMultipart: mocks.completeMultipartStorage,
  abortIntakeUploadMultipart: mocks.abortMultipart,
  createIntakeUploadObjectKey: () =>
    'staging/intake-quarantine/44444444-4444-4444-8444-444444444444',
}))

vi.mock('../lib/intake-upload-byte-verifier', () => ({
  verifyIntakeUploadBytes: mocks.verifyBytes,
  configuredIntakeUploadMalwareScanner: () => mocks.scanner,
}))

import type { TRPCContext } from '../context'
import { IntakeUploadActionError } from '@pathfinder/db'
import { router } from '../core'
import { intakeUploadRouter } from './intake-upload'

const checksum = 'ab'.repeat(32)
const requestId = '11111111-1111-4111-8111-111111111111'
const claimId = '22222222-2222-4222-8222-222222222222'
const now = new Date('2026-08-11T12:00:00.000Z')
const upload = {
  id: 'upload-1',
  status: 'RESERVED',
  displayName: 'Visitor guide',
  fileName: 'guide.pdf',
  mimeType: 'application/pdf',
  byteSize: 123,
  rejectionCode: null,
  intakeRunId: null,
  createdAt: now,
  updatedAt: now,
}
const uploadTarget = {
  objectKey: 'intake-quarantine/opaque/opaque',
  objectGeneration: '33333333-3333-4333-8333-333333333333',
  mimeType: 'application/pdf',
  byteSize: 123,
  sha256: checksum,
}

function context(overrides: Partial<TRPCContext['session']> = {}): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'user-1',
      activeTenantId: 'tenant-a',
      role: 'MANAGER',
      isPlatformAdmin: false,
      ...overrides,
    } as TRPCContext['session'],
  }
}

const caller = router({ intakeUpload: intakeUploadRouter })
const reserveInput = {
  venueId: 'venue-a',
  requestId,
  displayName: 'Visitor guide',
  fileName: 'guide.pdf',
  mimeType: 'application/pdf' as const,
  category: 'DOCUMENT' as const,
  byteSize: 123,
  sha256: checksum,
}

describe('client-safe quarantined intake upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.scanner = null
    mocks.beginMultipart.mockResolvedValue({ uploadId: 'multipart-1', partSize: 16 * 1024 * 1024 })
    mocks.listMultipart.mockResolvedValue([])
    mocks.abortMultipart.mockResolvedValue(undefined)
    mocks.reserve.mockResolvedValue({
      upload,
      uploadTarget,
      replayed: false,
      nextAction: 'UPLOAD_BYTES',
    })
    mocks.claim.mockResolvedValue({
      state: 'VERIFYING',
      upload: { ...upload, status: 'VERIFYING' },
      uploadTarget,
      replayed: false,
    })
    mocks.release.mockResolvedValue({
      upload: { ...upload, status: 'VERIFYING' },
      uploadTarget,
      retryable: true,
    })
    mocks.renew.mockResolvedValue({ leaseUntil: new Date(Date.now() + 600_000) })
    mocks.reject.mockResolvedValue({ upload: { ...upload, status: 'REJECTED' }, retryable: false })
    mocks.rejectPrecheck.mockResolvedValue({
      upload: { ...upload, status: 'REJECTED' },
      retryable: false,
    })
    mocks.finalize.mockResolvedValue({
      upload: { ...upload, status: 'AWAITING_REVIEW', intakeRunId: 'run-1' },
      nextAction: 'PATHFINDER_REVIEW',
      autoApprove: false,
      autoApply: false,
      published: false,
    })
    mocks.settleAuthoritative.mockResolvedValue({
      upload: { ...upload, status: 'AWAITING_REVIEW', intakeRunId: 'run-1' },
      nextAction: 'PATHFINDER_REVIEW',
      replayed: false,
    })
    mocks.list.mockResolvedValue({ items: [], nextCursor: null })
    mocks.sign.mockResolvedValue({
      url: 'https://signed.invalid/opaque',
      expiresInSeconds: 900,
      requiredHeaders: { 'if-none-match': '*' },
    })
    mocks.inspect.mockResolvedValue({ state: 'verified', versionId: 'version-1' })
    mocks.read.mockResolvedValue(
      (async function* () {
        yield new Uint8Array([1])
      })(),
    )
    mocks.verifyBytes.mockResolvedValue({
      passed: true,
      reason: 'PASSED',
      engine: 'pathfinder-magic-bytes',
      engineVersion: '1',
      verdictHash: 'd'.repeat(64),
      computedByteSize: uploadTarget.byteSize,
      computedSha256: uploadTarget.sha256,
    })
  })

  it('returns resumable completed-part state for a large media reservation', async () => {
    const bytes = 33 * 1024 * 1024
    mocks.reserve.mockResolvedValueOnce({
      upload: { ...upload, mimeType: 'video/mp4', byteSize: bytes },
      uploadTarget: {
        ...uploadTarget,
        mimeType: 'video/mp4',
        byteSize: bytes,
        multipartUploadId: null,
      },
      replayed: false,
      nextAction: 'UPLOAD_BYTES',
    })
    mocks.bindMultipart.mockResolvedValueOnce({
      upload: {
        multipartUploadId: 'multipart-1',
        multipartStartedAt: now,
      },
      replayed: false,
    })
    const result = await caller.createCaller(context()).intakeUpload.reserve({
      ...reserveInput,
      fileName: 'tour.mp4',
      displayName: 'Tour',
      mimeType: 'video/mp4',
      category: 'VIDEO_AUDIO',
      byteSize: bytes,
    })
    expect(result.uploadRequest).toEqual({
      kind: 'multipart',
      partSize: 16 * 1024 * 1024,
      partCount: 3,
      completedParts: [],
    })
    expect(mocks.beginMultipart).toHaveBeenCalledOnce()
    expect(mocks.sign).not.toHaveBeenCalled()
  })

  it('signs only an in-range part for the exact active multipart upload', async () => {
    mocks.getMultipart.mockResolvedValueOnce({
      upload,
      target: {
        ...uploadTarget,
        multipartUploadId: 'multipart-1',
        byteSize: 33 * 1024 * 1024,
        multipartCompletedAt: null,
      },
    })
    mocks.signMultipart.mockResolvedValueOnce({
      url: 'https://signed.invalid/part-3',
      expiresInSeconds: 900,
      requiredHeaders: { 'x-amz-checksum-sha256': checksum },
    })
    await expect(
      caller.createCaller(context()).intakeUpload.signMultipartPart({
        venueId: 'venue-a',
        uploadId: 'upload-1',
        partNumber: 3,
        checksumSha256: checksum,
      }),
    ).resolves.toMatchObject({ url: 'https://signed.invalid/part-3' })
    expect(mocks.signMultipart).toHaveBeenCalledWith({
      key: uploadTarget.objectKey,
      uploadId: 'multipart-1',
      partNumber: 3,
      checksumSha256: checksum,
    })
  })

  it('completes exact storage parts before recording durable multipart completion', async () => {
    const bytes = 33 * 1024 * 1024
    const parts = [1, 2, 3].map((partNumber) => ({
      partNumber,
      etag: `etag-${partNumber}`,
      checksumSha256: checksum,
      size: partNumber === 3 ? 1024 * 1024 : 16 * 1024 * 1024,
    }))
    mocks.getMultipart.mockResolvedValueOnce({
      upload,
      target: {
        ...uploadTarget,
        byteSize: bytes,
        multipartUploadId: 'multipart-1',
        multipartCompletedAt: null,
      },
    })
    mocks.listMultipart.mockResolvedValueOnce(parts)
    mocks.completeMultipartStorage.mockResolvedValueOnce(undefined)
    mocks.completeMultipartAction.mockResolvedValueOnce({
      upload: { ...upload, multipartCompletedAt: now },
      replayed: false,
    })
    await expect(
      caller
        .createCaller(context())
        .intakeUpload.completeMultipart({ venueId: 'venue-a', uploadId: 'upload-1' }),
    ).resolves.toMatchObject({ replayed: false, nextAction: 'VERIFY' })
    expect(mocks.completeMultipartStorage).toHaveBeenCalledWith({
      key: uploadTarget.objectKey,
      uploadId: 'multipart-1',
      parts,
    })
    expect(mocks.completeMultipartAction).toHaveBeenCalledOnce()
  })

  it('replays a response-lost multipart cancellation without another storage abort', async () => {
    mocks.getMultipart.mockResolvedValueOnce({
      upload: {
        ...upload,
        status: 'REJECTED',
        rejectionCode: 'CLIENT_CANCELLED',
        multipartAbortedAt: now,
      },
      target: {
        ...uploadTarget,
        multipartUploadId: 'multipart-1',
        multipartCompletedAt: null,
        multipartAbortedAt: now,
      },
    })
    mocks.cancelMultipartAction.mockResolvedValueOnce({
      upload: { ...upload, status: 'REJECTED', rejectionCode: 'CLIENT_CANCELLED' },
      replayed: true,
    })
    await expect(
      caller
        .createCaller(context())
        .intakeUpload.cancelMultipart({ venueId: 'venue-a', uploadId: 'upload-1' }),
    ).resolves.toMatchObject({ replayed: true })
    expect(mocks.getMultipart).toHaveBeenCalledWith(
      expect.objectContaining({ allowCancelled: true }),
    )
    expect(mocks.abortMultipart).not.toHaveBeenCalled()
    expect(mocks.cancelMultipartAction).toHaveBeenCalledWith(
      expect.objectContaining({ multipartUploadId: 'multipart-1' }),
    )
  })

  it('authenticates before reservation or storage access', async () => {
    await expect(
      caller
        .createCaller(context({ userId: null, activeTenantId: null, role: null }))
        .intakeUpload.reserve(reserveInput),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(mocks.reserve).not.toHaveBeenCalled()
    expect(mocks.sign).not.toHaveBeenCalled()
  })

  it('derives tenant and actor from the session, reserves before signing, and hides storage identity', async () => {
    const order: string[] = []
    mocks.reserve.mockImplementation(async () => {
      order.push('reserve')
      return { upload, uploadTarget, replayed: false, nextAction: 'UPLOAD_BYTES' }
    })
    mocks.sign.mockImplementation(async () => {
      order.push('sign')
      return { url: 'https://signed.invalid/opaque', expiresInSeconds: 900, requiredHeaders: {} }
    })
    const result = await caller.createCaller(context()).intakeUpload.reserve(reserveInput)
    expect(order).toEqual(['reserve', 'sign'])
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        actor: { type: 'HUMAN', id: 'user-1', role: 'MANAGER' },
        trustedObjectIdentity: {
          objectKey: 'staging/intake-quarantine/44444444-4444-4444-8444-444444444444',
          objectGeneration: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        },
      }),
    )
    expect(mocks.sign).toHaveBeenCalledWith({
      key: uploadTarget.objectKey,
      generation: uploadTarget.objectGeneration,
      contentType: uploadTarget.mimeType,
      bytes: uploadTarget.byteSize,
      checksumSha256: uploadTarget.sha256,
    })
    expect(JSON.stringify(result)).not.toContain(uploadTarget.objectKey)
    expect(JSON.stringify(result)).not.toContain(uploadTarget.objectGeneration)
    expect(JSON.stringify(result)).not.toContain(checksum)
  })

  it('does not mint another URL after a reservation reaches review status', async () => {
    mocks.reserve.mockResolvedValue({
      upload: { ...upload, status: 'AWAITING_REVIEW' },
      uploadTarget,
      replayed: true,
      nextAction: 'REVIEW_STATUS',
    })
    const result = await caller.createCaller(context()).intakeUpload.reserve(reserveInput)
    expect(result.uploadRequest).toBeNull()
    expect(mocks.sign).not.toHaveBeenCalled()
  })

  it('claims VERIFYING before HEAD and finalizes only through the neutral action', async () => {
    const order: string[] = []
    mocks.claim.mockImplementation(async () => {
      order.push('claim')
      return { state: 'VERIFYING', upload, uploadTarget, replayed: false }
    })
    mocks.inspect.mockImplementation(async () => {
      order.push('head')
      return { state: 'verified', versionId: 'v1' }
    })
    mocks.finalize.mockImplementation(async () => {
      order.push('finalize')
      return {
        upload: { ...upload, status: 'PRECHECK_PASSED' },
        nextAction: 'MALWARE_SCAN_PENDING',
      }
    })
    const result = await caller
      .createCaller(context())
      .intakeUpload.verify({ venueId: 'venue-a', uploadId: 'upload-1', claimId })
    expect(order).toEqual(['claim', 'head', 'finalize'])
    expect(mocks.inspect).toHaveBeenCalledWith({
      key: uploadTarget.objectKey,
      generation: uploadTarget.objectGeneration,
      contentType: uploadTarget.mimeType,
      bytes: uploadTarget.byteSize,
      checksumSha256: uploadTarget.sha256,
      signal: expect.any(AbortSignal),
    })
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        verified: expect.objectContaining({ storageVersionId: 'v1' }),
      }),
    )
    expect(result).toMatchObject({
      nextAction: 'MALWARE_SCAN_PENDING',
      processingState: 'MALWARE_SCAN_PENDING',
      autoApprove: false,
      autoApply: false,
      published: false,
    })
  })

  it('reconciles a terminal response replay without touching storage again', async () => {
    mocks.claim.mockResolvedValue({
      state: 'AWAITING_REVIEW',
      upload: { ...upload, status: 'AWAITING_REVIEW', intakeRunId: 'run-1' },
      replayed: true,
    })
    const result = await caller
      .createCaller(context())
      .intakeUpload.verify({ venueId: 'venue-a', uploadId: 'upload-1', claimId })
    expect(result).toMatchObject({ nextAction: 'PATHFINDER_REVIEW', published: false })
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('runs configured authoritative scanning and settles a prechecked upload', async () => {
    const scan = vi.fn().mockResolvedValue({
      verdict: 'CLEAN',
      verdictHash: 'e'.repeat(64),
      computedByteSize: uploadTarget.byteSize,
      computedSha256: uploadTarget.sha256,
    })
    mocks.scanner = { engine: 'clamav-clamd', engineVersion: 'daemon', scan }
    mocks.claim.mockResolvedValue({
      state: 'PRECHECK_PASSED',
      upload: { ...upload, status: 'PRECHECK_PASSED' },
      uploadTarget: { ...uploadTarget, storageVersionId: 'v1' },
      replayed: true,
    })
    const storedBytes = (async function* () {
      yield new Uint8Array([1, 2, 3])
    })()
    mocks.read.mockResolvedValue(storedBytes)

    const result = await caller
      .createCaller(context())
      .intakeUpload.verify({ venueId: 'venue-a', uploadId: 'upload-1', claimId })

    expect(mocks.read).toHaveBeenCalledWith({
      key: uploadTarget.objectKey,
      versionId: 'v1',
    })
    expect(scan).toHaveBeenCalledWith({
      bytes: storedBytes,
      expectedBytes: uploadTarget.byteSize,
      expectedSha256: uploadTarget.sha256,
    })
    expect(mocks.settleAuthoritative).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        malware: expect.objectContaining({ verdict: 'CLEAN', engine: 'clamav-clamd' }),
      }),
    )
    expect(result).toMatchObject({
      nextAction: 'PATHFINDER_REVIEW',
      processingState: 'READY_FOR_REVIEW',
      published: false,
    })
  })

  it('leaves an unavailable verification claimed and retryable', async () => {
    mocks.inspect.mockRejectedValue(new Error('private storage detail'))
    await expect(
      caller
        .createCaller(context())
        .intakeUpload.verify({ venueId: 'venue-a', uploadId: 'upload-1', claimId }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(mocks.release).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        uploadId: 'upload-1',
        claimId,
        reasonCode: 'TRANSPORT_UNAVAILABLE',
      }),
    )
    expect(mocks.reject).not.toHaveBeenCalled()
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('aborts on lease ownership loss without releasing the replacement claim', async () => {
    mocks.renew.mockRejectedValueOnce(new IntakeUploadActionError('CONFLICT', 'claim lost'))
    await expect(
      caller
        .createCaller(context())
        .intakeUpload.verify({ venueId: 'venue-a', uploadId: 'upload-1', claimId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.release).not.toHaveBeenCalled()
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('persists rejected precheck evidence with a coarse reason', async () => {
    mocks.verifyBytes.mockResolvedValueOnce({
      passed: false,
      reason: 'HASH_MISMATCH',
      engine: 'pathfinder-magic-bytes',
      engineVersion: '1',
      verdictHash: 'e'.repeat(64),
      computedByteSize: 123,
      computedSha256: 'f'.repeat(64),
    })
    const result = await caller
      .createCaller(context())
      .intakeUpload.verify({ venueId: 'venue-a', uploadId: 'upload-1', claimId })
    expect(mocks.rejectPrecheck).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'HASH_MISMATCH',
        evidence: expect.objectContaining({ computedSha256: 'f'.repeat(64) }),
      }),
    )
    expect(result).toMatchObject({ retryable: false, nextAction: 'RESELECT_FILE' })
  })

  it('deletes only the HEAD-confirmed immutable invalid version before rejection', async () => {
    mocks.inspect.mockResolvedValue({
      state: 'invalid',
      versionId: 'immutable-v1',
      reason: 'checksum',
    })
    const result = await caller
      .createCaller(context())
      .intakeUpload.verify({ venueId: 'venue-a', uploadId: 'upload-1', claimId })
    expect(mocks.remove).toHaveBeenCalledWith({
      key: uploadTarget.objectKey,
      versionId: 'immutable-v1',
      signal: expect.any(AbortSignal),
    })
    expect(mocks.reject).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'HASH_MISMATCH' }),
    )
    expect(result).toMatchObject({ retryable: false, nextAction: 'RESELECT_FILE' })
  })

  it('does not delete or reject when immutable version identity is unavailable', async () => {
    mocks.inspect.mockResolvedValue({ state: 'invalid', versionId: null, reason: 'version' })
    await expect(
      caller
        .createCaller(context())
        .intakeUpload.verify({ venueId: 'venue-a', uploadId: 'upload-1', claimId }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.reject).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'VERIFICATION_UNAVAILABLE' }),
    )
  })

  it('rejects a confirmed missing object without issuing an unversioned delete', async () => {
    mocks.inspect.mockResolvedValue({ state: 'missing' })
    await caller
      .createCaller(context())
      .intakeUpload.verify({ venueId: 'venue-a', uploadId: 'upload-1', claimId })
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.reject).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'OBJECT_MISSING' }),
    )
  })

  it('returns a bounded safe list without transport identities', async () => {
    mocks.list.mockResolvedValue({
      items: [
        {
          ...upload,
          status: 'VERIFYING',
          verificationLeaseActive: true,
          objectKey: 'secret-key',
          objectGeneration: 'secret-generation',
          sha256: checksum,
          rawError: 'secret',
        },
      ],
      nextCursor: { createdAt: now.toISOString(), id: 'upload-1' },
    })
    const result = await caller
      .createCaller(context())
      .intakeUpload.list({ venueId: 'venue-a', limit: 25 })
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', venueId: 'venue-a', limit: 25 }),
    )
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('secret-key')
    expect(serialized).not.toContain('secret-generation')
    expect(serialized).not.toContain(checksum)
    expect(serialized).not.toContain('rawError')
    expect(result.items[0]?.clientVerification).toMatchObject({
      kind: 'IN_PROGRESS',
      required: false,
    })
    expect(serialized).not.toContain('verificationLeaseActive')
  })
})
