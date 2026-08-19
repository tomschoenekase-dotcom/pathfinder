import { describe, expect, it } from 'vitest'

import {
  CharacterAssetManifestSchema,
  CharacterDefinitionSchema,
  type CharacterRegistryEntry,
} from '@pathfinder/contracts/character-system'

import {
  resolveApprovedCharacterProjection,
  resolveSystemCharacterProjection,
} from './character-registry'

const approvedEntry: CharacterRegistryEntry = {
  definition: CharacterDefinitionSchema.parse({
    schemaVersion: 1,
    id: 'tochi',
    displayName: 'Tochi',
    description: 'Approved test definition.',
    source: 'system',
    lifecycle: 'active',
    defaultAssetPackId: 'tochi-v1',
    supportedContexts: ['client-assistant', 'venue-text-chat'],
    capabilities: ['static'],
    tags: [],
  }),
  manifests: [
    CharacterAssetManifestSchema.parse({
      schemaVersion: 1,
      characterId: 'tochi',
      assetPackId: 'tochi-v1',
      version: '1.0.0',
      renderer: 'static-image-v1',
      artStatus: 'approved',
      publishable: true,
      publicBasePath: '/characters/tochi/1.0.0',
      assets: [
        {
          id: 'static',
          path: 'static.svg',
          mediaType: 'image/svg+xml',
          width: 320,
          height: 360,
          bytes: 1024,
        },
      ],
      canvas: { width: 320, height: 360 },
      safeBounds: { x: 0, y: 0, width: 320, height: 360 },
      origin: { x: 160, y: 340 },
      anchors: { lookAt: { x: 160, y: 160 }, embers: { x: 160, y: 300 } },
      thumbnailAssetId: 'static',
      selectionPreviewAssetId: 'static',
      staticFallbackAssetId: 'static',
      reducedMotionFallbackAssetId: 'static',
      layers: {},
      states: {},
      stateFallbacks: {},
      supportedThemes: ['light'],
      supportedContexts: ['client-assistant', 'venue-text-chat'],
    }),
  ],
}

describe('trusted system character registry', () => {
  it('does not publish the canonical development placeholder', () => {
    expect(resolveSystemCharacterProjection('tochi')).toBeNull()
  })

  it('returns a sanitized projection only for an approved allowlisted pack', () => {
    const projection = resolveApprovedCharacterProjection([approvedEntry], 'tochi')
    expect(projection).toMatchObject({
      characterId: 'tochi',
      assetPackId: 'tochi-v1',
      renderer: 'static-image-v1',
    })
    expect(JSON.stringify(projection)).not.toMatch(/internal|handoff|attribution|publishable/iu)
    expect(resolveApprovedCharacterProjection([approvedEntry], 'unknown')).toBeNull()
  })
})
