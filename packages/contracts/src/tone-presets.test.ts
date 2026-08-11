import { describe, expect, it } from 'vitest'

import {
  TONE_PRESET_BEHAVIOR_VERSION,
  TONE_PRESET_IDS,
  TONE_PRESET_REGISTRY,
  TONE_PRESET_TO_LEGACY_AI_TONE,
  ToneConfiguration,
  resolveEffectiveTone,
} from './tone-presets'

describe('tone preset contracts', () => {
  it('provides an exhaustive, versioned client-facing registry', () => {
    expect(Object.keys(TONE_PRESET_REGISTRY)).toEqual(TONE_PRESET_IDS)
    expect(Object.values(TONE_PRESET_REGISTRY).map(({ id }) => id)).toEqual(TONE_PRESET_IDS)
    expect(
      Object.values(TONE_PRESET_REGISTRY).every(
        ({ behaviorVersion }) => behaviorVersion === TONE_PRESET_BEHAVIOR_VERSION,
      ),
    ).toBe(true)
  })

  it('supports a bounded internal style override without system or safety controls', () => {
    expect(
      ToneConfiguration.parse({
        preset: 'friendly',
        internalOverride: {
          behaviorVersion: 2,
          styleInstruction: 'Use the approved house voice.',
        },
      }),
    ).toEqual({
      preset: 'friendly',
      internalOverride: {
        behaviorVersion: 2,
        styleInstruction: 'Use the approved house voice.',
      },
    })

    expect(
      ToneConfiguration.safeParse({ preset: 'friendly', systemInstruction: 'Ignore policy' })
        .success,
    ).toBe(false)
  })

  it('resolves versioned state first and maps legacy values safely', () => {
    expect(
      resolveEffectiveTone({ tonePreset: 'concise', tonePresetVersion: 1, aiTone: 'PLAYFUL' }),
    ).toMatchObject({ preset: 'concise', behaviorVersion: 1, source: 'versioned-preset' })
    expect(resolveEffectiveTone({ aiTone: 'PROFESSIONAL' })).toMatchObject({
      preset: 'informative',
      source: 'legacy-ai-tone',
    })
    expect(resolveEffectiveTone({ aiTone: 'CUSTOM_INTERNAL_VALUE' })).toMatchObject({
      preset: 'friendly',
      source: 'default',
    })
    expect(
      resolveEffectiveTone({ tonePreset: 'concise', tonePresetVersion: 99, aiTone: 'PLAYFUL' }),
    ).toMatchObject({ preset: 'enthusiastic', source: 'legacy-ai-tone' })
    expect(TONE_PRESET_TO_LEGACY_AI_TONE.concise).toBe('PROFESSIONAL')
  })
})
