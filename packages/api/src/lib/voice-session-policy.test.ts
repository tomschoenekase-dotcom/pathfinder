import { describe, expect, it } from 'vitest'

import { resolveVoiceEntitlementSettings, voiceQuotaWindows } from './voice-session-policy'

describe('voice session policy', () => {
  it('uses bounded technical defaults and accepts bounded entitlement overrides', () => {
    expect(resolveVoiceEntitlementSettings({})).toEqual({
      maxSessionSeconds: 600,
      dailySeconds: 3_600,
      monthlySeconds: 18_000,
      maxConcurrentSessions: 2,
      voice: 'marin',
    })
    expect(
      resolveVoiceEntitlementSettings({
        maxSessionSeconds: 300,
        dailySeconds: 900,
        monthlySeconds: 4_000,
        maxConcurrentSessions: 1,
        voice: 'cedar',
      }),
    ).toMatchObject({ maxSessionSeconds: 300, voice: 'cedar' })
  })

  it('uses UTC day and month quota windows', () => {
    expect(voiceQuotaWindows(new Date('2026-08-19T23:55:00-05:00'))).toEqual({
      dayStart: new Date('2026-08-20T00:00:00.000Z'),
      monthStart: new Date('2026-08-01T00:00:00.000Z'),
    })
  })
})
