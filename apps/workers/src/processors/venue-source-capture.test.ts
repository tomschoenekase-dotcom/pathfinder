import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  writeJobRecord: vi.fn(),
  updateJobRecord: vi.fn(),
  recordJobFailure: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  claimVenueSourceForCaptureAction: vi.fn(),
  completeVenueSourceCaptureAction: vi.fn(),
  failVenueSourceAction: vi.fn(),
  readAuthorizedSourceHostsAction: vi.fn(),
  releaseVenueSourceClaimAction: vi.fn(),
  updateJobRecord: mocks.updateJobRecord,
  writeJobRecord: mocks.writeJobRecord,
  VENUE_SOURCE_MAX_ATTEMPTS: 3,
}))
vi.mock('@pathfinder/jobs', () => ({
  INTAKE_V1_SOURCE_PROCESSING_QUEUE: 'test-intake-v1-source-processing',
  VENUE_SOURCE_CAPTURE_PROCESS_JOB: 'venue-source-capture-process',
}))
vi.mock('@pathfinder/config', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
vi.mock('@pathfinder/api/venue-source-capture', () => ({
  captureVenueSource: vi.fn(),
  VENUE_SOURCE_LIMITS: { maxPagesCeiling: 10, maxBytesPerPageCeiling: 2_000_000 },
}))
vi.mock('@pathfinder/api/website-intake-runtime', () => ({
  createWebsiteIntakeRuntimeDependencies: vi.fn(),
}))
vi.mock('../lib/job-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/job-execution')>()
  return { ...actual, recordJobFailure: mocks.recordJobFailure }
})

import {
  processVenueSourceCaptureJob,
  type VenueSourceCaptureProcessorDependencies,
} from './venue-source-capture'

const scope = { tenantId: 'tenant_1', venueId: 'venue_1', sourceId: 'source_1' }
const source = {
  id: 'source_1',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  requestUrl: 'https://venue.example.com/',
  host: 'venue.example.com',
  maxPages: 5,
  maxBytesPerPage: 1_000_000,
}
const capture = {
  status: 'PARTIAL' as const,
  errorCode: null,
  inputs: [
    {
      ordinal: 0,
      requestedUrl: 'https://venue.example.com/',
      finalUrl: 'https://venue.example.com/',
      redirectChain: [],
      disposition: 'SUCCEEDED' as const,
      reasonCode: null,
      httpStatus: 200,
      contentType: 'text/html',
      byteSize: 10,
      contentHash: 'a'.repeat(64),
      retrievedAt: new Date('2026-10-02T12:00:00Z'),
      parserVersion: 'v1',
      extractedText: 'Open daily',
      textTruncated: false,
    },
    {
      ordinal: 1,
      requestedUrl: 'https://venue.example.com/menu.pdf',
      finalUrl: 'https://venue.example.com/menu.pdf',
      redirectChain: [],
      disposition: 'FAILED' as const,
      reasonCode: 'PDF_PARSE_FAILED',
      httpStatus: 200,
      contentType: 'application/pdf',
      byteSize: 4,
      contentHash: 'b'.repeat(64),
      retrievedAt: new Date('2026-10-02T12:00:00Z'),
      parserVersion: 'v1',
      extractedText: null,
      textTruncated: false,
    },
  ],
}

function dependencies(
  overrides: Partial<VenueSourceCaptureProcessorDependencies> = {},
): VenueSourceCaptureProcessorDependencies {
  return {
    claim: vi.fn().mockResolvedValue(source),
    authorizedHosts: vi.fn().mockResolvedValue(['venue.example.com']),
    capture: vi.fn().mockResolvedValue(capture),
    complete: vi.fn().mockResolvedValue({ written: true }),
    release: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('venue source capture processor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.writeJobRecord.mockResolvedValue('job-record-1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.recordJobFailure.mockResolvedValue(undefined)
  })

  it('captures within the stored bounds, writes the snapshot once and records the job', async () => {
    const deps = dependencies()
    await expect(
      processVenueSourceCaptureJob(
        scope,
        { bullJobId: 'b1', attemptNumber: 1, maxAttempts: 3 },
        deps,
      ),
    ).resolves.toBe('captured')
    expect(mocks.writeJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: 'test-intake-v1-source-processing',
        jobName: 'venue-source-capture-process',
        tenantId: 'tenant_1',
        status: 'RUNNING',
        payload: { venueId: 'venue_1', sourceId: 'source_1' },
      }),
    )
    expect(deps.capture).toHaveBeenCalledWith({
      startUrl: 'https://venue.example.com/',
      authorizedHosts: ['venue.example.com'],
      maxPages: 5,
      maxBytesPerPage: 1_000_000,
    })
    expect(deps.complete).toHaveBeenCalledWith(scope, capture)
    // HTML ok and PDF failed are separate frozen inputs on one PARTIAL source.
    const written = (deps.complete as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(written.inputs.map((input: { disposition: string }) => input.disposition)).toEqual([
      'SUCCEEDED',
      'FAILED',
    ])
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job-record-1', { status: 'COMPLETE' })
    expect(deps.release).not.toHaveBeenCalled()
  })

  it('is a no-op for a source another worker holds or that already finished', async () => {
    const deps = dependencies({ claim: vi.fn().mockResolvedValue(null) })
    await expect(processVenueSourceCaptureJob(scope, undefined, deps)).resolves.toBe('not-claimed')
    expect(deps.capture).not.toHaveBeenCalled()
    expect(deps.complete).not.toHaveBeenCalled()
  })

  it('captures nothing when the venue revoked the host after the request', async () => {
    const deps = dependencies({ authorizedHosts: vi.fn().mockResolvedValue(['other.example.org']) })
    await expect(processVenueSourceCaptureJob(scope, undefined, deps)).resolves.toBe(
      'no-authorized-hosts',
    )
    expect(deps.capture).not.toHaveBeenCalled()
    expect(deps.complete).toHaveBeenCalledWith(scope, {
      status: 'FAILED',
      errorCode: 'HOST_NOT_AUTHORIZED',
      inputs: [],
    })
  })

  it('gives the claim back on a retryable failure and fails the source on the last attempt', async () => {
    const failing = () =>
      dependencies({ capture: vi.fn().mockRejectedValue(new Error('socket hang up with secrets')) })
    const retry = failing()
    await expect(
      processVenueSourceCaptureJob(
        scope,
        { bullJobId: 'b1', attemptNumber: 1, maxAttempts: 3 },
        retry,
      ),
    ).rejects.toThrow('VENUE_SOURCE_CAPTURE_FAILED')
    expect(retry.release).toHaveBeenCalledWith(scope)
    expect(retry.fail).not.toHaveBeenCalled()

    const last = failing()
    await expect(
      processVenueSourceCaptureJob(
        scope,
        { bullJobId: 'b1', attemptNumber: 3, maxAttempts: 3 },
        last,
      ),
    ).rejects.toThrow('VENUE_SOURCE_CAPTURE_FAILED')
    expect(last.fail).toHaveBeenCalledWith(scope, 'CAPTURE_FAILED')
    expect(last.release).not.toHaveBeenCalled()
    expect(mocks.recordJobFailure).toHaveBeenCalledTimes(2)
  })

  it('never lets the queue error carry the underlying message', async () => {
    const deps = dependencies({
      capture: vi.fn().mockRejectedValue(new Error('postgres://user:pw@host')),
    })
    const error = await processVenueSourceCaptureJob(scope, undefined, deps).catch((e: Error) => e)
    expect((error as Error).message).toBe('VENUE_SOURCE_CAPTURE_FAILED')
  })

  it('rejects any payload beyond the three opaque scope IDs before doing work', async () => {
    const deps = dependencies()
    await expect(
      processVenueSourceCaptureJob(
        { ...scope, url: 'https://169.254.169.254/' } as typeof scope,
        undefined,
        deps,
      ),
    ).rejects.toThrow()
    await expect(
      processVenueSourceCaptureJob({ ...scope, tenantId: '../etc' }, undefined, deps),
    ).rejects.toThrow()
    expect(mocks.writeJobRecord).not.toHaveBeenCalled()
    expect(deps.claim).not.toHaveBeenCalled()
  })
})
