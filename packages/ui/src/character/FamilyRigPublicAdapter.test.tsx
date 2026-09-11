import { describe, expect, it } from 'vitest'

import { PublicCharacterProjectionSchema } from '@pathfinder/contracts/character-system'
import {
  CharacterRuntimePackSchema,
  createPublicFamilyRig,
} from '@pathfinder/contracts/character-runtime-pack'

import { resolvePublicFamilyRigAssets } from './FamilyRigPublicAdapter'

function projection() {
  const familyRig = CharacterRuntimePackSchema.parse({
    schemaVersion: 1,
    renderer: 'family-rig-v1',
    characterId: 'museum-guide',
    characterVersion: 3,
    sourceSha256: 'a'.repeat(64),
    family: 'compact-creature-v1',
    capability: 'rigid-source',
    assets: [
      {
        id: 'source',
        path: 'source.svg',
        mediaType: 'image/svg+xml',
        width: 320,
        height: 360,
        bytes: 100,
        sha256: 'b'.repeat(64),
      },
      {
        id: 'fallback',
        path: 'fallback.svg',
        mediaType: 'image/svg+xml',
        width: 320,
        height: 360,
        bytes: 100,
        sha256: 'c'.repeat(64),
      },
      {
        id: 'body',
        path: 'layers/body.svg',
        mediaType: 'image/svg+xml',
        width: 320,
        height: 360,
        bytes: 100,
        sha256: 'd'.repeat(64),
      },
      {
        id: 'wing',
        path: 'layers/wing.svg',
        mediaType: 'image/svg+xml',
        width: 320,
        height: 360,
        bytes: 100,
        sha256: 'e'.repeat(64),
      },
    ],
    canvas: { width: 320, height: 360 },
    safeBounds: { x: 8, y: 8, width: 304, height: 344 },
    origin: { x: 160, y: 340 },
    anchors: { lookAt: { x: 160, y: 140 }, embers: { x: 160, y: 320 } },
    sourceAssetId: 'source',
    staticFallbackAssetId: 'fallback',
    reducedMotionFallbackAssetId: 'fallback',
    layers: [
      { role: 'body', assetId: 'body' },
      { role: 'wing', assetId: 'wing' },
    ],
    supportedStates: ['idle', 'speaking'],
    stateFallbacks: {
      attention: 'idle',
      listening: 'idle',
      thinking: 'idle',
      success: 'idle',
      processing: 'idle',
      uploadReceiving: 'idle',
      uploadComplete: 'idle',
      question: 'idle',
      handoff: 'idle',
      error: 'idle',
      sleeping: 'idle',
      minimized: 'idle',
    },
    supportedContexts: ['venue-text-chat'],
  })
  return PublicCharacterProjectionSchema.parse({
    characterId: familyRig.characterId,
    displayName: 'Museum Guide',
    assetPackId: 'museum-guide-v3',
    assetPackVersion: '3.0.0',
    renderer: familyRig.renderer,
    familyRig: createPublicFamilyRig(familyRig),
    publicBasePath: '/characters/museum-guide/3.0.0',
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
    staticFallbackAssetId: familyRig.staticFallbackAssetId,
    reducedMotionFallbackAssetId: familyRig.reducedMotionFallbackAssetId,
    layers: {},
    states: { idle: { variant: 'idle' }, speaking: { variant: 'speaking' } },
    stateFallbacks: familyRig.stateFallbacks,
    supportedContexts: familyRig.supportedContexts,
  })
}

describe('public family rig adapter', () => {
  it('maps the immutable runtime pack to same-origin ordered renderer assets', () => {
    expect(resolvePublicFamilyRigAssets(projection())).toEqual({
      source: '/characters/museum-guide/3.0.0/source.svg',
      fallbackSource: '/characters/museum-guide/3.0.0/fallback.svg',
      family: 'compact-creature-v1',
      layers: [
        { role: 'body', source: '/characters/museum-guide/3.0.0/layers/body.svg' },
        { role: 'wing', source: '/characters/museum-guide/3.0.0/layers/wing.svg' },
      ],
    })
  })

  it('does not adapt a legacy public projection', () => {
    const value = projection()
    expect(
      resolvePublicFamilyRigAssets(
        PublicCharacterProjectionSchema.parse({
          ...value,
          renderer: 'static-image-v1',
          familyRig: undefined,
        }),
      ),
    ).toBeNull()
  })
})
