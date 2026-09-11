import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { notFound } from 'next/navigation'

import {
  CharacterStateSchema,
  PublicCharacterProjectionSchema,
  type CharacterState,
  type PublicCharacterProjection,
} from '@pathfinder/contracts/character-system'
import {
  CharacterRuntimePackSchema,
  createPublicFamilyRig,
} from '@pathfinder/contracts/character-runtime-pack'

import { PublicFamilyRigFixture } from './FixtureClient'

const assetFiles = [
  { id: 'source', path: 'source/owl.svg', fixturePath: 'source/owl.svg' },
  { id: 'body', path: 'layers/body.svg', fixturePath: 'segmented/owl/body.svg' },
  { id: 'wing', path: 'layers/wing.svg', fixturePath: 'segmented/owl/wing.svg' },
  { id: 'face', path: 'layers/face.svg', fixturePath: 'segmented/owl/face.svg' },
] as const

function fixtureRoot() {
  const repositoryRoot = process.cwd().endsWith(path.join('apps', 'dashboard'))
    ? path.resolve(process.cwd(), '../..')
    : process.cwd()
  return path.join(repositoryRoot, 'packages/character-factory/fixtures')
}

function projection(identity: string, version: number): PublicCharacterProjection {
  const assets = assetFiles.map((asset) => {
    const bytes = readFileSync(path.join(fixtureRoot(), asset.fixturePath))
    return {
      id: asset.id,
      path: asset.path,
      mediaType: 'image/svg+xml' as const,
      width: 72,
      height: 72,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  })
  const runtimePack = CharacterRuntimePackSchema.parse({
    schemaVersion: 1,
    renderer: 'family-rig-v1',
    characterId: 'prepared-neutral-owl',
    characterVersion: version,
    sourceSha256: assets[0]!.sha256,
    family: 'compact-creature-v1',
    capability: 'rigid-source',
    assets,
    canvas: { width: 72, height: 72 },
    safeBounds: { x: 6, y: 6, width: 60, height: 60 },
    origin: { x: 36, y: 66 },
    anchors: { lookAt: { x: 36, y: 29 }, embers: { x: 36, y: 60 } },
    sourceAssetId: 'source',
    staticFallbackAssetId: 'source',
    reducedMotionFallbackAssetId: 'source',
    layers: [
      { role: 'body', assetId: 'body' },
      { role: 'wing', assetId: 'wing' },
      { role: 'face', assetId: 'face' },
    ],
    supportedStates: ['idle', 'speaking'],
    stateFallbacks: {
      attention: 'idle',
      listening: 'idle',
      thinking: 'idle',
      success: 'idle',
      processing: 'idle',
      uploadReceiving: 'idle',
      uploadComplete: 'idle',
      question: 'idle',
      handoff: 'idle',
      error: 'idle',
      sleeping: 'idle',
      minimized: 'idle',
    },
    supportedContexts: ['venue-text-chat'],
  })
  return PublicCharacterProjectionSchema.parse({
    characterId: runtimePack.characterId,
    displayName: 'Prepared neutral owl',
    assetPackId: `prepared-neutral-${identity}`,
    assetPackVersion: `${version}.0.0`,
    renderer: runtimePack.renderer,
    familyRig: createPublicFamilyRig(runtimePack),
    publicBasePath: `/characters/custom/public-family-rig-${identity}/v${version}`,
    assets: runtimePack.assets.map(({ id, path, mediaType, width, height, bytes }) => ({
      id,
      path,
      mediaType,
      width,
      height,
      bytes,
    })),
    canvas: runtimePack.canvas,
    anchors: runtimePack.anchors,
    staticFallbackAssetId: runtimePack.staticFallbackAssetId,
    reducedMotionFallbackAssetId: runtimePack.reducedMotionFallbackAssetId,
    layers: {},
    states: {
      idle: { variant: 'idle' },
      speaking: { variant: 'speaking' },
    },
    stateFallbacks: runtimePack.stateFallbacks,
    supportedContexts: runtimePack.supportedContexts,
  })
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export default async function PublicFamilyRigPage({
  searchParams,
}: {
  searchParams: Promise<{
    state?: string | string[]
    motion?: string | string[]
    size?: string | string[]
    failure?: string | string[]
    proof?: string | string[]
  }>
}) {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  const query = await searchParams
  const parsedState = CharacterStateSchema.safeParse(first(query.state))
  const state: CharacterState = parsedState.success ? parsedState.data : 'speaking'
  const requestedMotion = first(query.motion)
  const motion =
    requestedMotion === 'reduced' || requestedMotion === 'system' ? requestedMotion : 'full'
  const requestedSize = first(query.size)
  const size = requestedSize === 'compact' || requestedSize === 'standard' ? requestedSize : 'stage'
  const failure = first(query.failure)
  const initialIdentity =
    failure === 'layer' ? 'failure-layer' : failure === 'double' ? 'failure-double' : 'a'

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#f4f0e6] px-4 py-8 text-[#17241f] sm:px-8 sm:py-12">
      <div className="mx-auto max-w-4xl">
        <header className="border-b border-[#aeb9ac] pb-5">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#946224]">
            Development fixture · public runtime boundary
          </p>
          <h1 className="mt-2 font-serif text-3xl leading-tight tracking-[-0.03em] sm:text-5xl">
            Published family rig projection
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[#46544e]">
            Neutral prepared OpenMoji-derived fixture art exercises the public projection and real
            renderer. It is not approved Torchiko style or a selected production character.
          </p>
        </header>
        <PublicFamilyRigFixture
          initialProjection={projection(initialIdentity, 1)}
          delayedProjection={projection('delayed-a', 1)}
          replacementProjection={projection('b', 2)}
          requestedState={state}
          requestedMotion={motion}
          size={size}
          isolation={first(query.proof) === 'isolation'}
        />
      </div>
    </main>
  )
}
