import { describe, expect, it } from 'vitest'

import {
  CHARACTER_STATES,
  CharacterAssetManifestSchema,
  CharacterDefinitionSchema,
  CharacterRegistryEntrySchema,
  createPublicCharacterProjection,
  resolveCharacterState,
  validateCharacterRegistry,
  VoiceProfileDefinitionSchema,
  VoiceSessionEventSchema,
} from './character-system'

const baseDefinition = {
  schemaVersion: 1,
  id: 'tochi',
  displayName: 'Tochi',
  description: 'Development character definition.',
  source: 'system',
  lifecycle: 'development',
  defaultAssetPackId: 'tochi-dev-v0',
  supportedContexts: ['client-assistant', 'venue-text-chat'],
  capabilities: ['static', 'animation', 'look-at', 'semantic-state'],
  tags: ['torchiko'],
} as const

const baseManifest = {
  schemaVersion: 1,
  characterId: 'tochi',
  assetPackId: 'tochi-dev-v0',
  version: '0-development',
  renderer: 'layered-svg-v1',
  artStatus: 'placeholder',
  publishable: false,
  publicBasePath: '/characters/tochi/v0-development',
  assets: [
    {
      id: 'body',
      path: 'body.svg',
      mediaType: 'image/svg+xml',
      width: 320,
      height: 360,
      bytes: 100,
    },
    {
      id: 'fallback',
      path: 'fallback.svg',
      mediaType: 'image/svg+xml',
      width: 320,
      height: 360,
      bytes: 100,
    },
  ],
  canvas: { width: 320, height: 360 },
  safeBounds: { x: 16, y: 16, width: 288, height: 328 },
  origin: { x: 160, y: 340 },
  anchors: { lookAt: { x: 160, y: 170 }, embers: { x: 160, y: 300 } },
  thumbnailAssetId: 'fallback',
  selectionPreviewAssetId: 'fallback',
  staticFallbackAssetId: 'fallback',
  reducedMotionFallbackAssetId: 'fallback',
  layers: { body: 'body' },
  states: {
    idle: { variant: 'idle' },
    thinking: { variant: 'thinking' },
  },
  stateFallbacks: {
    speaking: 'thinking',
    question: 'attention',
  },
  supportedThemes: ['default'],
  supportedContexts: ['client-assistant', 'venue-text-chat'],
} as const

function cloneManifest() {
  return JSON.parse(JSON.stringify(baseManifest)) as Record<string, unknown>
}

describe('character system contracts', () => {
  it('keeps the semantic state vocabulary exhaustive and stable', () => {
    expect(CHARACTER_STATES).toEqual([
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
    ])
  })

  it('accepts the development definition and a bounded local manifest', () => {
    expect(CharacterDefinitionSchema.parse(baseDefinition).id).toBe('tochi')
    expect(CharacterAssetManifestSchema.parse(baseManifest).publishable).toBe(false)
  })

  it('resolves requested, explicit fallback, idle, then static in exact order', () => {
    const manifest = CharacterAssetManifestSchema.parse(baseManifest)

    expect(resolveCharacterState(manifest, 'thinking')).toMatchObject({
      kind: 'state',
      resolvedState: 'thinking',
      source: 'requested',
    })
    expect(resolveCharacterState(manifest, 'speaking')).toMatchObject({
      kind: 'state',
      resolvedState: 'thinking',
      source: 'manifest-fallback',
    })
    expect(resolveCharacterState(manifest, 'success')).toMatchObject({
      kind: 'state',
      resolvedState: 'idle',
      source: 'idle',
    })

    const noStates = CharacterAssetManifestSchema.parse({
      ...baseManifest,
      states: {},
      stateFallbacks: {},
    })
    expect(resolveCharacterState(noStates, 'success')).toEqual({
      kind: 'static',
      requestedState: 'success',
      assetId: 'fallback',
      source: 'pack-static-fallback',
    })
  })

  it('rejects traversal, remote, executable, missing, cyclic, and oversized assets', () => {
    for (const path of [
      '../body.svg',
      '/tmp/body.svg',
      'https://example.test/body.svg',
      'nested\\body.svg',
      'character.js',
    ]) {
      const candidate = cloneManifest()
      const assets = candidate.assets as Array<Record<string, unknown>>
      if (assets[0]) assets[0].path = path
      expect(CharacterAssetManifestSchema.safeParse(candidate).success).toBe(false)
    }

    const missing = cloneManifest()
    missing.staticFallbackAssetId = 'does-not-exist'
    expect(CharacterAssetManifestSchema.safeParse(missing).success).toBe(false)

    const cyclic = cloneManifest()
    cyclic.stateFallbacks = { thinking: 'speaking', speaking: 'thinking' }
    expect(CharacterAssetManifestSchema.safeParse(cyclic).success).toBe(false)

    const oversized = cloneManifest()
    const assets = oversized.assets as Array<Record<string, unknown>>
    if (assets[0]) assets[0].bytes = 512 * 1024 + 1
    expect(CharacterAssetManifestSchema.safeParse(oversized).success).toBe(false)
  })

  it('prevents placeholder or unapproved art from becoming publishable', () => {
    expect(
      CharacterAssetManifestSchema.safeParse({ ...baseManifest, publishable: true }).success,
    ).toBe(false)
    expect(
      CharacterAssetManifestSchema.safeParse({
        ...baseManifest,
        artStatus: 'review',
        publishable: true,
      }).success,
    ).toBe(false)
  })

  it('rejects mismatched and duplicate registry entries', () => {
    expect(
      CharacterRegistryEntrySchema.safeParse({
        definition: baseDefinition,
        manifests: [{ ...baseManifest, characterId: 'different' }],
      }).success,
    ).toBe(false)
    expect(
      CharacterRegistryEntrySchema.safeParse({
        definition: baseDefinition,
        manifests: [{ ...baseManifest, supportedContexts: ['marketing'] }],
      }).success,
    ).toBe(false)

    const entry = CharacterRegistryEntrySchema.parse({
      definition: baseDefinition,
      manifests: [baseManifest],
    })
    expect(() => validateCharacterRegistry([entry, entry])).toThrow(
      'Duplicate character definition id',
    )
  })

  it('emits a sanitized public projection only for active approved art', () => {
    const developmentDefinition = CharacterDefinitionSchema.parse(baseDefinition)
    const placeholderManifest = CharacterAssetManifestSchema.parse(baseManifest)
    expect(createPublicCharacterProjection(developmentDefinition, placeholderManifest)).toBeNull()

    const definition = CharacterDefinitionSchema.parse({
      ...baseDefinition,
      lifecycle: 'active',
      defaultAssetPackId: 'tochi-v1',
    })
    const manifest = CharacterAssetManifestSchema.parse({
      ...baseManifest,
      assetPackId: 'tochi-v1',
      version: '1.0.0',
      artStatus: 'approved',
      publishable: true,
      attribution: 'Internal-only attribution detail.',
      internalHandoffNotes: 'Internal-only production notes.',
    })
    const projection = createPublicCharacterProjection(definition, manifest)
    expect(projection).toMatchObject({
      characterId: 'tochi',
      assetPackId: 'tochi-v1',
      assetPackVersion: '1.0.0',
    })
    expect(projection).not.toHaveProperty('attribution')
    expect(projection).not.toHaveProperty('internalHandoffNotes')
    expect(projection?.assets[0]).not.toHaveProperty('sha256')
  })

  it('defines voice-ready events without enabling microphone or audio transport', () => {
    expect(
      VoiceProfileDefinitionSchema.parse({
        id: 'future-tochi-en-us',
        label: 'Future Tochi voice',
        locale: 'en-US',
        supportsInput: true,
        supportsOutput: true,
        supportsInterruption: true,
        captionsRequired: true,
      }),
    ).toMatchObject({ captionsRequired: true })
    expect(VoiceSessionEventSchema.parse({ type: 'audio-level', level: 0.4 })).toEqual({
      type: 'audio-level',
      level: 0.4,
    })
    expect(VoiceSessionEventSchema.safeParse({ type: 'audio-level', level: 2 }).success).toBe(false)
  })
})
