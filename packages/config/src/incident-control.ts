import { z } from 'zod'

export const GLOBAL_AI_CONTROL_KEY = 'global-ai-control-v1' as const
export const GLOBAL_AI_UNAVAILABLE_MESSAGE =
  'The AI service is temporarily unavailable. Please try again later.'

export const globalAiControlValueSchema = z
  .object({
    schemaVersion: z.literal(1),
    paused: z.boolean(),
    reason: z.string().trim().min(1).max(500).nullable(),
  })
  .strict()

export type GlobalAiControlValue = z.infer<typeof globalAiControlValueSchema>

export const DEFAULT_GLOBAL_AI_CONTROL: GlobalAiControlValue = Object.freeze({
  schemaVersion: 1,
  paused: false,
  reason: null,
})

export function parseGlobalAiControlValue(value: unknown): GlobalAiControlValue | null {
  const result = globalAiControlValueSchema.safeParse(value)
  return result.success ? result.data : null
}
