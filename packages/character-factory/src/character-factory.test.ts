import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FACTORY_STATES,
  type CharacterBundleAssetInput,
  type CharacterRuntimePackInput,
  type CharacterSpec,
  type RigFamily,
} from './types'
import { inspectImportedSkin } from './compatibility'
import { CharacterFactoryEngine, MemoryCharacterFactoryStore } from './engine'
import { RIGS } from './rigs'
import {
  createCharacterBundle,
  createCharacterExportArtifact,
  readCharacterExportArtifact,
  readCharacterRuntimeAsset,
  readCharacterRuntimePack,
  sanitizeImportedSource,
} from './artifact'

interface FixtureRecord {
  characterId: string
  displayName: string
  file: string
  rigFamily: RigFamily
  sha256: string
  byteLength: number
  sourceUrl: string
  protectedTraits: string[]
  slotMap: Record<string, string>
}

const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url))

async function loadFixtures(): Promise<Array<{ spec: CharacterSpec; svg: string }>> {
  const records = JSON.parse(
    await readFile(`${fixtureRoot}/fixture-specs.json`, 'utf8'),
  ) as FixtureRecord[]
  return Promise.all(
    records.map(async (record) => ({
      svg: await readFile(`${fixtureRoot}/${record.file}`, 'utf8'),
      spec: {
        schemaVersion: 1,
        characterId: record.characterId,
        version: 1,
        revision: 1,
        displayName: record.displayName,
        rigFamily: record.rigFamily,
        source: {
          kind: 'imported',
          sourceUrl: record.sourceUrl,
          sourceRevision: 'openmoji-16.0.0@66e17da0f2d4347f64ee9d78c367fc5234283863',
          license: 'CC-BY-SA-4.0',
          attribution: 'OpenMoji contributors',
          importedAt: '2026-09-07T00:00:00.000Z',
          sha256: record.sha256,
          mediaType: 'image/svg+xml',
          byteLength: record.byteLength,
        },
        masterReference: record.file,
        protectedTraits: record.protectedTraits,
        slotMap: record.slotMap,
        supportedStates: FACTORY_STATES,
        status: 'candidate',
      },
    })),
  )
}

async function firstFixture(): Promise<{ spec: CharacterSpec; svg: string }> {
  const fixture = (await loadFixtures())[0]
  if (!fixture) throw new Error('Expected at least one architecture fixture')
  return fixture
}

async function sha256(bytes: Uint8Array) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function neutralOwlRuntimePack(
  spec: CharacterSpec,
  assets: readonly CharacterBundleAssetInput[],
): Promise<CharacterRuntimePackInput> {
  const assetId = (asset: CharacterBundleAssetInput) => {
    if (asset.role === 'master') return 'source'
    if (asset.role === 'fallback') return 'static-fallback'
    return `${asset.slot ?? 'rig'}-layer`
  }
  const references = await Promise.all(
    assets.map(async (asset) => ({
      id: assetId(asset),
      path: asset.path,
      mediaType: asset.mediaType,
      width: 72,
      height: 72,
      bytes: asset.bytes.byteLength,
      sha256: await sha256(asset.bytes),
    })),
  )
  return {
    schemaVersion: 1,
    renderer: 'family-rig-v1',
    characterId: spec.characterId,
    characterVersion: spec.version,
    sourceSha256: spec.source.sha256,
    family: 'compact-creature-v1',
    capability: 'rigid-source',
    assets: references,
    canvas: { width: 72, height: 72 },
    safeBounds: { x: 0, y: 0, width: 72, height: 72 },
    origin: { x: 36, y: 36 },
    anchors: { lookAt: { x: 36, y: 28 }, embers: { x: 36, y: 55 } },
    sourceAssetId: 'source',
    staticFallbackAssetId: 'static-fallback',
    reducedMotionFallbackAssetId: 'static-fallback',
    layers: [
      { role: 'body', assetId: 'body-layer' },
      { role: 'eyes', assetId: 'eyes-layer' },
      { role: 'wing', assetId: 'wings-layer' },
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
    supportedContexts: ['client-assistant'],
  }
}

describe('neutral fixture architecture proof', () => {
  it('accepts bounded semantic rigs for non-built-in lion and talking-object anatomy', async () => {
    const { spec, svg } = await firstFixture()
    for (const custom of [
      {
        familyId: 'custom:quadruped-lion-v1' as const,
        anatomyClass: 'creature' as const,
        slots: ['body', 'head', 'legs', 'tail'],
      },
      {
        familyId: 'custom:talking-tablet-v1' as const,
        anatomyClass: 'object' as const,
        slots: ['body', 'screen', 'face'],
      },
    ]) {
      const customSpec: CharacterSpec = {
        ...spec,
        characterId: custom.familyId,
        rigFamily: custom.familyId,
        slotMap: Object.fromEntries(custom.slots.map((slot) => [slot, slot])),
        rigCapabilities: {
          schemaVersion: 1,
          familyId: custom.familyId,
          anatomyClass: custom.anatomyClass,
          requiredSlots: custom.slots,
          stateControls: Object.fromEntries(
            FACTORY_STATES.map((state) => [
              state,
              state === 'speaking' ? ['speechEnergy'] : ['pose'],
            ]),
          ),
        },
      }
      expect(inspectImportedSkin(customSpec, svg)).toMatchObject({
        compatible: true,
        rigFamily: custom.familyId,
      })
    }
  })
  it('maps owl, astronaut, and morph imports to distinct suitable rigs with one semantic grammar', async () => {
    const fixtures = await loadFixtures()
    const reports = fixtures.map(({ spec, svg }) => inspectImportedSkin(spec, svg))
    expect(reports.map((report) => report.rigFamily)).toEqual([
      'compact-creature-v1',
      'humanoid-v1',
      'morph-v1',
    ])
    expect(reports.every((report) => report.compatible)).toBe(true)
    expect(reports.every((report) => report.stateCoverage.join() === FACTORY_STATES.join())).toBe(
      true,
    )
    expect(new Set(reports.map((report) => report.requiredManualCleanup.join())).size).toBe(3)
    expect(RIGS['compact-creature-v1'].stateControls.happy).toContain('wingLift')
    expect(RIGS['humanoid-v1'].stateControls.happy).toContain('armLift')
    expect(RIGS['morph-v1'].stateControls.happy).toContain('stretch')
  })

  it('rejects active SVG and provenance drift', async () => {
    const { spec, svg } = await firstFixture()
    expect(inspectImportedSkin(spec, `${svg}<script>alert(1)</script>`).compatible).toBe(false)
    expect(
      inspectImportedSkin({ ...spec, source: { ...spec.source, sha256: '0'.repeat(64) } }, svg)
        .compatible,
    ).toBe(false)
  })

  it('removes recognized signed acquisition parameters while preserving source identity', async () => {
    const { sanitizeImportedSource } = await import('./artifact')
    const { spec } = await firstFixture()
    const aws = sanitizeImportedSource({
      ...spec.source,
      sourceUrl:
        'https://assets.example.test/owl.svg?variant=neutral&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=secret&X-Amz-Signature=signed&X-Amz-Security-Token=session',
    })
    expect(aws.sourceUrl).toBe('https://assets.example.test/owl.svg?variant=neutral')
    const azure = sanitizeImportedSource({
      ...spec.source,
      sourceUrl:
        'https://assets.example.test/owl.svg?variant=neutral&sv=2025-01-01&sp=r&se=2030-01-01&sr=b&sig=secret',
    })
    expect(azure.sourceUrl).toBe('https://assets.example.test/owl.svg?variant=neutral')
    const google = sanitizeImportedSource({
      ...spec.source,
      sourceUrl:
        'https://assets.example.test/owl.svg?variant=neutral&X-Goog-Credential=secret&X-Goog-Date=20260907T000000Z&X-Goog-Signature=signed',
    })
    expect(google.sourceUrl).toBe('https://assets.example.test/owl.svg?variant=neutral')
  })

  it('reads back the checked-in portable export against its imported bytes', async () => {
    const exported = JSON.parse(
      await readFile(`${fixtureRoot}/exports/neutral-owl-v1.character.json`, 'utf8'),
    ) as CharacterSpec
    const svg = await readFile(`${fixtureRoot}/${exported.masterReference}`, 'utf8')
    expect(exported.status).toBe('exported')
    expect(inspectImportedSkin(exported, svg).compatible).toBe(true)
  })
})

describe('agent-callable production engine', () => {
  it('creates, inspects, previews, validates, revises, and exports with safe replay', async () => {
    const { spec, svg } = await firstFixture()
    const store = new MemoryCharacterFactoryStore()
    const engine = new CharacterFactoryEngine(store)
    const create = {
      requestId: 'create-owl-1',
      action: { type: 'create-from-import' as const, spec, svg },
    }
    const first = await engine.run(create)
    expect(first.status).toBe('succeeded')
    expect(await engine.run(create)).toEqual(first)
    expect(
      (
        await engine.run({
          requestId: 'inspect-owl-1',
          action: { type: 'inspect', characterId: spec.characterId },
        })
      ).status,
    ).toBe('succeeded')
    expect(
      (
        await engine.run({
          requestId: 'preview-owl-1',
          action: { type: 'preview', characterId: spec.characterId, state: 'speaking' },
        })
      ).output,
    ).toMatchObject({ state: 'speaking', rigFamily: 'compact-creature-v1' })
    expect(
      (
        await engine.run({
          requestId: 'validate-owl-1',
          action: { type: 'validate', characterId: spec.characterId },
        })
      ).output,
    ).toMatchObject({ valid: true })
    const revision = await engine.run({
      requestId: 'revise-owl-1',
      action: {
        type: 'revise',
        characterId: spec.characterId,
        baseVersion: 1,
        protectedTraits: [...spec.protectedTraits, 'bright round eyes'],
      },
    })
    expect(revision.characterVersion).toBe(2)
    const exported = await engine.run({
      requestId: 'export-owl-2',
      action: { type: 'export', characterId: spec.characterId },
    })
    const readBack = await import('./artifact').then(({ readCharacterExportArtifact }) =>
      readCharacterExportArtifact(exported.output as import('./types').CharacterExportArtifact),
    )
    expect(readBack).toMatchObject({ version: 2, status: 'exported', source: { kind: 'imported' } })
    expect(readBack.masterReference).toBe(spec.masterReference)
    expect(readBack.rigFamily).toBe(spec.rigFamily)
  })

  it('fences stale revisions and honors cancellation before writes', async () => {
    const { spec, svg } = await firstFixture()
    const store = new MemoryCharacterFactoryStore()
    const engine = new CharacterFactoryEngine(store)
    await engine.run({ requestId: 'create', action: { type: 'create-from-import', spec, svg } })
    await engine.run({
      requestId: 'revise',
      action: { type: 'revise', characterId: spec.characterId, baseVersion: 1 },
    })
    const stale = await engine.run({
      requestId: 'stale',
      action: { type: 'revise', characterId: spec.characterId, baseVersion: 1 },
    })
    expect(stale.error?.code).toBe('LATE_RESULT_FENCED')
    engine.cancel('cancelled-create')
    const cancelled = await engine.run({
      requestId: 'cancelled-create',
      action: { type: 'create-from-import', spec: { ...spec, characterId: 'cancelled' }, svg },
    })
    expect(cancelled.status).toBe('cancelled')
    expect(await store.getCharacter('cancelled')).toBeUndefined()
  })

  it('binds request IDs to one action and detects artifact tampering', async () => {
    const { spec, svg } = await firstFixture()
    const store = new MemoryCharacterFactoryStore()
    const engine = new CharacterFactoryEngine(store)
    await engine.run({
      requestId: 'bound-request',
      action: { type: 'create-from-import', spec, svg },
    })
    const mismatch = await engine.run({
      requestId: 'bound-request',
      action: { type: 'inspect', characterId: spec.characterId },
    })
    expect(mismatch.error?.code).toBe('DUPLICATE_REQUEST_MISMATCH')

    const artifact = await createCharacterExportArtifact(spec)
    artifact.bytes[0] = artifact.bytes[0] === 123 ? 124 : 123
    await expect(readCharacterExportArtifact(artifact)).rejects.toThrow('integrity')
  })

  it('removes credential-shaped query parameters from persisted provenance', async () => {
    const { spec } = await firstFixture()
    const clean = sanitizeImportedSource({
      ...spec.source,
      sourceUrl: 'https://assets.example/art.svg?token=secret&variant=blue#private',
    })
    expect(clean.sourceUrl).toBe('https://assets.example/art.svg?variant=blue')
  })

  it('assembles a portable bundle only from matching local asset bytes', async () => {
    const { spec, svg } = await firstFixture()
    const bytes = new TextEncoder().encode(svg)
    const assets = [
      {
        path: spec.masterReference,
        mediaType: 'image/svg+xml' as const,
        role: 'master' as const,
        bytes,
      },
      {
        path: 'fallback/static.svg',
        mediaType: 'image/svg+xml' as const,
        role: 'fallback' as const,
        bytes,
      },
      ...Object.keys(spec.slotMap).map((slot, index) => ({
        path: `slots/${index}.svg`,
        mediaType: 'image/svg+xml' as const,
        role: 'slot' as const,
        slot,
        bytes,
      })),
    ]
    const bundle = await createCharacterBundle(spec, assets)
    expect(new TextDecoder().decode(bundle.bytes)).toContain('bytesBase64')
    expect((await readCharacterExportArtifact(bundle)).characterId).toBe(spec.characterId)
    await expect(
      createCharacterBundle(
        spec,
        assets.map((asset, index) =>
          index === 0 ? { ...asset, bytes: new TextEncoder().encode(`${svg} `) } : asset,
        ),
      ),
    ).rejects.toThrow('provenance')
    await expect(
      createCharacterBundle(
        spec,
        assets.map((asset, index) =>
          index === 0 ? { ...asset, bytes: new TextEncoder().encode(`${svg}<script/>`) } : asset,
        ),
      ),
    ).rejects.toThrow('active')
    await expect(createCharacterBundle(spec, [...assets, assets[0]!])).rejects.toThrow('unique')
    await expect(
      createCharacterBundle(
        spec,
        assets.filter((asset) => asset.role !== 'fallback'),
      ),
    ).rejects.toThrow('fallback')
    await expect(
      createCharacterBundle(
        spec,
        assets.map((asset, index) =>
          index === 1 ? { ...asset, path: 'https://evil.example/a.svg' } : asset,
        ),
      ),
    ).rejects.toThrow('safe relative')
    const tamperedBundle = { ...bundle, bytes: Uint8Array.from(bundle.bytes) }
    const tamperIndex = tamperedBundle.bytes.length - 2
    const originalByte = tamperedBundle.bytes[tamperIndex]
    if (originalByte === undefined) throw new Error('Expected a retained bundle byte to tamper')
    tamperedBundle.bytes[tamperIndex] = originalByte ^ 1
    await expect(readCharacterExportArtifact(tamperedBundle)).rejects.toThrow('integrity')
  })

  it('binds an explicitly prepared runtime pack to exact neutral fixture bytes and export identity', async () => {
    const { spec, svg } = await firstFixture()
    const body = await readFile(`${fixtureRoot}/segmented/owl/body.svg`, 'utf8')
    const face = await readFile(`${fixtureRoot}/segmented/owl/face.svg`, 'utf8')
    const wing = await readFile(`${fixtureRoot}/segmented/owl/wing.svg`, 'utf8')
    const assets: CharacterBundleAssetInput[] = [
      {
        path: spec.masterReference,
        mediaType: 'image/svg+xml',
        role: 'master',
        bytes: new TextEncoder().encode(svg),
      },
      {
        path: 'fallback/static.svg',
        mediaType: 'image/svg+xml',
        role: 'fallback',
        bytes: new TextEncoder().encode(svg),
      },
      { path: 'slots/body.svg', mediaType: 'image/svg+xml', role: 'slot', slot: 'body', bytes: new TextEncoder().encode(body) },
      { path: 'slots/eyes.svg', mediaType: 'image/svg+xml', role: 'slot', slot: 'eyes', bytes: new TextEncoder().encode(face) },
      { path: 'slots/wings.svg', mediaType: 'image/svg+xml', role: 'slot', slot: 'wings', bytes: new TextEncoder().encode(wing) },
    ]
    const pack = await neutralOwlRuntimePack(spec, assets)
    const bundle = await createCharacterBundle(spec, assets, pack)
    const verified = await readCharacterRuntimePack(bundle)
    expect(verified).toMatchObject({
      spec: { characterId: spec.characterId, version: spec.version },
      runtimePack: { renderer: 'family-rig-v1', sourceSha256: spec.source.sha256, family: spec.rigFamily },
    })
    const publicAsset = await readCharacterRuntimeAsset(bundle, { assetId: 'body-layer' })
    expect(publicAsset).toMatchObject({
      asset: { id: 'body-layer', path: 'slots/body.svg', width: 72, height: 72 },
    })
    expect(new TextDecoder().decode(publicAsset.bytes)).toBe(body)
    await expect(readCharacterRuntimeAsset(bundle, { assetId: 'unlisted' })).rejects.toThrow('not allowlisted')
    const changedState = {
      ...pack,
      supportedContexts: ['marketing'] as CharacterRuntimePackInput['supportedContexts'],
    }
    const changedIdentity = await createCharacterBundle(spec, assets, changedState)
    expect(changedIdentity.sha256).not.toBe(bundle.sha256)
  })

  it('refuses runtime packs with changed or missing bytes, dimensions, hashes, unsupported families, or unsupported states', async () => {
    const { spec, svg } = await firstFixture()
    const body = await readFile(`${fixtureRoot}/segmented/owl/body.svg`, 'utf8')
    const face = await readFile(`${fixtureRoot}/segmented/owl/face.svg`, 'utf8')
    const wing = await readFile(`${fixtureRoot}/segmented/owl/wing.svg`, 'utf8')
    const assets: CharacterBundleAssetInput[] = [
      { path: spec.masterReference, mediaType: 'image/svg+xml', role: 'master', bytes: new TextEncoder().encode(svg) },
      { path: 'fallback/static.svg', mediaType: 'image/svg+xml', role: 'fallback', bytes: new TextEncoder().encode(svg) },
      { path: 'slots/body.svg', mediaType: 'image/svg+xml', role: 'slot', slot: 'body', bytes: new TextEncoder().encode(body) },
      { path: 'slots/eyes.svg', mediaType: 'image/svg+xml', role: 'slot', slot: 'eyes', bytes: new TextEncoder().encode(face) },
      { path: 'slots/wings.svg', mediaType: 'image/svg+xml', role: 'slot', slot: 'wings', bytes: new TextEncoder().encode(wing) },
      { path: 'rig/source.svg', mediaType: 'image/svg+xml', role: 'rig-source', bytes: new TextEncoder().encode(wing) },
    ]
    const pack = await neutralOwlRuntimePack(spec, assets)
    await expect(
      createCharacterBundle(
        spec,
        assets.map((asset) => asset.path === 'slots/wings.svg' ? { ...asset, bytes: new TextEncoder().encode(`${wing} `) } : asset),
        pack,
      ),
    ).rejects.toThrow('does not match bundled bytes')
    await expect(createCharacterBundle(spec, assets.slice(0, -1), pack)).rejects.toThrow('reference every bundled asset')
    await expect(
      createCharacterBundle(spec, assets, {
        ...pack,
        assets: pack.assets.map((asset) => asset.id === 'body-layer' ? { ...asset, width: 71 } : asset),
      }),
    ).rejects.toThrow('format is unsupported')
    await expect(
      createCharacterBundle(spec, assets, {
        ...pack,
        assets: pack.assets.map((asset) => asset.id === 'body-layer' ? { ...asset, sha256: '0'.repeat(64) } : asset),
      }),
    ).rejects.toThrow('does not match bundled bytes')
    const malformedSvgAssets = assets.map((asset) =>
      asset.path === 'slots/body.svg'
        ? { ...asset, bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') }
        : asset,
    )
    await expect(
      createCharacterBundle(
        spec,
        malformedSvgAssets,
        await neutralOwlRuntimePack(spec, malformedSvgAssets),
      ),
    ).rejects.toThrow('dimensions do not match asset bytes')
    const malformedPng = Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10, ...Array<number>(37).fill(0),
    ])
    const malformedPngAssets = assets.map((asset) =>
      asset.path === 'slots/body.svg'
        ? { ...asset, path: 'slots/body.png', mediaType: 'image/png' as const, bytes: malformedPng }
        : asset,
    )
    await expect(
      createCharacterBundle(
        spec,
        malformedPngAssets,
        await neutralOwlRuntimePack(spec, malformedPngAssets),
      ),
    ).rejects.toThrow('dimensions do not match asset bytes')
    await expect(createCharacterBundle(spec, assets, { ...pack, family: 'morph-v1' })).rejects.toThrow('family or capability')
    const unsupportedStateFallbacks = { ...pack.stateFallbacks, speaking: 'idle' as const }
    delete unsupportedStateFallbacks.processing
    await expect(
      createCharacterBundle(spec, assets, {
        ...pack,
        supportedStates: ['idle', 'processing'],
        stateFallbacks: unsupportedStateFallbacks,
      }),
    ).rejects.toThrow('state is unsupported')
  })

  it('keeps legacy bundles readable but refuses to mark them animation-publishable', async () => {
    const { spec, svg } = await firstFixture()
    const bytes = new TextEncoder().encode(svg)
    const assets: CharacterBundleAssetInput[] = [
      { path: spec.masterReference, mediaType: 'image/svg+xml', role: 'master', bytes },
      { path: 'fallback/static.svg', mediaType: 'image/svg+xml', role: 'fallback', bytes },
      ...Object.keys(spec.slotMap).map((slot) => ({ path: `slots/${slot}.svg`, mediaType: 'image/svg+xml' as const, role: 'slot' as const, slot, bytes })),
    ]
    const legacy = await createCharacterBundle(spec, assets)
    expect((await readCharacterExportArtifact(legacy)).characterId).toBe(spec.characterId)
    await expect(
      readCharacterExportArtifact({ ...legacy, characterId: 'another-character' }),
    ).rejects.toThrow('metadata does not match')
    await expect(
      readCharacterExportArtifact({ ...legacy, characterVersion: spec.version + 1 }),
    ).rejects.toThrow('metadata does not match')
    await expect(readCharacterRuntimePack(legacy)).rejects.toThrow('not animation-publishable')
  })
})
