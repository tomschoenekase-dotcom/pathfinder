import { z } from 'zod'

export const CHARACTER_SYSTEM_SCHEMA_VERSION = 1 as const
export const CHARACTER_ASSET_INITIAL_FILE_BUDGET_BYTES = 512 * 1024
export const CHARACTER_ASSET_INITIAL_PACK_BUDGET_BYTES = 2 * 1024 * 1024

export const CHARACTER_STATES = [
  'idle',
  'attention',
  'listening',
  'thinking',
  'speaking',
  'success',
  'processing',
  'uploadReceiving',
  'uploadComplete',
  'question',
  'handoff',
  'error',
  'sleeping',
  'minimized',
] as const

export const CHARACTER_PRESENTATION_CONTEXTS = [
  'client-assistant',
  'venue-text-chat',
  'venue-voice-chat',
  'marketing',
] as const

export const CHARACTER_RENDERER_ADAPTERS = ['layered-svg-v1', 'static-image-v1'] as const
export const CHARACTER_ART_STATUSES = ['placeholder', 'review', 'approved', 'retired'] as const
export const CHARACTER_LIFECYCLE_STATUSES = [
  'development',
  'active',
  'deprecated',
  'archived',
] as const
export const CHARACTER_SOURCES = ['system', 'tenant-custom'] as const
export const CHARACTER_CAPABILITIES = [
  'static',
  'animation',
  'look-at',
  'semantic-state',
  'voice-ready',
] as const
export const CHARACTER_ASSET_MEDIA_TYPES = [
  'image/svg+xml',
  'image/png',
  'image/webp',
  'image/avif',
] as const

const Identifier = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80)
const VersionIdentifier = z
  .string()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)
  .max(80)
const UnitInterval = z.number().finite().min(0).max(1)
const PositiveDimension = z.number().int().positive().max(4096)
const NonNegativeCoordinate = z.number().finite().min(0).max(4096)

export const CharacterStateSchema = z.enum(CHARACTER_STATES)
export type CharacterState = z.infer<typeof CharacterStateSchema>

export const CharacterPresentationContextSchema = z.enum(CHARACTER_PRESENTATION_CONTEXTS)
export type CharacterPresentationContext = z.infer<typeof CharacterPresentationContextSchema>

export const CharacterRendererAdapterSchema = z.enum(CHARACTER_RENDERER_ADAPTERS)
export type CharacterRendererAdapter = z.infer<typeof CharacterRendererAdapterSchema>

export const CharacterArtStatusSchema = z.enum(CHARACTER_ART_STATUSES)
export type CharacterArtStatus = z.infer<typeof CharacterArtStatusSchema>

export const CharacterLifecycleStatusSchema = z.enum(CHARACTER_LIFECYCLE_STATUSES)
export type CharacterLifecycleStatus = z.infer<typeof CharacterLifecycleStatusSchema>

export const CharacterSourceSchema = z.enum(CHARACTER_SOURCES)
export type CharacterSource = z.infer<typeof CharacterSourceSchema>

export const CharacterCapabilitySchema = z.enum(CHARACTER_CAPABILITIES)
export type CharacterCapability = z.infer<typeof CharacterCapabilitySchema>

export const CharacterAssetMediaTypeSchema = z.enum(CHARACTER_ASSET_MEDIA_TYPES)
export type CharacterAssetMediaType = z.infer<typeof CharacterAssetMediaTypeSchema>

export const VOICE_SESSION_EVENTS = [
  'listening-started',
  'transcript-partial',
  'transcript-final',
  'speaking-started',
  'audio-level',
  'speaking-ended',
  'interrupted',
  'error',
] as const

export const VoiceProfileDefinitionSchema = z
  .object({
    id: Identifier,
    label: z.string().trim().min(1).max(80),
    locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/u),
    supportsInput: z.boolean(),
    supportsOutput: z.boolean(),
    supportsInterruption: z.boolean(),
    captionsRequired: z.literal(true),
  })
  .strict()
export type VoiceProfileDefinition = z.infer<typeof VoiceProfileDefinitionSchema>

export const VoiceSessionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('listening-started') }).strict(),
  z
    .object({
      type: z.enum(['transcript-partial', 'transcript-final']),
      text: z.string().max(4_000),
    })
    .strict(),
  z.object({ type: z.literal('speaking-started') }).strict(),
  z.object({ type: z.literal('audio-level'), level: UnitInterval }).strict(),
  z.object({ type: z.literal('speaking-ended') }).strict(),
  z.object({ type: z.literal('interrupted'), source: z.enum(['user', 'system']) }).strict(),
  z.object({ type: z.literal('error'), recoverable: z.boolean() }).strict(),
])
export type VoiceSessionEvent = z.infer<typeof VoiceSessionEventSchema>

/** Optional future adapter; current products intentionally ship text-only. */
export type CharacterVoiceRuntimeHooks = {
  onEvent: (event: VoiceSessionEvent) => void
  requestStart: (profile: VoiceProfileDefinition) => Promise<void>
  requestInterrupt: () => Promise<void>
  requestStop: () => Promise<void>
}

export const CharacterPointSchema = z.object({
  x: NonNegativeCoordinate,
  y: NonNegativeCoordinate,
})
export type CharacterPoint = z.infer<typeof CharacterPointSchema>

export const CharacterBoundsSchema = z.object({
  x: NonNegativeCoordinate,
  y: NonNegativeCoordinate,
  width: PositiveDimension,
  height: PositiveDimension,
})
export type CharacterBounds = z.infer<typeof CharacterBoundsSchema>

const CharacterDefinitionBaseSchema = z
  .object({
    schemaVersion: z.literal(CHARACTER_SYSTEM_SCHEMA_VERSION),
    id: Identifier,
    displayName: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(280),
    source: CharacterSourceSchema,
    lifecycle: CharacterLifecycleStatusSchema,
    defaultAssetPackId: Identifier,
    supportedContexts: z.array(CharacterPresentationContextSchema).min(1).max(4),
    capabilities: z.array(CharacterCapabilitySchema).min(1).max(5),
    tags: z.array(Identifier).max(12).default([]),
  })
  .strict()

export const CharacterDefinitionSchema = CharacterDefinitionBaseSchema.superRefine(
  (definition, context) => {
    if (new Set(definition.supportedContexts).size !== definition.supportedContexts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supportedContexts'],
        message: 'Character contexts must be unique.',
      })
    }
    if (new Set(definition.capabilities).size !== definition.capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities'],
        message: 'Character capabilities must be unique.',
      })
    }
  },
)
export type CharacterDefinition = z.infer<typeof CharacterDefinitionSchema>

function isSafeRelativeAssetPath(path: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path)) return false
  if (path.includes('\\') || path.startsWith('/') || path.includes('//')) return false
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return false
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path)) return false
  return !/\.(?:html?|m?js|cjs|wasm|exe|dll|bat|cmd|ps1|sh)$/i.test(path)
}

export const CharacterAssetReferenceSchema = z
  .object({
    id: Identifier,
    path: z.string().min(1).max(240).refine(isSafeRelativeAssetPath, {
      message: 'Asset paths must be safe, relative, local media paths.',
    }),
    mediaType: CharacterAssetMediaTypeSchema,
    width: PositiveDimension,
    height: PositiveDimension,
    bytes: z.number().int().positive().max(CHARACTER_ASSET_INITIAL_FILE_BUDGET_BYTES),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
export type CharacterAssetReference = z.infer<typeof CharacterAssetReferenceSchema>

export const CharacterStateMappingSchema = z
  .object({
    variant: Identifier,
    staticAssetId: Identifier.optional(),
  })
  .strict()
export type CharacterStateMapping = z.infer<typeof CharacterStateMappingSchema>

export const CharacterVoiceSeamSchema = z
  .object({
    supported: z.boolean(),
    profileIds: z.array(Identifier).max(20).default([]),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
export type CharacterVoiceSeam = z.infer<typeof CharacterVoiceSeamSchema>

const CharacterAssetManifestBaseSchema = z
  .object({
    schemaVersion: z.literal(CHARACTER_SYSTEM_SCHEMA_VERSION),
    characterId: Identifier,
    assetPackId: Identifier,
    version: VersionIdentifier,
    renderer: CharacterRendererAdapterSchema,
    artStatus: CharacterArtStatusSchema,
    publishable: z.boolean(),
    publicBasePath: z
      .string()
      .regex(/^\/characters\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    assets: z.array(CharacterAssetReferenceSchema).min(1).max(32),
    canvas: z.object({ width: PositiveDimension, height: PositiveDimension }).strict(),
    safeBounds: CharacterBoundsSchema,
    origin: CharacterPointSchema,
    anchors: z
      .object({
        lookAt: CharacterPointSchema,
        embers: CharacterPointSchema,
      })
      .strict(),
    thumbnailAssetId: Identifier,
    selectionPreviewAssetId: Identifier,
    staticFallbackAssetId: Identifier,
    reducedMotionFallbackAssetId: Identifier,
    layers: z
      .object({
        body: Identifier.optional(),
        eyes: Identifier.optional(),
        embers: Identifier.optional(),
        glow: Identifier.optional(),
        shadow: Identifier.optional(),
      })
      .strict()
      .default({}),
    states: z.record(CharacterStateSchema, CharacterStateMappingSchema).default({}),
    stateFallbacks: z.record(CharacterStateSchema, CharacterStateSchema).default({}),
    supportedThemes: z.array(Identifier).min(1).max(12),
    supportedContexts: z.array(CharacterPresentationContextSchema).min(1).max(4),
    voice: CharacterVoiceSeamSchema.optional(),
    attribution: z.string().trim().max(500).optional(),
    internalHandoffNotes: z.string().trim().max(1_000).optional(),
  })
  .strict()

function pointIsInsideCanvas(point: CharacterPoint, canvas: { width: number; height: number }) {
  return point.x <= canvas.width && point.y <= canvas.height
}

function hasFallbackCycle(fallbacks: Partial<Record<CharacterState, CharacterState>>) {
  for (const state of CHARACTER_STATES) {
    const visited = new Set<CharacterState>()
    let current: CharacterState | undefined = state
    while (current) {
      if (visited.has(current)) return true
      visited.add(current)
      current = fallbacks[current]
    }
  }
  return false
}

function hasUnsafeControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    )
  })
}

export const CharacterAssetManifestSchema = CharacterAssetManifestBaseSchema.superRefine(
  (manifest, context) => {
    const ids = new Set<string>()
    let totalBytes = 0
    for (const [index, asset] of manifest.assets.entries()) {
      if (ids.has(asset.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets', index, 'id'],
          message: `Duplicate asset id: ${asset.id}`,
        })
      }
      ids.add(asset.id)
      totalBytes += asset.bytes
    }

    if (totalBytes > CHARACTER_ASSET_INITIAL_PACK_BUDGET_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assets'],
        message: 'Character pack exceeds the initial byte budget.',
      })
    }

    const requiredAssetIds = [
      manifest.thumbnailAssetId,
      manifest.selectionPreviewAssetId,
      manifest.staticFallbackAssetId,
      manifest.reducedMotionFallbackAssetId,
      ...Object.values(manifest.layers).filter((value): value is string => Boolean(value)),
      ...Object.values(manifest.states)
        .map((mapping) => mapping.staticAssetId)
        .filter((value): value is string => Boolean(value)),
    ]
    for (const assetId of requiredAssetIds) {
      if (!ids.has(assetId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets'],
          message: `Manifest references missing asset: ${assetId}`,
        })
      }
    }

    if (manifest.artStatus === 'placeholder' && manifest.publishable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publishable'],
        message: 'Placeholder character packs cannot be publishable.',
      })
    }
    if (manifest.publishable && manifest.artStatus !== 'approved') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artStatus'],
        message: 'Only approved character packs can be publishable.',
      })
    }
    if (manifest.renderer === 'layered-svg-v1' && !manifest.layers.body) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layers', 'body'],
        message: 'Layered SVG packs require a body layer.',
      })
    }
    if (
      manifest.safeBounds.x + manifest.safeBounds.width > manifest.canvas.width ||
      manifest.safeBounds.y + manifest.safeBounds.height > manifest.canvas.height
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['safeBounds'],
        message: 'Safe bounds must fit inside the manifest canvas.',
      })
    }
    for (const [name, point] of [
      ['origin', manifest.origin],
      ['anchors.lookAt', manifest.anchors.lookAt],
      ['anchors.embers', manifest.anchors.embers],
    ] as const) {
      if (!pointIsInsideCanvas(point, manifest.canvas)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: name.split('.'),
          message: 'Manifest coordinates must fit inside the canvas.',
        })
      }
    }
    if (hasFallbackCycle(manifest.stateFallbacks)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stateFallbacks'],
        message: 'Character state fallbacks cannot contain cycles.',
      })
    }
    if (new Set(manifest.supportedContexts).size !== manifest.supportedContexts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supportedContexts'],
        message: 'Manifest contexts must be unique.',
      })
    }
    if (new Set(manifest.supportedThemes).size !== manifest.supportedThemes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supportedThemes'],
        message: 'Manifest themes must be unique.',
      })
    }
  },
)
export type CharacterAssetManifest = z.infer<typeof CharacterAssetManifestSchema>

export type CharacterStateManifest = Pick<
  CharacterAssetManifest,
  'states' | 'stateFallbacks' | 'staticFallbackAssetId'
>

export const CharacterRegistryEntrySchema = z
  .object({
    definition: CharacterDefinitionSchema,
    manifests: z.array(CharacterAssetManifestSchema).min(1),
  })
  .strict()
  .superRefine((entry, context) => {
    const packIds = new Set<string>()
    for (const [index, manifest] of entry.manifests.entries()) {
      if (manifest.characterId !== entry.definition.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manifests', index, 'characterId'],
          message: 'Manifest character id must match its definition.',
        })
      }
      for (const presentationContext of manifest.supportedContexts) {
        if (!entry.definition.supportedContexts.includes(presentationContext)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['manifests', index, 'supportedContexts'],
            message: `Manifest context is not supported by its definition: ${presentationContext}`,
          })
        }
      }
      if (packIds.has(manifest.assetPackId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manifests', index, 'assetPackId'],
          message: `Duplicate asset pack id: ${manifest.assetPackId}`,
        })
      }
      packIds.add(manifest.assetPackId)
    }
    if (!packIds.has(entry.definition.defaultAssetPackId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['definition', 'defaultAssetPackId'],
        message: 'The default asset pack must exist in the registry entry.',
      })
    }
  })
export type CharacterRegistryEntry = z.infer<typeof CharacterRegistryEntrySchema>

export function validateCharacterRegistry(entries: readonly CharacterRegistryEntry[]) {
  const ids = new Set<string>()
  const packKeys = new Set<string>()
  const validated: CharacterRegistryEntry[] = []
  for (const [index, candidate] of entries.entries()) {
    const entry = CharacterRegistryEntrySchema.parse(candidate)
    if (ids.has(entry.definition.id)) {
      throw new Error(`Duplicate character definition id at index ${index}: ${entry.definition.id}`)
    }
    ids.add(entry.definition.id)
    for (const manifest of entry.manifests) {
      const packKey = `${manifest.assetPackId}@${manifest.version}`
      if (packKeys.has(packKey)) {
        throw new Error(`Duplicate character asset pack: ${packKey}`)
      }
      packKeys.add(packKey)
    }
    validated.push(entry)
  }
  return validated
}

export type CharacterStateResolution =
  | {
      kind: 'state'
      requestedState: CharacterState
      resolvedState: CharacterState
      source: 'requested' | 'manifest-fallback' | 'idle'
      mapping: CharacterStateMapping
    }
  | {
      kind: 'static'
      requestedState: CharacterState
      assetId: string
      source: 'pack-static-fallback'
    }

export function resolveCharacterState(
  manifest: CharacterStateManifest,
  requestedState: CharacterState,
): CharacterStateResolution {
  const requestedMapping = manifest.states[requestedState]
  if (requestedMapping) {
    return {
      kind: 'state',
      requestedState,
      resolvedState: requestedState,
      source: 'requested',
      mapping: requestedMapping,
    }
  }

  const visited = new Set<CharacterState>([requestedState])
  let fallback = manifest.stateFallbacks[requestedState]
  while (fallback && !visited.has(fallback)) {
    visited.add(fallback)
    const mapping = manifest.states[fallback]
    if (mapping) {
      return {
        kind: 'state',
        requestedState,
        resolvedState: fallback,
        source: 'manifest-fallback',
        mapping,
      }
    }
    fallback = manifest.stateFallbacks[fallback]
  }

  const idleMapping = manifest.states.idle
  if (idleMapping) {
    return {
      kind: 'state',
      requestedState,
      resolvedState: 'idle',
      source: 'idle',
      mapping: idleMapping,
    }
  }

  return {
    kind: 'static',
    requestedState,
    assetId: manifest.staticFallbackAssetId,
    source: 'pack-static-fallback',
  }
}

export const CharacterPresentationSelectionSchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('classic') }).strict(),
    z
      .object({
        mode: z.literal('character'),
        characterId: Identifier,
        assetPackId: Identifier,
        assetPackVersion: VersionIdentifier,
      })
      .strict(),
  ])
  .default({ mode: 'classic' })
export type CharacterPresentationSelection = z.infer<typeof CharacterPresentationSelectionSchema>

export const CustomPersonalityBoundsSchema = z
  .object({
    warmth: UnitInterval,
    brevity: UnitInterval,
    energy: UnitInterval,
    formality: UnitInterval,
    customInstruction: z
      .string()
      .trim()
      .max(500)
      .refine((value) => !hasUnsafeControlCharacter(value), {
        message: 'Custom instructions cannot contain control characters.',
      })
      .optional(),
  })
  .strict()
export type CustomPersonalityBounds = z.infer<typeof CustomPersonalityBoundsSchema>

export const PublicCharacterAssetSchema = CharacterAssetReferenceSchema.pick({
  id: true,
  path: true,
  mediaType: true,
  width: true,
  height: true,
  bytes: true,
})

export const PublicCharacterProjectionSchema = z
  .object({
    characterId: Identifier,
    displayName: z.string().trim().min(1).max(80),
    assetPackId: Identifier,
    assetPackVersion: VersionIdentifier,
    renderer: CharacterRendererAdapterSchema,
    publicBasePath: z.string().startsWith('/characters/'),
    assets: z.array(PublicCharacterAssetSchema).min(1),
    canvas: z.object({ width: PositiveDimension, height: PositiveDimension }).strict(),
    anchors: z
      .object({
        lookAt: CharacterPointSchema,
        embers: CharacterPointSchema,
      })
      .strict(),
    staticFallbackAssetId: Identifier,
    reducedMotionFallbackAssetId: Identifier,
    layers: CharacterAssetManifestBaseSchema.shape.layers,
    states: CharacterAssetManifestBaseSchema.shape.states,
    stateFallbacks: CharacterAssetManifestBaseSchema.shape.stateFallbacks,
    supportedContexts: z.array(CharacterPresentationContextSchema).min(1).max(4),
  })
  .strict()
export type PublicCharacterProjection = z.infer<typeof PublicCharacterProjectionSchema>

export function createPublicCharacterProjection(
  definition: CharacterDefinition,
  manifest: CharacterAssetManifest,
): PublicCharacterProjection | null {
  if (
    definition.id !== manifest.characterId ||
    definition.lifecycle !== 'active' ||
    manifest.artStatus !== 'approved' ||
    !manifest.publishable
  ) {
    return null
  }

  return PublicCharacterProjectionSchema.parse({
    characterId: definition.id,
    displayName: definition.displayName,
    assetPackId: manifest.assetPackId,
    assetPackVersion: manifest.version,
    renderer: manifest.renderer,
    publicBasePath: manifest.publicBasePath,
    assets: manifest.assets.map(({ id, path, mediaType, width, height, bytes }) => ({
      id,
      path,
      mediaType,
      width,
      height,
      bytes,
    })),
    canvas: manifest.canvas,
    anchors: manifest.anchors,
    staticFallbackAssetId: manifest.staticFallbackAssetId,
    reducedMotionFallbackAssetId: manifest.reducedMotionFallbackAssetId,
    layers: manifest.layers,
    states: manifest.states,
    stateFallbacks: manifest.stateFallbacks,
    supportedContexts: manifest.supportedContexts,
  })
}
