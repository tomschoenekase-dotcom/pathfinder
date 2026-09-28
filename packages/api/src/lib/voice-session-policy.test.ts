import { describe, expect, it } from 'vitest'

import {
  endedVoiceBoundarySeconds,
  remainingVoiceSeconds,
  resolveVoiceEntitlementSettings,
  voiceQuotaWindows,
} from './voice-session-policy'

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

  it('reserves every active session before admitting another venue minute', () => {
    const settings = resolveVoiceEntitlementSettings({ monthlySeconds: 1_200, dailySeconds: 900 })
    const dayStart = new Date('2026-09-02T00:00:00Z')
    const monthStart = new Date('2026-09-01T00:00:00Z')
    const activeSessions = [
      { maxDurationSeconds: 400, durationSeconds: 0, createdAt: dayStart, connectedAt: dayStart },
    ]
    expect(
      remainingVoiceSeconds({
        settings,
        dayStart,
        monthStart,
        dailyUsedSeconds: 300,
        monthlyUsedSeconds: 700,
        dailyBoundarySeconds: 0,
        monthlyBoundarySeconds: 0,
        activeSessions,
      }),
    ).toBe(100)
    expect(
      remainingVoiceSeconds({
        settings,
        dayStart,
        monthStart,
        dailyUsedSeconds: 300,
        monthlyUsedSeconds: 800,
        dailyBoundarySeconds: 0,
        monthlyBoundarySeconds: 0,
        activeSessions,
      }),
    ).toBe(0)
  })

  it('charges full new-window overlap from sessions spanning UTC day and month boundaries', () => {
    const start = new Date('2026-09-01T00:00:00Z')
    expect(
      endedVoiceBoundarySeconds(
        [{ endedAt: new Date('2026-09-01T00:02:00Z'), durationSeconds: 180 }],
        start,
      ),
    ).toBe(120)
    const remaining = remainingVoiceSeconds({
      settings: resolveVoiceEntitlementSettings({ dailySeconds: 600, monthlySeconds: 600 }),
      dayStart: start,
      monthStart: start,
      dailyUsedSeconds: 0,
      monthlyUsedSeconds: 0,
      dailyBoundarySeconds: 120,
      monthlyBoundarySeconds: 120,
      activeSessions: [
        {
          maxDurationSeconds: 600,
          durationSeconds: 0,
          createdAt: new Date('2026-08-31T23:59:30Z'),
          connectedAt: new Date('2026-08-31T23:59:30Z'),
        },
      ],
    })
    expect(remaining).toBe(0)
  })

  it('reserves a full future call when authorization began before midnight but connection has not', () => {
    const start = new Date('2026-09-01T00:00:00Z')
    expect(
      remainingVoiceSeconds({
        settings: resolveVoiceEntitlementSettings({ dailySeconds: 600, monthlySeconds: 600 }),
        dayStart: start,
        monthStart: start,
        dailyUsedSeconds: 0,
        monthlyUsedSeconds: 0,
        dailyBoundarySeconds: 0,
        monthlyBoundarySeconds: 0,
        activeSessions: [
          {
            maxDurationSeconds: 600,
            durationSeconds: 0,
            createdAt: new Date('2026-08-31T23:59:30Z'),
            connectedAt: null,
          },
        ],
      }),
    ).toBe(0)
  })
})
