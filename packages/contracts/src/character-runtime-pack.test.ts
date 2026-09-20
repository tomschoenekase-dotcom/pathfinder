import { describe, expect, it } from 'vitest'

import {
  CHARACTER_RUNTIME_PACK_ASSET_MAX_BYTES,
  CHARACTER_RUNTIME_PACK_TOTAL_MAX_BYTES,
  CharacterRuntimePackSchema,
  RuntimePackStateSchema,
  canonicalCharacterRuntimePack,
  createPublicFamilyRig,
} from './character-runtime-pack'
import { CHARACTER_STATES, PublicCharacterProjectionSchema } from './character-system'

const pack = {
  schemaVersion: 1,
  renderer: 'family-rig-v1',
  characterId: 'fixture-bot',
  characterVersion: 1,
  sourceSha256: 'a'.repeat(64),
  family: 'morph-v1',
  capability: 'rigid-source',
  assets: [
    {
      id: 'body',
      path: 'body.svg',
      mediaType: 'image/svg+xml',
      width: 64,
      height: 64,
      bytes: 100,
      sha256: 'b'.repeat(64),
    },
  ],
  canvas: { width: 64, height: 64 },
  safeBounds: { x: 0, y: 0, width: 64, height: 64 },
  origin: { x: 32, y: 32 },
  anchors: { lookAt: { x: 32, y: 20 }, embers: { x: 32, y: 40 } },
  sourceAssetId: 'body',
  staticFallbackAssetId: 'body',
  reducedMotionFallbackAssetId: 'body',
  layers: [{ role: 'body', assetId: 'body' }],
  supportedStates: [...RuntimePackStateSchema.options],
  stateFallbacks: {},
  supportedContexts: ['venue-text-chat'],
}

describe('prepared character runtime pack', () => {
  it('uses the existing public semantic vocabulary and preserves canonical array order', () => {
    expect(RuntimePackStateSchema.options).toEqual(CHARACTER_STATES)
    const parsed = CharacterRuntimePackSchema.parse(pack)
    expect(canonicalCharacterRuntimePack(parsed)).toBe(
      canonicalCharacterRuntimePack({ ...parsed, canvas: { height: 64, width: 64 } }),
    )
    expect(canonicalCharacterRuntimePack(parsed)).not.toBe(
      canonicalCharacterRuntimePack({
        ...parsed,
        supportedStates: [...parsed.supportedStates].reverse(),
      }),
    )
  })
  it('accepts one MiB assets at the boundary and rejects per-asset and aggregate overflow', () => {
    const asset = (id: string, path: string, bytes: number) => ({
      ...pack.assets[0],
      id,
      path,
      bytes,
    })
    const boundary = {
      ...pack,
      assets: [
        asset('source', 'source.svg', CHARACTER_RUNTIME_PACK_ASSET_MAX_BYTES),
        asset('fallback', 'fallback.svg', CHARACTER_RUNTIME_PACK_ASSET_MAX_BYTES),
      ],
      sourceAssetId: 'source',
      staticFallbackAssetId: 'fallback',
      reducedMotionFallbackAssetId: 'fallback',
      layers: [
        { role: 'body' as const, assetId: 'source' },
        { role: 'shadow' as const, assetId: 'fallback' },
      ],
    }
    expect(boundary.assets.reduce((sum, item) => sum + item.bytes, 0)).toBe(
      CHARACTER_RUNTIME_PACK_TOTAL_MAX_BYTES,
    )
    expect(CharacterRuntimePackSchema.safeParse(boundary).success).toBe(true)
    expect(
      CharacterRuntimePackSchema.safeParse({
        ...boundary,
        assets: [
          asset('source', 'source.svg', CHARACTER_RUNTIME_PACK_ASSET_MAX_BYTES + 1),
          asset('fallback', 'fallback.svg', 1),
        ],
      }).success,
    ).toBe(false)
    const aggregateOverflow = {
      ...boundary,
      assets: [
        asset('source', 'source.svg', CHARACTER_RUNTIME_PACK_ASSET_MAX_BYTES),
        asset('fallback', 'fallback.svg', CHARACTER_RUNTIME_PACK_ASSET_MAX_BYTES),
        asset('extra', 'extra.svg', CHARACTER_RUNTIME_PACK_ASSET_MAX_BYTES),
      ],
      layers: [
        { role: 'body' as const, assetId: 'source' },
        { role: 'shadow' as const, assetId: 'fallback' },
        { role: 'head' as const, assetId: 'extra' },
      ],
    }
    expect(CharacterRuntimePackSchema.safeParse(aggregateOverflow).success).toBe(false)
  })
  it.each([
    { ...pack, publication: { approved: true } },
    { ...pack, family: 'custom:unreviewed' },
    { ...pack, sourceUrl: 'https://private.invalid/source' },
    { ...pack, safeBounds: { x: 1, y: 0, width: 64, height: 64 } },
    { ...pack, assets: [{ ...pack.assets[0], path: '../source.svg' }] },
    { ...pack, assets: [{ ...pack.assets[0], width: 63 }] },
    { ...pack, assets: [pack.assets[0], pack.assets[0]] },
    { ...pack, sourceAssetId: 'missing' },
    {
      ...pack,
      supportedStates: ['idle'],
      stateFallbacks: { speaking: 'thinking', thinking: 'speaking' },
    },
    { ...pack, supportedStates: ['idle'], stateFallbacks: {} },
  ])('rejects unsupported or inconsistent prepared inputs', (input) => {
    expect(CharacterRuntimePackSchema.safeParse(input).success).toBe(false)
  })
  it('requires an explicit matching family projection and disallows family data on legacy renderers', () => {
    const familyRig = CharacterRuntimePackSchema.parse(pack)
    const projection = {
      characterId: familyRig.characterId,
      displayName: 'Fixture',
      assetPackId: 'export-1',
      assetPackVersion: '1',
      renderer: 'family-rig-v1',
      publicBasePath: '/characters/fixture-bot/1',
      familyRig: createPublicFamilyRig(familyRig),
      assets: familyRig.assets.map(({ id, path, mediaType, width, height, bytes }) => ({
        id,
        path,
        mediaType,
        width,
        height,
        bytes,
      })),
      canvas: familyRig.canvas,
      anchors: familyRig.anchors,
      staticFallbackAssetId: 'body',
      reducedMotionFallbackAssetId: 'body',
      layers: {},
      states: Object.fromEntries(
        familyRig.supportedStates.map((state) => [state, { variant: state.toLowerCase() }]),
      ),
      stateFallbacks: {},
      supportedContexts: familyRig.supportedContexts,
    }
    expect(PublicCharacterProjectionSchema.safeParse(projection).success).toBe(true)
    expect(JSON.stringify(PublicCharacterProjectionSchema.parse(projection))).not.toContain(
      'sourceSha256',
    )
    expect(JSON.stringify(PublicCharacterProjectionSchema.parse(projection))).not.toContain(
      'characterVersion',
    )
    expect(PublicCharacterProjectionSchema.safeParse({ ...projection, familyRig }).success).toBe(
      false,
    )
    expect(
      PublicCharacterProjectionSchema.safeParse({ ...projection, familyRig: undefined }).success,
    ).toBe(false)
    expect(
      PublicCharacterProjectionSchema.safeParse({ ...projection, renderer: 'static-image-v1' })
        .success,
    ).toBe(false)
    expect(
      PublicCharacterProjectionSchema.safeParse({
        ...projection,
        assets: [{ ...projection.assets[0], path: 'other.svg' }],
      }).success,
    ).toBe(false)
  })
})
