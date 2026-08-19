import { z } from 'zod'

import { TONE_PRESET_BEHAVIOR_VERSION, TonePresetId } from './tone-presets'
import { PublicCharacterProjectionSchema, type PublicCharacterProjection } from './character-system'
import { CustomPersonalityBoundsSchema, type CustomPersonalityBounds } from './character-system'

export const VenueBotPresentationMode = z.enum(['CLASSIC', 'CHARACTER'])
export type VenueBotPresentationMode = z.infer<typeof VenueBotPresentationMode>

export const VenueBotPersonalityMode = z.enum(['PRESET', 'CUSTOM'])
export type VenueBotPersonalityMode = z.infer<typeof VenueBotPersonalityMode>

const NullableIdentifier = z.string().trim().min(1).max(191).nullable()

/**
 * The client-editable axes of Venue Bot configuration. Character identity and
 * personality remain independent, and the legacy preset is always retained.
 */
const VenueBotConfigurationValuesBase = z
  .object({
    presentationMode: VenueBotPresentationMode,
    personalityMode: VenueBotPersonalityMode,
    tonePreset: TonePresetId,
    tonePresetVersion: z.literal(TONE_PRESET_BEHAVIOR_VERSION),
    personalityProfileId: NullableIdentifier,
    characterKey: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .nullable(),
    customCharacterId: NullableIdentifier,
    publicDisplayName: z.string().trim().min(1).max(80).nullable(),
    greeting: z.string().trim().min(1).max(500).nullable(),
    voiceProfileId: NullableIdentifier,
  })
  .strict()

function validateVenueBotConfiguration(
  value: z.infer<typeof VenueBotConfigurationValuesBase>,
  context: z.RefinementCtx,
): void {
  if (value.personalityMode === 'CUSTOM' && value.personalityProfileId === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['personalityProfileId'],
      message: 'Custom personality mode requires a personality profile.',
    })
  }
  if (value.personalityMode === 'PRESET' && value.personalityProfileId !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['personalityProfileId'],
      message: 'Preset personality mode cannot select a custom personality profile.',
    })
  }
  if (value.characterKey !== null && value.customCharacterId !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customCharacterId'],
      message: 'Select either a registered character or a custom character, not both.',
    })
  }
  if (
    value.presentationMode === 'CHARACTER' &&
    value.characterKey === null &&
    value.customCharacterId === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['characterKey'],
      message: 'Character presentation requires a character selection.',
    })
  }
}

export const VenueBotConfigurationValues = VenueBotConfigurationValuesBase.superRefine(
  validateVenueBotConfiguration,
)
export type VenueBotConfigurationValues = z.infer<typeof VenueBotConfigurationValues>

export const VenueBotConfigurationSnapshot = VenueBotConfigurationValuesBase.extend({
  id: z.string().min(1),
  venueId: z.string().min(1),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
})
  .strict()
  .superRefine(validateVenueBotConfiguration)
export type VenueBotConfigurationSnapshot = z.infer<typeof VenueBotConfigurationSnapshot>

export const UpdateVenueBotConfiguration = VenueBotConfigurationValuesBase.omit({
  tonePresetVersion: true,
})
  .partial()
  .extend({
    venueId: z.string().min(1).max(191),
    expectedRevision: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value: Record<string, unknown>) =>
      Object.keys(value).some((key) => !['venueId', 'expectedRevision'].includes(key)),
    'At least one Venue Bot configuration field is required.',
  )
export type UpdateVenueBotConfiguration = z.infer<typeof UpdateVenueBotConfiguration>

export const PersonalityProfileDraft = z
  .object({
    name: z.string().trim().min(1).max(120),
    bounds: CustomPersonalityBoundsSchema,
  })
  .strict()
export type PersonalityProfileDraft = z.infer<typeof PersonalityProfileDraft>

export const PersonalityProfileSnapshot = PersonalityProfileDraft.extend({
  id: z.string().min(1).max(191),
  venueId: z.string().min(1).max(191).nullable(),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict()
export type PersonalityProfileSnapshot = z.infer<typeof PersonalityProfileSnapshot>

/** Converts bounded controls into style guidance; platform truth/safety rules remain authoritative. */
export function customPersonalityStyleInstruction(bounds: CustomPersonalityBounds): string {
  const warmth =
    bounds.warmth >= 0.67
      ? 'warm and welcoming'
      : bounds.warmth <= 0.33
        ? 'neutral and direct'
        : 'friendly'
  const brevity =
    bounds.brevity >= 0.67
      ? 'very concise'
      : bounds.brevity <= 0.33
        ? 'brief but willing to add useful context'
        : 'concise'
  const energy = bounds.energy >= 0.67 ? 'lively' : bounds.energy <= 0.33 ? 'calm' : 'steady'
  const formality =
    bounds.formality >= 0.67
      ? 'polished and formal'
      : bounds.formality <= 0.33
        ? 'natural and casual'
        : 'professional'
  const note = bounds.customInstruction?.trim()
  return `${warmth}; ${brevity}; ${energy}; ${formality}.${
    note ? ` Additional style preference: ${note}` : ''
  } This style preference never overrides factual grounding, safety, privacy, or response-length rules.`
}

export const PublicVenueBotPresentation = z
  .object({
    mode: VenueBotPresentationMode,
    displayName: z.string().min(1).max(80).nullable(),
    greeting: z.string().min(1).max(500).nullable(),
    personalityPreset: TonePresetId,
    character: PublicCharacterProjectionSchema.nullable(),
  })
  .strict()
export type PublicVenueBotPresentation = z.infer<typeof PublicVenueBotPresentation>

/**
 * Produces the complete public projection. Private profile instructions,
 * workflow state, storage references, tenant IDs, and rollout metadata are not
 * accepted by this function and therefore cannot be returned accidentally.
 */
export function resolvePublicVenueBotPresentation(input: {
  configuration: Pick<
    VenueBotConfigurationValues,
    'presentationMode' | 'tonePreset' | 'characterKey' | 'publicDisplayName' | 'greeting'
  > | null
  rolloutEnabled: boolean
  approvedCharacter?: PublicCharacterProjection | null
}): PublicVenueBotPresentation {
  const configuration = input.configuration
  const character = input.approvedCharacter ?? null
  const characterEnabled =
    input.rolloutEnabled &&
    configuration?.presentationMode === 'CHARACTER' &&
    character !== null &&
    configuration.characterKey === character.characterId

  return PublicVenueBotPresentation.parse({
    mode: characterEnabled ? 'CHARACTER' : 'CLASSIC',
    displayName: configuration?.publicDisplayName ?? null,
    greeting: configuration?.greeting ?? null,
    personalityPreset: configuration?.tonePreset ?? 'friendly',
    character: characterEnabled ? character : null,
  })
}
