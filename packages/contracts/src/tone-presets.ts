import { z } from 'zod'

export const TONE_PRESET_BEHAVIOR_VERSION = 1 as const
export const TONE_PRESET_IDS = ['friendly', 'concise', 'enthusiastic', 'informative'] as const

export const TonePresetId = z.enum(TONE_PRESET_IDS)
export type TonePresetId = z.infer<typeof TonePresetId>

export type TonePresetDefinition = Readonly<{
  id: TonePresetId
  label: string
  description: string
  behaviorVersion: typeof TONE_PRESET_BEHAVIOR_VERSION
  styleInstruction: string
}>

export const TONE_PRESET_REGISTRY = {
  friendly: tone(
    'friendly',
    'Friendly',
    'Warm and welcoming while staying clear.',
    'Use a warm, welcoming, conversational style without adding unsupported claims.',
  ),
  concise: tone(
    'concise',
    'Concise',
    'Direct answers with minimal extra detail.',
    'Prefer short, direct answers and include only details that help answer the request.',
  ),
  enthusiastic: tone(
    'enthusiastic',
    'Enthusiastic',
    'Upbeat and engaging without becoming distracting.',
    'Use an upbeat, energetic style while remaining accurate and avoiding exaggerated claims.',
  ),
  informative: tone(
    'informative',
    'Informative',
    'Helpful context and detail in an easy-to-scan form.',
    'Provide useful context and relevant detail in a clear, structured style.',
  ),
} as const satisfies Readonly<Record<TonePresetId, TonePresetDefinition>>

function tone(
  id: TonePresetId,
  label: string,
  description: string,
  styleInstruction: string,
): TonePresetDefinition {
  return { id, label, description, behaviorVersion: TONE_PRESET_BEHAVIOR_VERSION, styleInstruction }
}

export const InternalToneOverride = z
  .object({
    behaviorVersion: z.number().int().positive(),
    styleInstruction: z.string().min(1).max(2_000),
  })
  .strict()
export type InternalToneOverride = z.infer<typeof InternalToneOverride>

/** A style choice only. Safety and system instructions are intentionally absent. */
export const ToneConfiguration = z
  .object({
    preset: TonePresetId,
    internalOverride: InternalToneOverride.optional(),
  })
  .strict()
export type ToneConfiguration = z.infer<typeof ToneConfiguration>

export const LEGACY_AI_TONE_TO_PRESET = {
  FRIENDLY: 'friendly',
  PROFESSIONAL: 'informative',
  PLAYFUL: 'enthusiastic',
} as const satisfies Readonly<Record<string, TonePresetId>>

/**
 * Kept for older consumers while tonePreset is rolled out. Concise has no exact
 * legacy representation, so its conservative fallback is the old professional
 * style (clear and restrained rather than playful).
 */
export const TONE_PRESET_TO_LEGACY_AI_TONE = {
  friendly: 'FRIENDLY',
  concise: 'PROFESSIONAL',
  enthusiastic: 'PLAYFUL',
  informative: 'PROFESSIONAL',
} as const satisfies Readonly<Record<TonePresetId, string>>

export type StoredToneConfiguration = Readonly<{
  tonePreset?: string | null
  tonePresetVersion?: number | null
  aiTone?: string | null
}>

export type EffectiveToneConfiguration = Readonly<{
  preset: TonePresetId
  behaviorVersion: typeof TONE_PRESET_BEHAVIOR_VERSION
  styleInstruction: string
  source: 'versioned-preset' | 'legacy-ai-tone' | 'default'
}>

/** Resolve persisted state without ever treating a client value as a raw instruction. */
export function resolveEffectiveTone(stored: StoredToneConfiguration): EffectiveToneConfiguration {
  const parsedPreset = TonePresetId.safeParse(stored.tonePreset)
  const hasSupportedVersionedPreset =
    parsedPreset.success && stored.tonePresetVersion === TONE_PRESET_BEHAVIOR_VERSION
  const legacyPreset = stored.aiTone
    ? LEGACY_AI_TONE_TO_PRESET[stored.aiTone.toUpperCase() as keyof typeof LEGACY_AI_TONE_TO_PRESET]
    : undefined
  const preset = hasSupportedVersionedPreset ? parsedPreset.data : (legacyPreset ?? 'friendly')
  const definition = TONE_PRESET_REGISTRY[preset]

  // Unknown/future versions fall back to the legacy compatibility value rather
  // than silently applying a different behavior contract.
  return {
    preset,
    behaviorVersion: definition.behaviorVersion,
    styleInstruction: definition.styleInstruction,
    source: hasSupportedVersionedPreset
      ? 'versioned-preset'
      : legacyPreset
        ? 'legacy-ai-tone'
        : 'default',
  }
}
