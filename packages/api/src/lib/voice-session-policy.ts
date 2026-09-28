import { z } from 'zod'

export const VoiceEntitlementSettings = z
  .object({
    maxSessionSeconds: z.number().int().min(30).max(3_600).default(600),
    dailySeconds: z.number().int().min(60).max(86_400).default(3_600),
    monthlySeconds: z.number().int().min(60).max(2_592_000).default(18_000),
    maxConcurrentSessions: z.number().int().min(1).max(50).default(2),
    voice: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9._-]+$/u)
      .default('marin'),
  })
  .strict()

export type VoiceEntitlementSettings = z.infer<typeof VoiceEntitlementSettings>

export const MIN_VOICE_SESSION_SECONDS = 30

type ActiveVoiceQuotaSession = {
  maxDurationSeconds: number
  durationSeconds: number
  createdAt: Date
  connectedAt: Date | null
}

export function endedVoiceBoundarySeconds(
  sessions: readonly { endedAt: Date | null; durationSeconds: number }[],
  windowStart: Date,
): number {
  return sessions.reduce((sum, session) => {
    if (!session.endedAt) return sum
    const secondsSinceBoundary = Math.max(
      0,
      (session.endedAt.getTime() - windowStart.getTime()) / 1_000,
    )
    return sum + Math.min(session.durationSeconds, secondsSinceBoundary)
  }, 0)
}

function reservedVoiceSeconds(
  sessions: readonly ActiveVoiceQuotaSession[],
  windowStart: Date,
): number {
  return sessions.reduce((sum, session) => {
    // READY/AUTHORIZING has not started its duration clock. It may connect
    // after the boundary and consume its full authorization in the new window.
    const secondsBeforeWindow = session.connectedAt
      ? Math.max(0, (windowStart.getTime() - session.connectedAt.getTime()) / 1_000)
      : 0
    const possibleInWindow = Math.max(0, session.maxDurationSeconds - secondsBeforeWindow)
    // Duration from sessions created inside the window is already in its sum.
    const alreadyCounted = session.createdAt >= windowStart ? session.durationSeconds : 0
    return sum + Math.max(0, possibleInWindow - alreadyCounted)
  }, 0)
}

export function remainingVoiceSeconds(input: {
  settings: VoiceEntitlementSettings
  dayStart: Date
  monthStart: Date
  dailyUsedSeconds: number
  monthlyUsedSeconds: number
  dailyBoundarySeconds: number
  monthlyBoundarySeconds: number
  activeSessions: readonly ActiveVoiceQuotaSession[]
}): number {
  // Reserve full potential overlap in each UTC window, including sessions that
  // began before its boundary. Add completed cross-boundary time separately.
  return Math.max(
    0,
    Math.min(
      input.settings.dailySeconds -
        input.dailyUsedSeconds -
        input.dailyBoundarySeconds -
        reservedVoiceSeconds(input.activeSessions, input.dayStart),
      input.settings.monthlySeconds -
        input.monthlyUsedSeconds -
        input.monthlyBoundarySeconds -
        reservedVoiceSeconds(input.activeSessions, input.monthStart),
    ),
  )
}

export function resolveVoiceEntitlementSettings(value: unknown): VoiceEntitlementSettings {
  return VoiceEntitlementSettings.parse(value ?? {})
}

export function voiceQuotaWindows(now: Date): { dayStart: Date; monthStart: Date } {
  return {
    dayStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  }
}
