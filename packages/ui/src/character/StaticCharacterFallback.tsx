'use client'

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

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
  ...props
}: StaticCharacterFallbackProps) {
  const manifestVersion = 'version' in manifest ? manifest.version : manifest.assetPackVersion
  return (
    <StaticCharacterFallbackScope
      key={JSON.stringify([
        manifest.assetPackId,
        manifestVersion,
        'publicBasePath' in manifest ? manifest.publicBasePath : null,
        preferredAssetId ?? null,
      ])}
      manifest={manifest}
      preferredAssetId={preferredAssetId}
      {...props}
    />
  )
}

function StaticCharacterFallbackScope({
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
  const presenceRef = useRef<HTMLSpanElement>(null)
  const failedCandidates = useRef(new Set<string>())
  const lifecycle = useRef({ active: false })

  useLayoutEffect(() => {
    const current = lifecycle.current
    current.active = true
    return () => {
      current.active = false
    }
  }, [])

  const candidate = candidates[candidateIndex]
  const failCandidate = useCallback(() => {
    if (!lifecycle.current.active || !candidate || candidate.kind !== 'pack') return
    const identity = JSON.stringify([candidateIndex, candidate.id, candidate.source])
    if (failedCandidates.current.has(identity)) return
    failedCandidates.current.add(identity)
    onAssetError?.({
      code: 'static-load-failed',
      message: 'A static character fallback could not be loaded.',
      assetId: candidate.id,
      path: candidate.source!,
    })
    setCandidateIndex((current) => (current === candidateIndex ? current + 1 : current))
  }, [candidate, candidateIndex, onAssetError])

  useLayoutEffect(() => {
    const image = presenceRef.current?.querySelector('img')
    if (image?.complete && image.naturalWidth === 0) failCandidate()
  }, [candidate, failCandidate])

  if (!candidate) return null

  return (
    <span
      ref={presenceRef}
      className={[styles.presence, styles[size], styles.staticPresence, className]
        .filter(Boolean)
        .join(' ')}
      style={
        manifest.canvas
          ? { aspectRatio: `${manifest.canvas.width} / ${manifest.canvas.height}` }
          : undefined
      }
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
          onError={failCandidate}
        />
      )}
    </span>
  )
}
