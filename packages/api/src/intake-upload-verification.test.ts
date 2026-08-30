import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  release: vi.fn(),
  settle: vi.fn(),
  read: vi.fn(),
  scanner: null as null | { engine: string; engineVersion: string; scan: ReturnType<typeof vi.fn> },
}))

vi.mock('@pathfinder/db', () => ({
  claimIntakeUploadVerificationAction: mocks.claim,
  releaseIntakeUploadVerificationAction: mocks.release,
  settleIntakeUploadAuthoritativeVerificationAction: mocks.settle,
}))
vi.mock('./lib/intake-upload-storage', () => ({ readIntakeUploadVersion: mocks.read }))
vi.mock('./lib/intake-upload-byte-verifier', () => ({
  configuredIntakeUploadMalwareScanner: () => mocks.scanner,
}))

import {
  IntakeUploadScannerUnavailableError,
  processIntakeUploadAuthoritativeVerification,
} from './intake-upload-verification'

const input = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  uploadId: 'upload-a',
  claimId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actor: {
    type: 'SYSTEM' as const,
    actorId: 'intake-upload-verification:job-a',
    role: 'SYSTEM' as const,
    systemJobId: 'intake-upload-verification:job-a',
  },
}

describe('authoritative intake upload verification orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.scanner = null
    mocks.claim.mockResolvedValue({
      state: 'PRECHECK_PASSED',
      uploadTarget: {
        objectKey: 'intake-quarantine/opaque',
        storageVersionId: 'immutable-v1',
        byteSize: 42,
        sha256: 'a'.repeat(64),
      },
    })
    mocks.read.mockResolvedValue('byte-stream')
    mocks.release.mockResolvedValue(undefined)
    mocks.settle.mockResolvedValue({ nextAction: 'PATHFINDER_REVIEW' })
  })

  it('fails before claiming when the authoritative scanner is not configured', async () => {
    await expect(processIntakeUploadAuthoritativeVerification(input)).rejects.toBeInstanceOf(
      IntakeUploadScannerUnavailableError,
    )
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  it('scans the exact immutable version and settles the owned claim', async () => {
    const scan = vi.fn().mockResolvedValue({
      verdict: 'CLEAN',
      verdictHash: 'b'.repeat(64),
      computedByteSize: 42,
      computedSha256: 'a'.repeat(64),
    })
    mocks.scanner = { engine: 'clamav-clamd', engineVersion: 'daemon', scan }
    await processIntakeUploadAuthoritativeVerification(input)
    expect(mocks.read).toHaveBeenCalledWith({
      key: 'intake-quarantine/opaque',
      versionId: 'immutable-v1',
    })
    expect(scan).toHaveBeenCalledWith({
      bytes: 'byte-stream',
      expectedBytes: 42,
      expectedSha256: 'a'.repeat(64),
    })
    expect(mocks.settle).toHaveBeenCalledWith({
      ...input,
      malware: expect.objectContaining({ verdict: 'CLEAN', engine: 'clamav-clamd' }),
    })
  })

  it('releases a claimed precheck for retry when storage or scanning fails', async () => {
    mocks.scanner = {
      engine: 'clamav-clamd',
      engineVersion: 'daemon',
      scan: vi.fn().mockRejectedValue(new Error('scanner unavailable')),
    }
    await expect(processIntakeUploadAuthoritativeVerification(input)).rejects.toThrow(
      'scanner unavailable',
    )
    expect(mocks.release).toHaveBeenCalledWith({
      ...input,
      reasonCode: 'VERIFICATION_UNAVAILABLE',
    })
    expect(mocks.settle).not.toHaveBeenCalled()
  })
})
