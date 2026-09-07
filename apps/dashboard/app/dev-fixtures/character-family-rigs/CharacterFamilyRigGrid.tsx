'use client'

import { useEffect, useState } from 'react'
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
}: {
  fixtures: readonly FamilyRigFixture[]
  state: CharacterState
  motion: 'reduced' | 'full'
  failure?: string | undefined
}) {
  const [simulateFailure, setSimulateFailure] = useState(false)
  useEffect(() => setSimulateFailure(Boolean(failure)), [failure])
  return (
    <section
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
            source={fixture.source}
            fallbackSource={
              simulateFailure && failure === 'double' ? '/missing-fallback.svg' : fixture.fallback
            }
            layers={
              simulateFailure
                ? fixture.layers.map((layer) => ({ ...layer, source: '/missing-layer.svg' }))
                : fixture.layers
            }
            className="mx-auto block"
          />
          <h2 className="mt-5 font-serif text-2xl">{fixture.name.replace('Neutral ', '')}</h2>
          <p className="mt-1 font-mono text-xs text-[#56615a]">{fixture.family}</p>
          <p className="mt-4 text-sm leading-6 text-[#46544e]">{fixture.capability}</p>
        </article>
      ))}
    </section>
  )
}
