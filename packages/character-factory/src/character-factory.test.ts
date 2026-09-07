import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FACTORY_STATES, type CharacterSpec, type RigFamily } from './types'
import { inspectImportedSkin } from './compatibility'
import { CharacterFactoryEngine, MemoryCharacterFactoryStore } from './engine'
import { RIGS } from './rigs'

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

describe('neutral fixture architecture proof', () => {
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
    const readBack = JSON.parse(exported.output as string) as CharacterSpec
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
})
