import { describe, expect, it } from 'vitest'

import {
  CAPABILITY_IDS,
  CAPABILITY_REGISTRY,
  CONFIGURATION_LAYER_IDS,
  CapabilitySelection,
  EffectiveVenueConfiguration,
  VENUE_ARCHETYPE_IDS,
  VENUE_ARCHETYPE_REGISTRY,
  VENUE_PRESET_IDS,
  VENUE_PRESET_REGISTRY,
  VenueConfigurationAxes,
  isOverrideConfigurationLayer,
} from './venue-configuration'

describe('venue configuration contracts', () => {
  it('keeps every closed registry exhaustive and self-identifying', () => {
    expect(Object.keys(VENUE_ARCHETYPE_REGISTRY)).toEqual(VENUE_ARCHETYPE_IDS)
    expect(Object.values(VENUE_ARCHETYPE_REGISTRY).map(({ id }) => id)).toEqual(VENUE_ARCHETYPE_IDS)
    expect(Object.keys(CAPABILITY_REGISTRY)).toEqual(CAPABILITY_IDS)
    expect(Object.values(CAPABILITY_REGISTRY).map(({ id }) => id)).toEqual(CAPABILITY_IDS)
    expect(Object.keys(VENUE_PRESET_REGISTRY)).toEqual(VENUE_PRESET_IDS)
    expect(Object.values(VENUE_PRESET_REGISTRY).map(({ id }) => id)).toEqual(VENUE_PRESET_IDS)
  })

  it('keeps archetype, preset, audience configuration, capabilities, and flags independent', () => {
    expect(
      VenueConfigurationAxes.parse({
        archetype: 'museum',
        preset: 'knowledge-only',
        audiences: ['staff'],
        capabilities: { enabled: ['knowledge'] },
        featureFlags: { experimentalNavigation: true },
      }),
    ).toEqual({
      archetype: 'museum',
      preset: 'knowledge-only',
      audiences: ['staff'],
      capabilities: { enabled: ['knowledge'] },
      featureFlags: { experimentalNavigation: true },
    })
  })

  it('rejects unknown and duplicate capabilities', () => {
    expect(CapabilitySelection.safeParse({ enabled: ['billing'] }).success).toBe(false)
    expect(CapabilitySelection.safeParse({ enabled: ['knowledge', 'knowledge'] }).success).toBe(
      false,
    )
  })

  it('represents effective values with provenance and a reset target', () => {
    expect(
      EffectiveVenueConfiguration.parse({
        values: [
          {
            key: 'tone.preset',
            value: 'concise',
            source: { layer: 'venue-override', sourceId: 'venue-1' },
            overridden: true,
            resetTo: { layer: 'preset-default', sourceId: 'museum' },
          },
        ],
      }),
    ).toEqual({
      values: [
        {
          key: 'tone.preset',
          value: 'concise',
          source: { layer: 'venue-override', sourceId: 'venue-1' },
          overridden: true,
          resetTo: { layer: 'preset-default', sourceId: 'museum' },
        },
      ],
    })

    expect(
      EffectiveVenueConfiguration.safeParse({
        values: [
          {
            key: 'tone.preset',
            value: 'friendly',
            source: { layer: 'platform-default' },
            overridden: false,
            resetTo: { layer: 'platform-default' },
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('recognizes only the three explicit override layers', () => {
    expect(CONFIGURATION_LAYER_IDS.filter((layer) => isOverrideConfigurationLayer(layer))).toEqual([
      'client-override',
      'venue-override',
      'experience-override',
    ])
  })
})
