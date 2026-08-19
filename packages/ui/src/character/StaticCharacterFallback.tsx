'use client'

import { useEffect, useMemo, useState } from 'react'

import styles from './character.module.css'
import { findCharacterAsset, getCharacterAssetSource } from './character-assets'
import type {
  CharacterAssetError,
  CharacterRenderableManifest,
  CharacterSize,
} from './character-types'

const NEUTRAL_TORCHIKO_BRAND_SOURCE = '/torchiko-logo.svg'

export type StaticCharacterFallbackProps = {
  manifest: CharacterRenderableManifest
  preferredAssetId?: string | undefined
  size?: CharacterSize | undefined
  className?: string | undefined
  onAssetError?: ((error: CharacterAssetError) => void) | undefined
}

type FallbackCandidate = {
  id: string
  source: string
  kind: 'pack' | 'brand'
}

export function StaticCharacterFallback({
  manifest,
  preferredAssetId,
  size = 'standard',
  className,
  onAssetError,
}: StaticCharacterFallbackProps) {
  const candidates = useMemo(() => {
    const assetIds = [preferredAssetId, manifest.staticFallbackAssetId].filter(
      (assetId, index, values): assetId is string =>
        Boolean(assetId) && values.indexOf(assetId) === index,
    )
    const packCandidates = assetIds.flatMap((assetId): FallbackCandidate[] => {
      const asset = findCharacterAsset(manifest, assetId)
      return asset
        ? [{ id: asset.id, source: getCharacterAssetSource(manifest, asset), kind: 'pack' }]
        : []
    })
    return [
      ...packCandidates,
      { id: 'torchiko-brand', source: NEUTRAL_TORCHIKO_BRAND_SOURCE, kind: 'brand' } as const,
    ]
  }, [manifest, preferredAssetId])
  const [candidateIndex, setCandidateIndex] = useState(0)

  useEffect(() => setCandidateIndex(0), [candidates])

  const candidate = candidates[candidateIndex]
  if (!candidate) return null

  return (
    <span
      className={[styles.presence, styles[size], styles.staticPresence, className]
        .filter(Boolean)
        .join(' ')}
      data-character-fallback={candidate.kind}
      aria-hidden="true"
    >
      <img
        className={styles.staticImage}
        src={candidate.source}
        alt=""
        aria-hidden="true"
        draggable={false}
        decoding="async"
        onError={() => {
          onAssetError?.({
            code: candidate.kind === 'brand' ? 'brand-load-failed' : 'static-load-failed',
            message:
              candidate.kind === 'brand'
                ? 'The neutral Torchiko brand fallback could not be loaded.'
                : 'A static character fallback could not be loaded.',
            assetId: candidate.id,
            path: candidate.source,
          })
          setCandidateIndex((current) => current + 1)
        }}
      />
    </span>
  )
}
