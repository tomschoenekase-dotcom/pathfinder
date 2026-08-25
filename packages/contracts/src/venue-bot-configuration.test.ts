import { describe, expect, it } from 'vitest'

import {
  customPersonalityStyleInstruction,
  PersonalityProfileDraft,
  resolvePublicVenueBotPresentation,
  UpdateVenueBotConfiguration,
  VenueBotConfigurationValues,
} from './venue-bot-configuration'

const classic = {
  presentationMode: 'CLASSIC',
  personalityMode: 'PRESET',
  tonePreset: 'concise',
  tonePresetVersion: 1,
  responseDepth: 'BALANCED',
  personalityProfileId: null,
  characterKey: 'tochi',
  customCharacterId: null,
  publicDisplayName: 'Museum guide',
  greeting: 'How can I help?',
  voiceProfileId: null,
} as const

describe('Venue Bot configuration contracts', () => {
  it('keeps Classic valid while retaining an existing character selection and preset', () => {
    expect(VenueBotConfigurationValues.parse(classic)).toEqual(classic)
  })

  it('requires a selected character for Character presentation', () => {
    expect(() =>
      VenueBotConfigurationValues.parse({
        ...classic,
        presentationMode: 'CHARACTER',
        characterKey: null,
      }),
    ).toThrow(/requires a character selection/u)
  })

  it('requires custom personality records without allowing them in preset mode', () => {
    expect(() =>
      VenueBotConfigurationValues.parse({
        ...classic,
        personalityMode: 'CUSTOM',
      }),
    ).toThrow(/requires a personality profile/u)
    expect(() =>
      VenueBotConfigurationValues.parse({
        ...classic,
        personalityProfileId: 'profile-1',
      }),
    ).toThrow(/cannot select a custom personality/u)
  })

  it('accepts bounded partial updates with an exact expected revision', () => {
    expect(
      UpdateVenueBotConfiguration.parse({
        venueId: 'venue-1',
        expectedRevision: 3,
        presentationMode: 'CLASSIC',
      }),
    ).toMatchObject({ expectedRevision: 3, presentationMode: 'CLASSIC' })
  })

  it('accepts only the three governed response-depth settings', () => {
    expect(
      VenueBotConfigurationValues.parse({ ...classic, responseDepth: 'DETAILED' }),
    ).toMatchObject({ responseDepth: 'DETAILED' })
    expect(
      VenueBotConfigurationValues.safeParse({ ...classic, responseDepth: 'UNBOUNDED' }).success,
    ).toBe(false)
  })

  it('returns an exact sanitized public projection and fails safely to Classic', () => {
    const disabled = resolvePublicVenueBotPresentation({
      configuration: { ...classic, presentationMode: 'CHARACTER' },
      rolloutEnabled: false,
      approvedCharacter: null,
    })
    expect(disabled).toEqual({
      mode: 'CLASSIC',
      displayName: 'Museum guide',
      greeting: 'How can I help?',
      personalityPreset: 'concise',
      character: null,
    })
    expect(Object.keys(disabled).sort()).toEqual(
      ['character', 'displayName', 'greeting', 'mode', 'personalityPreset'].sort(),
    )
  })

  it('bounds custom personality controls and keeps safety rules authoritative', () => {
    const draft = PersonalityProfileDraft.parse({
      name: 'Warm and concise',
      bounds: {
        warmth: 0.8,
        brevity: 0.9,
        energy: 0.4,
        formality: 0.6,
        customInstruction: 'Use welcoming transitions.',
      },
    })
    const instruction = customPersonalityStyleInstruction(draft.bounds)
    expect(instruction).toContain('warm and welcoming')
    expect(instruction).toContain('very concise')
    expect(instruction).toContain('never overrides factual grounding, safety, privacy')
    expect(
      PersonalityProfileDraft.safeParse({
        ...draft,
        bounds: { ...draft.bounds, customInstruction: 'x'.repeat(501) },
      }).success,
    ).toBe(false)
  })
})
