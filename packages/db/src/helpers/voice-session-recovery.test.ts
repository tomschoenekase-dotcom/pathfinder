import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  findFirst: vi.fn(),
  bypass: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}))

vi.mock('../client', () => ({
  db: { $queryRaw: mocks.queryRaw, voiceSession: { findFirst: mocks.findFirst } },
}))
vi.mock('../middleware/tenant-isolation', () => ({
  withTenantIsolationBypass: mocks.bypass,
}))

import {
  expireAbandonedVoiceSessions,
  findDueVoiceSessionHangups,
  finalizeExpiredVoiceSessionHangup,
  loadVoiceSessionForHangup,
  VOICE_AUTHORIZATION_LEASE_SECONDS,
  VOICE_SESSION_RECOVERY_BATCH_MAX,
} from './voice-session-recovery'

describe('voice session recovery', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs one bounded atomic recovery query through an explicit tenant bypass', async () => {
    const now = new Date('2026-08-25T18:00:00.000Z')
    const expired = {
      id: '00000000-0000-4000-8000-000000000001',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      visitorSessionId: 'session_1',
      previousStatus: 'ACTIVE',
      durationSeconds: 600,
    }
    mocks.queryRaw.mockResolvedValueOnce([expired])

    await expect(expireAbandonedVoiceSessions({ now, limit: 17 })).resolves.toEqual([expired])
    expect(mocks.bypass).toHaveBeenCalledOnce()
    expect(mocks.queryRaw).toHaveBeenCalledOnce()
    const query = (mocks.queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?')
    expect(query).toContain('WHEN connected_at IS NULL THEN 0')
    expect(query).toContain('CEIL(EXTRACT(EPOCH FROM (? - connected_at)))')
    expect(query.replace(/\s+/gu, ' ')).toContain('max_duration_seconds, GREATEST(0, CEIL(')
    expect(mocks.queryRaw.mock.calls[0]?.slice(1)).toEqual([
      now,
      VOICE_AUTHORIZATION_LEASE_SECONDS,
      now,
      now,
      VOICE_AUTHORIZATION_LEASE_SECONDS,
      now,
      17,
      now,
      now,
      now,
      now,
    ])
  })

  it('loads only live sessions with the provider call identity and deadline fields', async () => {
    const session = {
      id: '00000000-0000-4000-8000-000000000001',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      visitorSessionId: 'visitor_1',
      status: 'ACTIVE',
      providerSessionId: 'rtc_123',
      errorCode: null,
      createdAt: new Date('2026-08-25T17:00:00Z'),
      connectedAt: new Date('2026-08-25T17:01:00Z'),
      maxDurationSeconds: 600,
    }
    mocks.findFirst.mockResolvedValueOnce(session)

    await expect(loadVoiceSessionForHangup(session.id)).resolves.toEqual(session)
    expect(mocks.bypass).toHaveBeenCalledOnce()
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: session.id, status: { in: ['READY', 'ACTIVE'] } },
      select: expect.objectContaining({
        providerSessionId: true,
        errorCode: true,
        connectedAt: true,
      }),
    })
  })

  it('discovers due RTC provider calls without finalizing them before hangup', async () => {
    const now = new Date('2026-08-25T18:00:00.000Z')
    const due = [{ id: 'voice_1', providerSessionId: 'rtc_123', status: 'ACTIVE' }]
    mocks.queryRaw.mockResolvedValueOnce(due)

    await expect(findDueVoiceSessionHangups({ now, limit: 17 })).resolves.toEqual(due)
    const query = (mocks.queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?')
    expect(query).toContain("provider_session_id ~ '^rtc_[A-Za-z0-9_-]+$'")
    expect(query).toContain("status IN ('READY', 'ACTIVE')")
    expect(query).toContain('COALESCE(connected_at, created_at)')
    expect(query).toContain('error_code AS "errorCode"')
    expect(query).toContain("status = 'ACTIVE' AND error_code = 'PROVIDER_HANGUP_PENDING'")
    expect(mocks.bypass).toHaveBeenCalledOnce()
  })

  it('finalizes only after a due RTC call has been hung up', async () => {
    const expired = {
      id: 'voice_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      visitorSessionId: 'visitor_1',
      previousStatus: 'ACTIVE',
      durationSeconds: 600,
    }
    mocks.queryRaw.mockResolvedValueOnce([expired])
    await expect(
      finalizeExpiredVoiceSessionHangup({ voiceSessionId: expired.id, now: new Date() }),
    ).resolves.toEqual(expired)
    const query = (mocks.queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?')
    expect(query).toContain("status IN ('READY', 'ACTIVE')")
    expect(query).toContain("provider_session_id ~ '^rtc_[A-Za-z0-9_-]+$'")
    expect(query).toContain("error_code = 'SERVER_SESSION_EXPIRED'")
    expect(query).toContain('WHEN connected_at IS NULL THEN 0')
    expect(query).toContain('CEIL(EXTRACT(EPOCH FROM (? - connected_at)))')
    expect(query.replace(/\s+/gu, ' ')).toContain('max_duration_seconds, GREATEST(0, CEIL(')
    expect(query).toContain("status = 'ACTIVE' AND error_code = 'PROVIDER_HANGUP_PENDING'")
  })

  it('uses the hard batch maximum by default', async () => {
    mocks.queryRaw.mockResolvedValueOnce([])
    await expect(expireAbandonedVoiceSessions()).resolves.toEqual([])
    expect(mocks.queryRaw.mock.calls[0]).toContain(VOICE_SESSION_RECOVERY_BATCH_MAX)
  })

  it.each([-1, 0, 251, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number])(
    'rejects invalid limit %s before bypass or SQL',
    async (limit) => {
      await expect(expireAbandonedVoiceSessions({ limit })).rejects.toThrow(
        'Voice session recovery limit must be an integer between 1 and 250.',
      )
      expect(mocks.bypass).not.toHaveBeenCalled()
      expect(mocks.queryRaw).not.toHaveBeenCalled()
    },
  )

  it('rejects an invalid recovery clock before touching the database', async () => {
    await expect(expireAbandonedVoiceSessions({ now: new Date('invalid') })).rejects.toThrow(
      'Voice session recovery time must be valid.',
    )
    expect(mocks.bypass).not.toHaveBeenCalled()
  })
})
