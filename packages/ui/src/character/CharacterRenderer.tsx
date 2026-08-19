'use client'

import { useEffect, useState } from 'react'

import { resolveCharacterState } from '@pathfinder/contracts/character-system'

import { LayeredSvgRenderer } from './LayeredSvgRenderer'
import { StaticCharacterFallback } from './StaticCharacterFallback'
import { findCharacterAsset } from './character-assets'
import type { CharacterAssetError, CharacterRenderProps } from './character-types'

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(maximum, Math.max(minimum, value))
}

export function CharacterRenderer({
  manifest,
  state,
  motion,
  intensity = 0.6,
  lookAt = { x: 0, y: 0 },
  size = 'standard',
  onAssetError,
}: CharacterRenderProps) {
  const resolution = resolveCharacterState(manifest, state)
  const [layerFailed, setLayerFailed] = useState(false)
  const manifestVersion = 'version' in manifest ? manifest.version : manifest.assetPackVersion

  useEffect(() => {
    setLayerFailed(false)
  }, [manifest.assetPackId, manifestVersion, state])

  if (layerFailed || resolution.kind === 'static' || motion === 'reduced') {
    const preferredAssetId =
      motion === 'reduced'
        ? manifest.reducedMotionFallbackAssetId
        : resolution.kind === 'static'
          ? resolution.assetId
          : resolution.mapping.staticAssetId
    return (
      <StaticCharacterFallback
        manifest={manifest}
        preferredAssetId={preferredAssetId}
        size={size}
        onAssetError={onAssetError}
      />
    )
  }

  if (manifest.renderer === 'layered-svg-v1') {
    return (
      <LayeredSvgRenderer
        manifest={manifest}
        state={resolution.resolvedState}
        mapping={resolution.mapping}
        motion={motion}
        intensity={clamp(intensity, 0, 1)}
        lookAt={{ x: clamp(lookAt.x, -1, 1), y: clamp(lookAt.y, -1, 1) }}
        size={size}
        onAssetError={onAssetError}
        onLayerFailure={() => setLayerFailed(true)}
      />
    )
  }

  if (manifest.renderer === 'static-image-v1') {
    return (
      <StaticCharacterFallback
        manifest={manifest}
        preferredAssetId={
          resolution.mapping.staticAssetId &&
          findCharacterAsset(manifest, resolution.mapping.staticAssetId)
            ? resolution.mapping.staticAssetId
            : manifest.staticFallbackAssetId
        }
        size={size}
        onAssetError={onAssetError}
      />
    )
  }

  onAssetError?.({
    code: 'unsupported-renderer',
    message: `Unsupported character renderer: ${String(manifest.renderer)}`,
  } satisfies CharacterAssetError)
  return <StaticCharacterFallback manifest={manifest} size={size} onAssetError={onAssetError} />
}
