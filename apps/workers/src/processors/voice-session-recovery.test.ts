import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  expire: vi.fn(),
  emit: vi.fn(),
  writeJob: vi.fn(),
  updateJob: vi.fn(),
  recordFailure: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@pathfinder/analytics', () => ({ emitEvent: mocks.emit }))
vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'test' },
  logger: { info: mocks.info, error: mocks.error, warn: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  expireAbandonedVoiceSessions: mocks.expire,
  VOICE_SESSION_RECOVERY_BATCH_MAX: 250,
  writeJobRecord: mocks.writeJob,
  updateJobRecord: mocks.updateJob,
}))
vi.mock('../lib/job-execution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/job-execution')>()),
  recordJobFailure: mocks.recordFailure,
}))

import { processVoiceSessionRecovery } from './voice-session-recovery'

describe('voice session recovery processor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.writeJob.mockResolvedValue('job_record_1')
    mocks.updateJob.mockResolvedValue(undefined)
    mocks.emit.mockResolvedValue(undefined)
  })

  it('expires a bounded batch and emits machine-readable recovery evidence', async () => {
    const session = {
      id: 'voice_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      visitorSessionId: 'visitor_1',
      previousStatus: 'ACTIVE',
      durationSeconds: 600,
    }
    mocks.expire.mockResolvedValue([session])

    await expect(
      processVoiceSessionRecovery({ bullJobId: 'bull_1', attemptNumber: 1, maxAttempts: 3 }),
    ).resolves.toEqual({ expired: 1 })

    expect(mocks.expire).toHaveBeenCalledWith({ now: expect.any(Date) })
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        sessionId: 'visitor_1',
        eventType: 'voice.session.failed',
        metadata: expect.objectContaining({
          voiceSessionId: 'voice_1',
          failureStage: 'server-expiration',
          previousStatus: 'ACTIVE',
          fallbackToText: true,
        }),
      }),
    )
    expect(mocks.updateJob).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('records and rethrows a recovery failure for BullMQ retry', async () => {
    const failure = new Error('database unavailable')
    mocks.expire.mockRejectedValue(failure)
    mocks.recordFailure.mockResolvedValue(undefined)

    await expect(processVoiceSessionRecovery()).rejects.toThrow('database unavailable')
    expect(mocks.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        jobRecordId: 'job_record_1',
        error: failure,
        errorMessage: 'Voice session recovery run failed.',
      }),
    )
    expect(mocks.updateJob).not.toHaveBeenCalled()
  })
})
