'use client'

import { useEffect, useRef, useState } from 'react'

import type {
  CharacterState,
  PublicCharacterProjection,
} from '@pathfinder/contracts/character-system'
import { resolveCharacterState } from '@pathfinder/contracts/character-system'
import {
  PublicCharacterPresence,
  useCharacterController,
  type CharacterMotion,
  type CharacterSize,
} from '@pathfinder/ui/character'

export function PublicFamilyRigFixture({
  initialProjection,
  delayedProjection,
  replacementProjection,
  requestedState,
  requestedMotion,
  size,
  isolation,
}: {
  initialProjection: PublicCharacterProjection
  delayedProjection: PublicCharacterProjection
  replacementProjection: PublicCharacterProjection
  requestedState: CharacterState
  requestedMotion: CharacterMotion
  size: CharacterSize
  isolation: boolean
}) {
  const [projection, setProjection] = useState(initialProjection)
  const [ready, setReady] = useState(false)
  const [assetErrors, setAssetErrors] = useState(0)
  const [lateDeliveries, setLateDeliveries] = useState(0)
  const stage = useRef<HTMLElement>(null)
  const retiredImages = useRef<HTMLImageElement[]>([])
  const controller = useCharacterController({
    initialState: requestedState,
    motion: requestedMotion,
  })
  const renderedState = resolveCharacterState(projection, controller.state)

  useEffect(() => setReady(true), [])

  return (
    <>
      <section
        ref={stage}
        className="mt-7 grid min-w-0 gap-6 border-y border-[#aeb9ac] bg-[#f8f5ed] p-5 sm:grid-cols-[minmax(0,1fr)_minmax(15rem,0.8fr)] sm:p-8"
        data-fixture-ready={ready}
        data-fixture-asset-pack={projection.assetPackId}
        data-fixture-errors={assetErrors}
        data-fixture-late-deliveries={lateDeliveries}
        aria-label="Published family rig fixture"
      >
        <div className="flex min-h-56 min-w-0 items-center justify-center overflow-visible border border-[#c7cec2] bg-white/60 p-4">
          <PublicCharacterPresence
            projection={projection}
            state={controller.state}
            context="venue-text-chat"
            motion={controller.motion}
            intensity={0.65}
            size={size}
            onAssetError={() => setAssetErrors((current) => current + 1)}
          />
        </div>
        <div className="self-center">
          <p className="font-mono text-xs uppercase tracking-[0.12em] text-[#6a5a42]">
            {projection.assetPackId} · {projection.assetPackVersion}
          </p>
          <h2 className="mt-2 font-serif text-2xl">{projection.displayName}</h2>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="font-semibold">Requested</dt>
            <dd>{requestedState}</dd>
            <dt className="font-semibold">Rendered</dt>
            <dd data-rendered-state>
              {renderedState.kind === 'state' ? renderedState.resolvedState : 'static fallback'}
            </dd>
            <dt className="font-semibold">Motion</dt>
            <dd data-resolved-motion>{controller.motion}</dd>
            <dt className="font-semibold">Canvas</dt>
            <dd>
              {projection.canvas.width} × {projection.canvas.height}
            </dd>
          </dl>
        </div>
      </section>

      {isolation ? (
        <section className="mt-6" aria-label="Public character identity isolation controls">
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="min-h-11 rounded border border-current px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => setProjection(delayedProjection)}
            >
              Use delayed identity
            </button>
            <button
              type="button"
              className="min-h-11 rounded border border-current px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => {
                retiredImages.current = Array.from(stage.current?.querySelectorAll('img') ?? [])
                setProjection(replacementProjection)
              }}
            >
              Publish replacement identity
            </button>
            <button
              type="button"
              disabled={retiredImages.current.length === 0}
              className="min-h-11 rounded border border-current px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
              onClick={() => {
                retiredImages.current.forEach((image) => image.dispatchEvent(new Event('error')))
                setLateDeliveries((current) => current + retiredImages.current.length)
              }}
            >
              Deliver retired errors
            </button>
          </div>
          <p className="mt-3 text-sm" role="status">
            Public pack {projection.assetPackId}. Asset errors {assetErrors}. Retired errors
            delivered {lateDeliveries}.
          </p>
        </section>
      ) : null}
    </>
  )
}
