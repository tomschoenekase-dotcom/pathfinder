import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  expire: vi.fn(),
  due: vi.fn(),
  hangup: vi.fn(),
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
  findDueVoiceSessionHangups: mocks.due,
  VOICE_SESSION_RECOVERY_BATCH_MAX: 250,
  writeJobRecord: mocks.writeJob,
  updateJobRecord: mocks.updateJob,
}))
vi.mock('./voice-session-hangup', () => ({ hangupDueVoiceSession: mocks.hangup }))
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
    mocks.due.mockResolvedValue([])
    mocks.hangup.mockResolvedValue(null)
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

    await expect(processVoiceSessionRecovery()).rejects.toThrow('VOICE_SESSION_RECOVERY_FAILED')
    expect(mocks.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        jobRecordId: 'job_record_1',
        error: failure,
      }),
    )
    expect(mocks.updateJob).not.toHaveBeenCalled()
  })

  it('hangs up due provider sessions before recording their expiration', async () => {
    const due = { id: 'voice_provider_1' }
    const expired = {
      id: 'voice_provider_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      visitorSessionId: 'visitor_1',
      previousStatus: 'ACTIVE',
      durationSeconds: 600,
    }
    mocks.due.mockResolvedValue([due])
    mocks.hangup.mockResolvedValue(expired)
    mocks.expire.mockResolvedValue([])

    await expect(processVoiceSessionRecovery()).resolves.toEqual({ expired: 1 })
    expect(mocks.due).toHaveBeenCalledWith({ now: expect.any(Date) })
    expect(mocks.hangup).toHaveBeenCalledWith('voice_provider_1', { now: expect.any(Date) })
    expect(mocks.expire).toHaveBeenCalledOnce()
  })

  it('continues after a provider hangup failure, runs cleanup, and records a retryable job failure', async () => {
    const cleanedUp = {
      id: 'voice_abandoned_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      visitorSessionId: 'visitor_1',
      previousStatus: 'ACTIVE',
      durationSeconds: 600,
    }
    mocks.due.mockResolvedValue([{ id: 'voice_provider_1' }, { id: 'voice_provider_2' }])
    mocks.hangup
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({ id: 'voice_provider_2' })
    mocks.expire.mockResolvedValue([cleanedUp])
    mocks.recordFailure.mockResolvedValue(undefined)

    await expect(processVoiceSessionRecovery({ attemptNumber: 1, maxAttempts: 3 })).rejects.toThrow(
      'VOICE_SESSION_RECOVERY_FAILED',
    )

    expect(mocks.hangup).toHaveBeenNthCalledWith(1, 'voice_provider_1', { now: expect.any(Date) })
    expect(mocks.hangup).toHaveBeenNthCalledWith(2, 'voice_provider_2', { now: expect.any(Date) })
    expect(mocks.expire).toHaveBeenCalledOnce()
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'voice.session.failed',
        sessionId: 'visitor_1',
        metadata: expect.objectContaining({ voiceSessionId: 'voice_abandoned_1' }),
      }),
    )
    expect(mocks.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        jobRecordId: 'job_record_1',
        execution: { attemptNumber: 1, maxAttempts: 3 },
        error: expect.objectContaining({
          message: 'One or more due voice sessions failed provider hangup.',
        }),
      }),
    )
    expect(mocks.updateJob).not.toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })
})
