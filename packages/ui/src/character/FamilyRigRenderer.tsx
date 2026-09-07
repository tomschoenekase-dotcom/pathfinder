'use client'

import { useState, type CSSProperties } from 'react'

import type { CharacterState } from '@pathfinder/contracts/character-system'

import styles from './family-rig.module.css'

export type FamilyRigName = 'morph-v1' | 'compact-creature-v1' | 'humanoid-v1'
export type FamilyRigLayerRole = 'body' | 'face' | 'head' | 'wing' | 'torso' | 'accent'

export type FamilyRigRendererProps = {
  name: string
  source: string
  fallbackSource: string
  family: FamilyRigName
  state: CharacterState
  motion: 'system' | 'reduced' | 'full'
  layers?: readonly { source: string; role: FamilyRigLayerRole }[] | undefined
  intensity?: number | undefined
  className?: string | undefined
  onAssetError?: (() => void) | undefined
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.6
}

export function resolveFamilyRigMotion(
  motion: FamilyRigRendererProps['motion'],
  failed: boolean,
): FamilyRigRendererProps['motion'] {
  return failed || motion === 'reduced' ? 'reduced' : motion
}

/**
 * Architecture-proof renderer for normalized whole-image skins.
 *
 * It intentionally declares `rigid-source` capability. Family choreography is meaningful motion
 * organization, but does not claim that an unsegmented source has articulated wings, arms, or face.
 */
export function FamilyRigRenderer({
  name,
  source,
  fallbackSource,
  family,
  state,
  motion,
  layers,
  intensity = 0.6,
  className,
  onAssetError,
}: FamilyRigRendererProps) {
  const layerKey = layers?.map((layer) => `${layer.role}:${layer.source}`).join('|')
  const assetIdentity = `${source}|${fallbackSource}|${layerKey ?? ''}`
  const [assetStates, setAssetStates] = useState<
    Record<string, { failed: boolean; fallbackFailed: boolean }>
  >({})
  const assetState = assetStates[assetIdentity]
  const failed = assetState?.failed ?? false
  const fallbackFailed = assetState?.fallbackFailed ?? false
  const resolvedMotion = resolveFamilyRigMotion(motion, failed)
  const style = { '--family-rig-intensity': String(clamp(intensity)) } as CSSProperties

  return (
    <span
      className={[styles.rig, styles[family], className].filter(Boolean).join(' ')}
      style={style}
      role="img"
      aria-label={`${name}: ${state}`}
      data-rig-family={family}
      data-rig-state={state}
      data-rig-motion={resolvedMotion}
      data-asset-capability="rigid-source"
    >
      <span className={styles.stage} aria-hidden="true">
        {fallbackFailed ? (
          <span className={styles.neutralFallback}>T</span>
        ) : failed ? (
          <img
            className={styles.skin}
            src={fallbackSource}
            alt=""
            draggable={false}
            decoding="async"
            onError={() => {
              setAssetStates((current) => ({
                ...current,
                [assetIdentity]: { failed: true, fallbackFailed: true },
              }))
              onAssetError?.()
            }}
          />
        ) : !layers?.length ? (
          <img
            className={styles.skin}
            src={source}
            alt=""
            draggable={false}
            decoding="async"
            onError={() => {
              setAssetStates((current) => ({
                ...current,
                [assetIdentity]: { failed: true, fallbackFailed: false },
              }))
              onAssetError?.()
            }}
          />
        ) : (
          <span className={styles.layerStack}>
            {layers.map((layer) => (
              <img
                key={`${layer.role}:${layer.source}`}
                className={[styles.layer, styles[`layer_${layer.role}`]].join(' ')}
                data-rig-layer={layer.role}
                src={layer.source}
                alt=""
                draggable={false}
                decoding="async"
                onError={() => {
                  setAssetStates((current) => ({
                    ...current,
                    [assetIdentity]: { failed: true, fallbackFailed: false },
                  }))
                  onAssetError?.()
                }}
              />
            ))}
          </span>
        )}
        <span className={styles.ground} />
      </span>
    </span>
  )
}
