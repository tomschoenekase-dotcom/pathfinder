import { describe, expect, it, vi } from 'vitest'

import {
  CharacterAssetManifestSchema,
  type CharacterAssetManifest,
} from '@pathfinder/contracts/character-system'

import { LayeredSvgRenderer } from './LayeredSvgRenderer'
import { findCharacterAsset, getCharacterAssetSource } from './character-assets'

function manifest(): CharacterAssetManifest {
  return CharacterAssetManifestSchema.parse({
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
        id: 'eyes',
        path: 'eyes.svg',
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
    layers: { body: 'body', eyes: 'eyes' },
    states: { idle: { variant: 'idle' } },
    stateFallbacks: {},
    supportedThemes: ['default'],
    supportedContexts: ['venue-text-chat'],
  })
}

describe('layered character renderer', () => {
  it('builds local asset URLs from the manifest instead of scattered component paths', () => {
    const pack = manifest()
    const body = findCharacterAsset(pack, 'body')
    expect(body && getCharacterAssetSource(pack, body)).toBe(
      '/characters/tochi/v0-development/body.svg',
    )
  })

  it('keeps visual layers decorative and exposes state only as renderer data', () => {
    const pack = manifest()
    const layerFailure = vi.fn()
    const element = LayeredSvgRenderer({
      manifest: pack,
      state: 'idle',
      mapping: { variant: 'idle' },
      motion: 'system',
      intensity: 0.6,
      lookAt: { x: 0, y: 0 },
      size: 'standard',
      onLayerFailure: layerFailure,
    })

    expect(element.props['aria-hidden']).toBe('true')
    expect(element.props['data-character-state']).toBe('idle')
    expect(element.props['data-character-motion']).toBe('system')

    const children = element.props.children as Array<{ props: Record<string, unknown> }>
    const stack = children[0]
    const layers = stack?.props.children as Array<{ props: Record<string, unknown> }>
    expect(layers).toHaveLength(2)
    expect(layers.every((layer) => layer.props.alt === '')).toBe(true)
    expect(layers.every((layer) => layer.props['aria-hidden'] === 'true')).toBe(true)
  })
})
