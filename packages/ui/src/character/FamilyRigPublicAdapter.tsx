'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type {
  CharacterState,
  PublicCharacterProjection,
} from '@pathfinder/contracts/character-system'

import { FamilyRigRenderer, type FamilyRigRendererProps } from './FamilyRigRenderer'
import { StaticCharacterFallback } from './StaticCharacterFallback'
import { findCharacterAsset, getCharacterAssetSource } from './character-assets'
import styles from './family-rig-public-adapter.module.css'
import type { CharacterAssetError, CharacterMotion, CharacterSize } from './character-types'

type FamilyRigPublicAdapterProps = {
  projection: PublicCharacterProjection
  state: CharacterState
  motion: CharacterMotion
  size?: CharacterSize | undefined
  intensity?: number | undefined
  onAssetError?: ((error: CharacterAssetError) => void) | undefined
}

export function resolvePublicFamilyRigAssets(
  projection: PublicCharacterProjection,
): Pick<FamilyRigRendererProps, 'source' | 'fallbackSource' | 'family' | 'layers'> | null {
  const pack = projection.familyRig
  if (projection.renderer !== 'family-rig-v1' || !pack) return null

  const sourceAsset = findCharacterAsset(projection, pack.sourceAssetId)
  const fallbackAsset = findCharacterAsset(projection, pack.staticFallbackAssetId)
  const layers = pack.layers.map(({ role, assetId }) => {
    const asset = findCharacterAsset(projection, assetId)
    return asset ? { role, source: getCharacterAssetSource(projection, asset) } : null
  })
  if (!sourceAsset || !fallbackAsset || layers.some((layer) => layer === null)) return null

  return {
    source: getCharacterAssetSource(projection, sourceAsset),
    fallbackSource: getCharacterAssetSource(projection, fallbackAsset),
    family: pack.family,
    layers: layers.filter((layer): layer is NonNullable<typeof layer> => layer !== null),
  }
}

export function FamilyRigPublicAdapter({ projection, ...props }: FamilyRigPublicAdapterProps) {
  return (
    <FamilyRigPublicAdapterScope
      key={`${projection.assetPackId}@${projection.assetPackVersion}:${projection.publicBasePath}`}
      projection={projection}
      {...props}
    />
  )
}

function FamilyRigPublicAdapterScope({
  projection,
  state,
  motion,
  size = 'standard',
  intensity,
  onAssetError,
}: FamilyRigPublicAdapterProps) {
  const assets = useMemo(() => resolvePublicFamilyRigAssets(projection), [projection])
  const frameRef = useRef<HTMLSpanElement>(null)
  const familyFailureCount = useRef(0)
  const [missedInitialFailure, setMissedInitialFailure] = useState(false)
  const onAssetErrorRef = useRef(onAssetError)
  onAssetErrorRef.current = onAssetError
  useEffect(() => {
    if (assets) return
    onAssetErrorRef.current?.({
      code: 'unsupported-renderer',
      message: `Character ${projection.characterId} has an invalid family runtime pack.`,
    })
  }, [assets, projection.characterId])

  useLayoutEffect(() => {
    if (!assets || missedInitialFailure) return
    const missedFailure = Array.from(frameRef.current?.querySelectorAll('img') ?? []).some(
      (image) => image.complete && image.naturalWidth === 0,
    )
    if (!missedFailure || familyFailureCount.current > 0) return
    familyFailureCount.current = 1
    setMissedInitialFailure(true)
    onAssetErrorRef.current?.({
      code: 'layer-load-failed',
      message: `Character ${projection.characterId} could not load its verified family assets.`,
    })
  }, [assets, missedInitialFailure, projection.characterId])

  if (!assets) return null

  if (missedInitialFailure) {
    return (
      <StaticCharacterFallback
        manifest={projection}
        preferredAssetId={projection.familyRig?.staticFallbackAssetId}
        size={size}
        onAssetError={onAssetError}
      />
    )
  }

  return (
    <span
      ref={frameRef}
      className={[styles.frame, styles[size]].join(' ')}
      style={{ aspectRatio: `${projection.canvas.width} / ${projection.canvas.height}` }}
      data-character-family-frame={size}
    >
      <FamilyRigRenderer
        {...assets}
        className={styles.surface}
        name={projection.displayName}
        state={state}
        motion={motion}
        intensity={intensity}
        onAssetError={() => {
          familyFailureCount.current += 1
          onAssetError?.({
            code: 'layer-load-failed',
            message: `Character ${projection.characterId} could not load its verified family assets.`,
          })
        }}
      />
    </span>
  )
}
