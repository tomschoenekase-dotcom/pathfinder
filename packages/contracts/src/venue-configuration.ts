import { z } from 'zod'

export const VENUE_ARCHETYPE_IDS = [
  'museum',
  'park',
  'attraction',
  'knowledge-only',
  'generic-physical',
] as const

export const VenueArchetypeId = z.enum(VENUE_ARCHETYPE_IDS)
export type VenueArchetypeId = z.infer<typeof VenueArchetypeId>

export type VenueArchetypeDefinition = Readonly<{
  id: VenueArchetypeId
  label: string
  description: string
}>

export const VENUE_ARCHETYPE_REGISTRY = {
  museum: {
    id: 'museum',
    label: 'Museum',
    description: 'A collection-oriented venue with exhibits and interpretive knowledge.',
  },
  park: {
    id: 'park',
    label: 'Park',
    description: 'A place-based venue where navigation and current conditions may matter.',
  },
  attraction: {
    id: 'attraction',
    label: 'Attraction',
    description: 'A visitor destination with a mix of places, activities, and services.',
  },
  'knowledge-only': {
    id: 'knowledge-only',
    label: 'Knowledge-only venue',
    description: 'An informational experience that does not require a physical-location model.',
  },
  'generic-physical': {
    id: 'generic-physical',
    label: 'Generic physical venue',
    description: 'A flexible physical-location fallback without vertical-specific behavior.',
  },
} as const satisfies Readonly<Record<VenueArchetypeId, VenueArchetypeDefinition>>

export const CAPABILITY_IDS = [
  'location-awareness',
  'navigation',
  'places',
  'items',
  'knowledge',
  'policies',
  'services',
  'events',
  'schedules',
  'media',
  'operational-updates',
  'qr-deep-links',
  'web-widget',
  'structured-responses',
  'analytics',
  'reports',
  'support',
  'evaluation',
  'external-integrations',
] as const

export const CapabilityId = z.enum(CAPABILITY_IDS)
export type CapabilityId = z.infer<typeof CapabilityId>

export type CapabilityDefinition = Readonly<{
  id: CapabilityId
  label: string
  description: string
}>

export const CAPABILITY_REGISTRY = {
  'location-awareness': capability(
    'location-awareness',
    'Location awareness',
    'Use visitor position as bounded experience context.',
  ),
  navigation: capability('navigation', 'Navigation', 'Provide venue navigation and wayfinding.'),
  places: capability('places', 'Places', 'Represent physical or conceptual places.'),
  items: capability('items', 'Items and exhibits', 'Represent exhibits and other guide items.'),
  knowledge: capability('knowledge', 'Knowledge', 'Answer from curated venue knowledge.'),
  policies: capability('policies', 'Policies', 'Explain venue rules and policies.'),
  services: capability('services', 'Services', 'Describe services available to visitors.'),
  events: capability('events', 'Events', 'Present events and temporary programming.'),
  schedules: capability('schedules', 'Schedules', 'Present hours and time-based schedules.'),
  media: capability('media', 'Images and media', 'Attach and present venue media.'),
  'operational-updates': capability(
    'operational-updates',
    'Operational updates',
    'Publish time-bounded venue updates.',
  ),
  'qr-deep-links': capability(
    'qr-deep-links',
    'QR and deep links',
    'Open stable, scoped experience destinations.',
  ),
  'web-widget': capability(
    'web-widget',
    'Web widget',
    'Embed a guest experience in an external website.',
  ),
  'structured-responses': capability(
    'structured-responses',
    'Structured responses',
    'Render safe structured answer components.',
  ),
  analytics: capability('analytics', 'Analytics', 'Collect and summarize product usage signals.'),
  reports: capability('reports', 'Reports', 'Generate operator and client-facing reports.'),
  support: capability('support', 'Support', 'Provide venue-scoped product support workflows.'),
  evaluation: capability('evaluation', 'Evaluation', 'Run bounded quality evaluations.'),
  'external-integrations': capability(
    'external-integrations',
    'External integrations',
    'Connect approved external systems.',
  ),
} as const satisfies Readonly<Record<CapabilityId, CapabilityDefinition>>

function capability(id: CapabilityId, label: string, description: string): CapabilityDefinition {
  return { id, label, description }
}

export const CapabilitySelection = z
  .object({
    enabled: z.array(CapabilityId).default([]),
  })
  .strict()
  .superRefine(({ enabled }, context) => {
    const seen = new Set<CapabilityId>()
    enabled.forEach((id, index) => {
      if (seen.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['enabled', index],
          message: `Capability ${id} is selected more than once`,
        })
      }
      seen.add(id)
    })
  })
export type CapabilitySelection = z.infer<typeof CapabilitySelection>

export const VENUE_PRESET_IDS = [
  'museum',
  'park',
  'attraction',
  'knowledge-only',
  'generic-physical',
] as const

export const VenuePresetId = z.enum(VENUE_PRESET_IDS)
export type VenuePresetId = z.infer<typeof VenuePresetId>

export type VenuePresetDefinition = Readonly<{
  id: VenuePresetId
  label: string
  description: string
  capabilityDefaults: readonly CapabilityId[]
}>

const CONTENT_CAPABILITIES = [
  'items',
  'knowledge',
  'policies',
  'media',
  'structured-responses',
] as const
const PHYSICAL_VENUE_CAPABILITIES = [
  'location-awareness',
  'navigation',
  'places',
  'services',
  'schedules',
  'operational-updates',
  'qr-deep-links',
  'web-widget',
  'analytics',
  'support',
  'evaluation',
] as const

export const VENUE_PRESET_REGISTRY = {
  museum: preset(
    'museum',
    'Museum',
    'A strong starting point for collection and exhibit experiences.',
    [...CONTENT_CAPABILITIES, ...PHYSICAL_VENUE_CAPABILITIES, 'events', 'reports'],
  ),
  park: preset(
    'park',
    'Park',
    'A location-rich starting point for parks and outdoor destinations.',
    [...CONTENT_CAPABILITIES, ...PHYSICAL_VENUE_CAPABILITIES, 'events', 'reports'],
  ),
  attraction: preset('attraction', 'Attraction', 'A broad visitor-experience starting point.', [
    ...CONTENT_CAPABILITIES,
    ...PHYSICAL_VENUE_CAPABILITIES,
    'events',
    'reports',
  ]),
  'knowledge-only': preset(
    'knowledge-only',
    'Knowledge-only venue',
    'An informational starting point without location assumptions.',
    [
      'knowledge',
      'policies',
      'media',
      'web-widget',
      'structured-responses',
      'analytics',
      'support',
      'evaluation',
    ],
  ),
  'generic-physical': preset(
    'generic-physical',
    'Generic physical venue',
    'A neutral physical-venue fallback that can be extended explicitly.',
    [...CONTENT_CAPABILITIES, ...PHYSICAL_VENUE_CAPABILITIES],
  ),
} as const satisfies Readonly<Record<VenuePresetId, VenuePresetDefinition>>

function preset(
  id: VenuePresetId,
  label: string,
  description: string,
  capabilityDefaults: readonly CapabilityId[],
): VenuePresetDefinition {
  return { id, label, description, capabilityDefaults }
}

/**
 * The open audience list and feature-flag map are deliberately separate from the
 * closed capability registry. Neither is authorization: callers must resolve
 * and enforce audience access before retrieval.
 */
export const VenueConfigurationAxes = z
  .object({
    archetype: VenueArchetypeId,
    preset: VenuePresetId.optional(),
    audiences: z.array(z.string().min(1)).default([]),
    capabilities: CapabilitySelection,
    featureFlags: z.record(z.string().min(1), z.boolean()).default({}),
  })
  .strict()
export type VenueConfigurationAxes = z.infer<typeof VenueConfigurationAxes>

export const CONFIGURATION_LAYER_IDS = [
  'platform-default',
  'capability-default',
  'preset-default',
  'client-override',
  'venue-override',
  'experience-override',
] as const

export const ConfigurationLayerId = z.enum(CONFIGURATION_LAYER_IDS)
export type ConfigurationLayerId = z.infer<typeof ConfigurationLayerId>

const NamedConfigurationSource = z
  .object({
    sourceId: z.string().min(1),
    label: z.string().min(1).optional(),
  })
  .strict()

export const ConfigurationSource = z.discriminatedUnion('layer', [
  z
    .object({
      layer: z.literal('platform-default'),
      label: z.string().min(1).optional(),
    })
    .strict(),
  NamedConfigurationSource.extend({ layer: z.literal('capability-default') }),
  NamedConfigurationSource.extend({ layer: z.literal('preset-default') }),
  NamedConfigurationSource.extend({ layer: z.literal('client-override') }),
  NamedConfigurationSource.extend({ layer: z.literal('venue-override') }),
  NamedConfigurationSource.extend({ layer: z.literal('experience-override') }),
])
export type ConfigurationSource = z.infer<typeof ConfigurationSource>

export const EffectiveConfigurationValue = z
  .object({
    key: z.string().min(1),
    value: z.unknown(),
    source: ConfigurationSource,
    overridden: z.boolean(),
    resetTo: ConfigurationSource.optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    const sourceIsOverride = isOverrideConfigurationLayer(entry.source.layer)
    if (entry.overridden !== sourceIsOverride) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overridden'],
        message: 'Override status must agree with the effective value source layer',
      })
    }
    if (entry.overridden && entry.resetTo === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resetTo'],
        message: 'An overridden value must identify the source exposed by reset',
      })
    } else if (!entry.overridden && entry.resetTo !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resetTo'],
        message: 'Only an overridden value can expose a reset target',
      })
    }
  })
export type EffectiveConfigurationValue = z.infer<typeof EffectiveConfigurationValue>

export const EffectiveVenueConfiguration = z
  .object({
    values: z.array(EffectiveConfigurationValue),
  })
  .strict()
  .superRefine(({ values }, context) => {
    const seen = new Set<string>()
    values.forEach(({ key }, index) => {
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['values', index, 'key'],
          message: `Effective configuration contains duplicate key ${key}`,
        })
      }
      seen.add(key)
    })
  })
export type EffectiveVenueConfiguration = z.infer<typeof EffectiveVenueConfiguration>

export function isOverrideConfigurationLayer(layer: ConfigurationLayerId): boolean {
  return layer.endsWith('-override')
}
