import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  bypass: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}))

vi.mock('../client', () => ({ db: { $queryRaw: mocks.queryRaw } }))
vi.mock('../middleware/tenant-isolation', () => ({
  withTenantIsolationBypass: mocks.bypass,
}))

import {
  expireAbandonedVoiceSessions,
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
