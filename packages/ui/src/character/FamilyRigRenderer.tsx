'use client'

import { useState, type CSSProperties } from 'react'

import styles from './family-rig.module.css'

export const FAMILY_RIG_STATES = [
  'idle',
  'attention',
  'listening',
  'thinking',
  'speaking',
  'happy',
  'sad',
  'success',
  'error',
  'reaction',
] as const

export type FamilyRigState = (typeof FAMILY_RIG_STATES)[number]
export type FamilyRigName = 'morph-v1' | 'compact-creature-v1' | 'humanoid-v1'

export type FamilyRigRendererProps = {
  name: string
  source: string
  fallbackSource: string
  family: FamilyRigName
  state: FamilyRigState
  motion: 'system' | 'reduced' | 'full'
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
  intensity = 0.6,
  className,
  onAssetError,
}: FamilyRigRendererProps) {
  const [failed, setFailed] = useState(false)
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
        <img
          className={styles.skin}
          src={failed ? fallbackSource : source}
          alt=""
          draggable={false}
          decoding="async"
          onError={() => {
            if (!failed) {
              setFailed(true)
              onAssetError?.()
            }
          }}
        />
        <span className={styles.ground} />
      </span>
    </span>
  )
}
