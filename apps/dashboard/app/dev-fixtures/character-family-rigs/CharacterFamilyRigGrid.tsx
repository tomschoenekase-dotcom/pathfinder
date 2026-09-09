'use client'

import { useEffect, useRef, useState } from 'react'
import type { CharacterState } from '@pathfinder/contracts/character-system'
import {
  FamilyRigRenderer,
  type FamilyRigLayerRole,
  type FamilyRigName,
} from '@pathfinder/ui/character'

export type FamilyRigFixture = {
  name: string
  family: FamilyRigName
  source: string
  fallback: string
  layers: readonly { source: string; role: FamilyRigLayerRole }[]
  capability: string
}

export function CharacterFamilyRigGrid({
  fixtures,
  state,
  motion,
  failure,
  isolation = false,
}: {
  fixtures: readonly FamilyRigFixture[]
  state: CharacterState
  motion: 'system' | 'reduced' | 'full'
  failure?: string | undefined
  isolation?: boolean
}) {
  const [simulateFailure, setSimulateFailure] = useState(false)
  const [ready, setReady] = useState(false)
  const [configuration, setConfiguration] = useState<'normal' | 'delayed' | 'replacement'>('normal')
  const [notifications, setNotifications] = useState(0)
  const [lateDeliveries, setLateDeliveries] = useState(0)
  const grid = useRef<HTMLElement>(null)
  const retiredImages = useRef<HTMLImageElement[]>([])
  useEffect(() => setSimulateFailure(Boolean(failure)), [failure])
  useEffect(() => setReady(true), [])

  function asset(source: string, name: string): string {
    if (configuration === 'delayed') return `/__character-runtime-delayed__/${name}.svg`
    // Same neutral source bytes; only configuration identity changes.
    return configuration === 'replacement' ? `${source}#runtime-replacement` : source
  }

  return (
    <>
      <section
        ref={grid}
        data-fixture-ready={ready}
        data-fixture-configuration={configuration}
        data-fixture-notifications={notifications}
        data-fixture-late-deliveries={lateDeliveries}
        className="mt-8 grid divide-y divide-[#aeb9ac] border-y border-[#aeb9ac] md:grid-cols-3 md:divide-x md:divide-y-0"
        aria-label="Neutral character rig comparison"
      >
        {fixtures.map((fixture, index) => (
          <article
            key={fixture.family}
            className={`p-6 sm:p-8 ${index === 1 ? 'bg-[#eef1e8]' : 'bg-[#f8f5ed]'}`}
          >
            <FamilyRigRenderer
              name={fixture.name}
              family={fixture.family}
              state={state}
              motion={motion}
              source={asset(fixture.source, `source-${index}`)}
              fallbackSource={
                simulateFailure && failure === 'double'
                  ? `/missing-fallback-${index}.svg`
                  : asset(fixture.fallback, `fallback-${index}`)
              }
              layers={
                simulateFailure
                  ? fixture.layers.map((layer, layerIndex) => ({
                      ...layer,
                      source: `/missing-layer-${index}-${layerIndex}.svg`,
                    }))
                  : fixture.layers.map((layer, layerIndex) => ({
                      ...layer,
                      source: asset(layer.source, `layer-${index}-${layerIndex}`),
                    }))
              }
              onAssetError={() => setNotifications((count) => count + 1)}
              className="mx-auto block"
            />
            <h2 className="mt-5 font-serif text-2xl">{fixture.name.replace('Neutral ', '')}</h2>
            <p className="mt-1 font-mono text-xs text-[#56615a]">{fixture.family}</p>
            <p className="mt-4 text-sm leading-6 text-[#46544e]">{fixture.capability}</p>
          </article>
        ))}
      </section>
      {isolation ? (
        <section className="mt-6 space-y-3" aria-label="Runtime isolation proof controls">
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="min-h-11 rounded border border-current px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => setConfiguration('delayed')}
            >
              Use delayed assets
            </button>
            <button
              type="button"
              className="min-h-11 rounded border border-current px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => {
                retiredImages.current = Array.from(grid.current?.querySelectorAll('img') ?? [])
                setConfiguration('replacement')
              }}
            >
              Use replacement assets
            </button>
            <button
              type="button"
              className="min-h-11 rounded border border-current px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
              disabled={retiredImages.current.length === 0}
              onClick={() => {
                // Native DOM event proof; direct captured React callback proof lives in unit tests.
                retiredImages.current.forEach((image) => image.dispatchEvent(new Event('error')))
                setLateDeliveries((count) => count + retiredImages.current.length)
              }}
            >
              Deliver old image errors
            </button>
            <button
              type="button"
              className="min-h-11 rounded border border-current px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => setConfiguration('normal')}
            >
              Retry original assets
            </button>
          </div>
          <p className="text-sm" role="status">
            Configuration: {configuration}. Asset error notifications: {notifications}. Late native
            errors delivered: {lateDeliveries}.
          </p>
        </section>
      ) : null}
    </>
  )
}
