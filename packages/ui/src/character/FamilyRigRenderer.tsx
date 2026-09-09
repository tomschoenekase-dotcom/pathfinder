'use client'

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

import type { CharacterState } from '@pathfinder/contracts/character-system'

import styles from './family-rig.module.css'

export type FamilyRigName = 'morph-v1' | 'compact-creature-v1' | 'humanoid-v1'
export type FamilyRigFamily = FamilyRigName | `custom:${string}`
export type FamilyRigLayerRole = string

export type FamilyRigRendererProps = {
  name: string
  source: string
  fallbackSource: string
  family: FamilyRigFamily
  state: CharacterState
  motion: 'system' | 'reduced' | 'full'
  layers?: readonly { source: string; role: FamilyRigLayerRole }[] | undefined
  rigCapabilities?:
    | {
        familyId: FamilyRigFamily
        stateControls: Partial<Record<CharacterState, readonly string[]>>
      }
    | undefined
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

export function familyRigAssetIdentity({
  source,
  fallbackSource,
  layers,
}: Pick<FamilyRigRendererProps, 'source' | 'fallbackSource' | 'layers'>): string {
  return JSON.stringify([
    source,
    fallbackSource,
    layers?.map((layer) => [layer.role, layer.source]) ?? null,
  ])
}

export function familyRigLayerIdentity(
  layer: { role: FamilyRigLayerRole; source: string },
  index: number,
): string {
  // Include position so even repeated identical layers have distinct React keys.
  return JSON.stringify([index, layer.role, layer.source])
}

/**
 * Architecture-proof renderer for normalized whole-image skins.
 *
 * It intentionally declares `rigid-source` capability. Family choreography is meaningful motion
 * organization, but does not claim that an unsegmented source has articulated wings, arms, or face.
 */
export function FamilyRigRenderer(props: FamilyRigRendererProps) {
  // Only the current configuration owns state. A revisit gets a fresh scope;
  // cleanup also fences callbacks from an earlier visit to the same identity.
  return <FamilyRigScope key={familyRigAssetIdentity(props)} {...props} />
}

function FamilyRigScope({
  name,
  source,
  fallbackSource,
  family,
  state,
  motion,
  layers,
  rigCapabilities,
  intensity = 0.6,
  className,
  onAssetError,
}: FamilyRigRendererProps) {
  const [failureStage, setFailureStage] = useState<0 | 1 | 2>(0)
  const lifecycle = useRef({ active: false, stage: 0, onAssetError })

  useLayoutEffect(() => {
    const current = lifecycle.current
    current.active = true
    return () => {
      current.active = false
    }
  }, [])

  useLayoutEffect(() => {
    lifecycle.current.onAssetError = onAssetError
  }, [onAssetError])

  function fail(nextStage: 1 | 2) {
    const current = lifecycle.current
    if (!current.active || nextStage <= current.stage) return
    // Advance synchronously before notifying the parent: duplicate/batched or
    // reentrant errors cannot downgrade fallback failure or notify twice.
    current.stage = nextStage
    setFailureStage(nextStage)
    current.onAssetError?.()
  }

  const failed = failureStage > 0
  const fallbackFailed = failureStage === 2
  const resolvedMotion = resolveFamilyRigMotion(motion, failed)
  const style = { '--family-rig-intensity': String(clamp(intensity)) } as CSSProperties
  const isCustom = family.startsWith('custom:')
  const controls =
    isCustom && rigCapabilities?.familyId === family
      ? (rigCapabilities.stateControls[state] ?? [])
      : []

  return (
    <span
      className={[
        styles.rig,
        styles[family] ?? (isCustom ? styles.customRig : undefined),
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      role="img"
      aria-label={`${name}: ${state}`}
      data-rig-family={family}
      data-rig-state={state}
      data-rig-motion={resolvedMotion}
      data-asset-capability="rigid-source"
      data-rig-controls={controls.join(' ')}
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
            onError={() => fail(2)}
          />
        ) : !layers?.length ? (
          <img
            className={styles.skin}
            src={source}
            alt=""
            draggable={false}
            decoding="async"
            onError={() => fail(1)}
          />
        ) : (
          <span className={styles.layerStack}>
            {layers.map((layer, index) => (
              <img
                key={familyRigLayerIdentity(layer, index)}
                className={[
                  styles.layer,
                  styles[`layer_${layer.role}`] ?? styles.layer_custom,
                ].join(' ')}
                data-rig-layer={layer.role}
                src={layer.source}
                alt=""
                draggable={false}
                decoding="async"
                onError={() => fail(1)}
              />
            ))}
          </span>
        )}
        <span className={styles.ground} />
      </span>
    </span>
  )
}
