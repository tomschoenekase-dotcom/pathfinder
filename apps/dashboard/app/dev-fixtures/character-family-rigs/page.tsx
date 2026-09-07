import { readFileSync } from 'node:fs'
import path from 'node:path'
import { notFound } from 'next/navigation'

import { CharacterStateSchema, type CharacterState } from '@pathfinder/contracts/character-system'
import type { FamilyRigLayerRole, FamilyRigName } from '@pathfinder/ui/character'

import { CharacterFamilyRigGrid } from './CharacterFamilyRigGrid'

type Fixture = {
  name: string
  family: FamilyRigName
  source: string
  fallback: string
  layers: readonly { source: string; role: FamilyRigLayerRole }[]
  capability: string
}

function fixtureFile(relativePath: string): string {
  const repositoryRoot = process.cwd().endsWith(path.join('apps', 'dashboard'))
    ? path.resolve(process.cwd(), '../..')
    : process.cwd()
  return readFileSync(
    path.join(repositoryRoot, 'packages/character-factory/fixtures', relativePath),
    'utf8',
  )
}

function svgData(relativePath: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(fixtureFile(relativePath)).toString('base64')}`
}

function fixtures(): Fixture[] {
  return [
    {
      name: 'Neutral owl',
      family: 'compact-creature-v1',
      source: svgData('source/owl.svg'),
      fallback: svgData('source/owl.svg'),
      layers: [
        { role: 'body', source: svgData('segmented/owl/body.svg') },
        { role: 'wing', source: svgData('segmented/owl/wing.svg') },
        { role: 'face', source: svgData('segmented/owl/face.svg') },
      ],
      capability: 'Separate wing pivot and face over a compact body.',
    },
    {
      name: 'Neutral astronaut',
      family: 'humanoid-v1',
      source: svgData('source/astronaut.svg'),
      fallback: svgData('source/astronaut.svg'),
      layers: [
        { role: 'torso', source: svgData('segmented/astronaut/torso.svg') },
        { role: 'head', source: svgData('segmented/astronaut/head.svg') },
      ],
      capability: 'Separate helmet/head nod over a stable torso; no false arm articulation.',
    },
    {
      name: 'Neutral morph',
      family: 'morph-v1',
      source: svgData('source/morph.svg'),
      fallback: svgData('source/morph.svg'),
      layers: [
        { role: 'body', source: svgData('segmented/morph/body.svg') },
        { role: 'face', source: svgData('segmented/morph/face.svg') },
      ],
      capability: 'Body squash and stretch with independently stabilized facial marks.',
    },
  ]
}

function stateFrom(value: string | string[] | undefined): CharacterState {
  const result = CharacterStateSchema.safeParse(Array.isArray(value) ? value[0] : value)
  return result.success ? result.data : 'speaking'
}

export default async function CharacterFamilyRigsFixture({
  searchParams,
}: {
  searchParams: Promise<{
    state?: string | string[]
    motion?: string | string[]
    failure?: string | string[]
  }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const query = await searchParams
  const state = stateFrom(query.state)
  const motion =
    (Array.isArray(query.motion) ? query.motion[0] : query.motion) === 'reduced'
      ? 'reduced'
      : 'full'
  const failure = Array.isArray(query.failure) ? query.failure[0] : query.failure

  return (
    <main className="min-h-screen bg-[#f4f0e6] px-4 py-10 text-[#17241f] sm:px-8 lg:py-16">
      <div className="mx-auto max-w-6xl">
        <header className="grid items-end gap-5 border-b border-[#aeb9ac] pb-7 md:grid-cols-[1fr_auto]">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#946224]">
              P07 React fixture · imported segmented sources
            </p>
            <h1 className="mt-3 max-w-[15ch] font-serif text-4xl leading-none tracking-[-0.04em] sm:text-6xl">
              One language, three bodies.
            </h1>
          </div>
          <p className="text-sm text-[#46544e]" aria-live="polite">
            Semantic state: <strong className="text-[#17241f]">{state}</strong>
            <br />
            Motion: {motion}
          </p>
        </header>

        <CharacterFamilyRigGrid
          fixtures={fixtures()}
          state={state}
          motion={motion}
          failure={failure}
        />
        <p className="mt-7 max-w-3xl text-sm leading-6 text-[#46544e]">
          These are attributed OpenMoji-derived architecture fixtures. The actual React component
          renders deterministic layers and family-specific motion. They are not final art or a Tochi
          selection.
        </p>
      </div>
    </main>
  )
}
