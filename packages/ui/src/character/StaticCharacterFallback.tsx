'use client'

import { useEffect, useMemo, useState } from 'react'

import styles from './character.module.css'
import { findCharacterAsset, getCharacterAssetSource } from './character-assets'
import type {
  CharacterAssetError,
  CharacterRenderableManifest,
  CharacterSize,
} from './character-types'

export type StaticCharacterFallbackProps = {
  manifest: CharacterRenderableManifest
  preferredAssetId?: string | undefined
  size?: CharacterSize | undefined
  className?: string | undefined
  onAssetError?: ((error: CharacterAssetError) => void) | undefined
}

type FallbackCandidate = {
  id: string
  source?: string
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
    return [...packCandidates, { id: 'torchiko-brand', kind: 'brand' } as const]
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
      {candidate.kind === 'brand' ? (
        <span className="inline-flex h-full w-full items-center justify-center px-2 text-center text-[clamp(0.65rem,2vw,0.9rem)] font-semibold leading-tight tracking-tight text-pf-deep">
          Torchiko
        </span>
      ) : (
        <img
          className={styles.staticImage}
          src={candidate.source}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          onError={() => {
            onAssetError?.({
              code: 'static-load-failed',
              message: 'A static character fallback could not be loaded.',
              assetId: candidate.id,
              path: candidate.source!,
            })
            setCandidateIndex((current) => current + 1)
          }}
        />
      )}
    </span>
  )
}
