'use client'

import type { CSSProperties } from 'react'

import type { CharacterState, CharacterStateMapping } from '@pathfinder/contracts/character-system'

import styles from './character.module.css'
import { findCharacterAsset, getCharacterAssetSource } from './character-assets'
import type {
  CharacterAssetError,
  CharacterMotion,
  CharacterRenderableManifest,
  CharacterSize,
} from './character-types'

export type LayeredSvgRendererProps = {
  manifest: CharacterRenderableManifest
  state: CharacterState
  mapping: CharacterStateMapping
  motion: CharacterMotion
  intensity: number
  lookAt: { x: number; y: number }
  size: CharacterSize
  onAssetError?: ((error: CharacterAssetError) => void) | undefined
  onLayerFailure: () => void
}

const layerOrder = ['shadow', 'glow', 'body', 'embers', 'eyes'] as const

export function LayeredSvgRenderer({
  manifest,
  state,
  mapping,
  motion,
  intensity,
  lookAt,
  size,
  onAssetError,
  onLayerFailure,
}: LayeredSvgRendererProps) {
  const style = {
    '--character-intensity': String(intensity),
    '--character-look-x': String(lookAt.x),
    '--character-look-y': String(lookAt.y),
    aspectRatio: `${manifest.canvas.width} / ${manifest.canvas.height}`,
  } as CSSProperties

  const reducedAsset = findCharacterAsset(manifest, manifest.reducedMotionFallbackAssetId)

  return (
    <span
      className={[styles.presence, styles[size], styles.layeredPresence].join(' ')}
      style={style}
      data-character-state={state}
      data-character-variant={mapping.variant}
      data-character-motion={motion}
      aria-hidden="true"
    >
      <span className={styles.layerStack}>
        {layerOrder.flatMap((layerName) => {
          const assetId = manifest.layers[layerName]
          const asset = findCharacterAsset(manifest, assetId)
          if (!asset) return []
          const source = getCharacterAssetSource(manifest, asset)
          return [
            <img
              key={layerName}
              className={[styles.layer, styles[`layer_${layerName}`]].join(' ')}
              data-character-layer={layerName}
              src={source}
              alt=""
              aria-hidden="true"
              draggable={false}
              decoding="async"
              onError={() => {
                onAssetError?.({
                  code: 'layer-load-failed',
                  message: `The ${layerName} character layer could not be loaded.`,
                  assetId: asset.id,
                  path: source,
                })
                onLayerFailure()
              }}
            />,
          ]
        })}
      </span>
      {reducedAsset ? (
        <img
          className={styles.reducedImage}
          src={getCharacterAssetSource(manifest, reducedAsset)}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          onError={() => {
            onAssetError?.({
              code: 'static-load-failed',
              message: 'The reduced-motion character fallback could not be loaded.',
              assetId: reducedAsset.id,
              path: getCharacterAssetSource(manifest, reducedAsset),
            })
            onLayerFailure()
          }}
        />
      ) : null}
    </span>
  )
}
