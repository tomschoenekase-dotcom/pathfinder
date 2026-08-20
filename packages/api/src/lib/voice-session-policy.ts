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

export function resolveVoiceEntitlementSettings(value: unknown): VoiceEntitlementSettings {
  return VoiceEntitlementSettings.parse(value ?? {})
}

export function voiceQuotaWindows(now: Date): { dayStart: Date; monthStart: Date } {
  return {
    dayStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  }
}
