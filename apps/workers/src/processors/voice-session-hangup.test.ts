import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hangup: vi.fn(),
  load: vi.fn(),
  finalize: vi.fn(),
  emit: vi.fn(),
  writeJob: vi.fn(),
  updateJob: vi.fn(),
  recordFailure: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@pathfinder/ai', () => ({ hangupOpenAiRealtimeCall: mocks.hangup }))
vi.mock('@pathfinder/analytics', () => ({ emitEvent: mocks.emit }))
vi.mock('@pathfinder/config', () => ({
  logger: { info: mocks.info, error: mocks.error, warn: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  finalizeExpiredVoiceSessionHangup: mocks.finalize,
  loadVoiceSessionForHangup: mocks.load,
  writeJobRecord: mocks.writeJob,
  updateJobRecord: mocks.updateJob,
}))
vi.mock('@pathfinder/jobs', () => ({
  VOICE_SESSION_HANGUP_JOB: 'voice-session-hangup',
  VOICE_SESSION_RECOVERY_QUEUE: 'staging--voice-session-recovery',
}))
vi.mock('../lib/job-execution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/job-execution')>()),
  recordJobFailure: mocks.recordFailure,
}))

import { processVoiceSessionHangup } from './voice-session-hangup'

const connectedAt = new Date('2026-08-25T17:50:00.000Z')
const deadlineAt = new Date('2026-08-25T18:00:00.000Z')
const session = {
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  visitorSessionId: 'visitor_1',
  status: 'ACTIVE',
  errorCode: null,
  providerSessionId: 'rtc_123abc',
  createdAt: new Date('2026-08-25T17:49:00.000Z'),
  connectedAt,
  maxDurationSeconds: 600,
}
const expired = {
  id: session.id,
  tenantId: session.tenantId,
  venueId: session.venueId,
  visitorSessionId: session.visitorSessionId,
  previousStatus: 'ACTIVE',
  durationSeconds: 600,
}

describe('voice session hangup processor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('OPENAI_API_KEY', 'server-test-key')
    mocks.load.mockResolvedValue(session)
    mocks.hangup.mockResolvedValue(undefined)
    mocks.finalize.mockResolvedValue(expired)
    mocks.writeJob.mockResolvedValue('job_record_1')
    mocks.updateJob.mockResolvedValue(undefined)
    mocks.emit.mockResolvedValue(undefined)
  })

  afterEach(() => vi.unstubAllEnvs())

  it('hangs up the stored RTC call before finalizing capped usage', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      processVoiceSessionHangup(
        { voiceSessionId: session.id, deadlineAt: deadlineAt.toISOString() },
        undefined,
        { now: () => deadlineAt, fetchImpl },
      ),
    ).resolves.toEqual({ expired: true, reason: 'expired' })

    expect(mocks.hangup).toHaveBeenCalledWith({
      apiKey: 'server-test-key',
      callId: 'rtc_123abc',
      fetchImpl,
    })
    expect(mocks.finalize).toHaveBeenCalledWith({ voiceSessionId: session.id, now: deadlineAt })
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'voice.session.failed',
        metadata: expect.objectContaining({ durationSeconds: 600 }),
      }),
    )
  })

  it('does not call the provider before the persisted deadline', async () => {
    const early = new Date(deadlineAt.getTime() - 1)
    await expect(
      processVoiceSessionHangup(
        { voiceSessionId: session.id, deadlineAt: deadlineAt.toISOString() },
        undefined,
        { now: () => early },
      ),
    ).rejects.toThrow('VOICE_SESSION_HANGUP_FAILED')
    expect(mocks.hangup).not.toHaveBeenCalled()
    expect(mocks.finalize).not.toHaveBeenCalled()
    expect(mocks.recordFailure).toHaveBeenCalledOnce()
  })

  it('immediately hangs up a persisted pending provider call before its deadline', async () => {
    const pending = { ...session, errorCode: 'PROVIDER_HANGUP_PENDING' }
    const early = new Date(connectedAt.getTime() + 1_000)
    mocks.load.mockResolvedValue(pending)

    await expect(
      processVoiceSessionHangup(
        { voiceSessionId: session.id, deadlineAt: deadlineAt.toISOString() },
        undefined,
        { now: () => early },
      ),
    ).resolves.toEqual({ expired: true, reason: 'expired' })

    expect(mocks.hangup).toHaveBeenCalledWith({ apiKey: 'server-test-key', callId: 'rtc_123abc' })
    expect(mocks.finalize).toHaveBeenCalledWith({ voiceSessionId: session.id, now: early })
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'voice.session.failed' }),
    )
  })

  it('ignores a stale job whose deadline no longer matches persisted session state', async () => {
    const stale = new Date(deadlineAt.getTime() - 1).toISOString()
    await expect(
      processVoiceSessionHangup({ voiceSessionId: session.id, deadlineAt: stale }, undefined, {
        now: () => deadlineAt,
      }),
    ).resolves.toEqual({ expired: false, reason: 'stale-deadline' })
    expect(mocks.hangup).not.toHaveBeenCalled()
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('rejects an invalid provider call identity without making a provider request', async () => {
    mocks.load.mockResolvedValue({ ...session, providerSessionId: 'sess_legacy' })
    await expect(
      processVoiceSessionHangup(
        { voiceSessionId: session.id, deadlineAt: deadlineAt.toISOString() },
        undefined,
        { now: () => deadlineAt },
      ),
    ).rejects.toThrow('VOICE_SESSION_HANGUP_FAILED')
    expect(mocks.hangup).not.toHaveBeenCalled()
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('leaves the session eligible for retries when the provider request fails', async () => {
    mocks.hangup.mockRejectedValueOnce(new Error('provider unavailable'))
    await expect(
      processVoiceSessionHangup(
        { voiceSessionId: session.id, deadlineAt: deadlineAt.toISOString() },
        undefined,
        { now: () => deadlineAt },
      ),
    ).rejects.toThrow('VOICE_SESSION_HANGUP_FAILED')
    expect(mocks.finalize).not.toHaveBeenCalled()
    expect(mocks.recordFailure).toHaveBeenCalledOnce()
  })
})
