import { describe, expect, it } from 'vitest'
import {
  compileGuestQueryCanonicalSource,
  guestQuerySourceIsTemporallyAdmitted,
} from '../guest-query-canonical-projection'
import { prepareGuestSubjectEvidence } from '../guest-query-subject-evidence'
import { parseGuestQueryPlan } from '../guest-query-planning'
import type { GuestQuerySource } from '../guest-query-source'
import {
  buildGuestQueryEvaluationVariant,
  EVALUATION_VARIANTS,
  EVALUATION_VARIANT_CLOCKS,
  type GuestEvaluationVariantId,
} from './guest-query-evaluation-fixture-variants'

const base: GuestQuerySource = {
  tenantId: 'fictional-tenant',
  venueId: 'fictional-venue',
  version: 'base',
  asOf: EVALUATION_VARIANT_CLOCKS.before,
  coverage: 'COMPLETE',
  includeSecondLayer: false,
  readPath: 'LEGACY',
  directory: { incomplete: false, knowledge: [], places: [] },
}
const variants = Object.keys(EVALUATION_VARIANTS) as GuestEvaluationVariantId[]

describe.each(variants)('fictional acceptance variant %s', (variant) => {
  it.each(Object.entries(EVALUATION_VARIANT_CLOCKS))(
    'enforces real timestamp fields at %s boundary without stale aliases',
    (position, clock) => {
      const fixture = buildGuestQueryEvaluationVariant(base, variant, clock)
      const expiredIds = [`${variant}-until-fact`, `${variant}-expiry-fact`]
      expect(fixture.rawModules).toHaveLength(8)
      expect(fixture.admittedModuleIds).toHaveLength(position === 'before' ? 8 : 6)
      expect(fixture.omittedModuleIds).toEqual(position === 'before' ? [] : expiredIds)
      for (const moduleId of expiredIds) {
        const raw = fixture.rawModules.find((row) => row.moduleId === moduleId)!
        expect(
          guestQuerySourceIsTemporallyAdmitted({
            ...fixture.source,
            canonicalModules: { contract: 'published-query-source-v1', modules: [raw] },
          }),
        ).toBe(position === 'before')
        expect(
          fixture.source.directory.knowledge.some((row) => row.contentModuleId === moduleId),
        ).toBe(position === 'before')
      }
      expect(guestQuerySourceIsTemporallyAdmitted(fixture.source)).toBe(true)
      expect(fixture.source.directory.knowledge.every((row) => row.updatedAt instanceof Date)).toBe(
        true,
      )
      expect(() => compileGuestQueryCanonicalSource(fixture.source)).not.toThrow()
    },
  )
  it('rejects genuine duplicate-name selection rather than selecting the first place', () => {
    const { source } = buildGuestQueryEvaluationVariant(base, variant, EVALUATION_VARIANT_CLOCKS.at)
    const prepared = compileGuestQueryCanonicalSource(source).prepared
    const question = 'Where is North Pavilion?'
    const catalog = prepared.discoverNamedCandidates(question)
    expect(catalog.data.groups).toHaveLength(1)
    expect(catalog.data.groups[0]).toMatchObject({ candidateCount: 2 })
    expect(catalog.data.groups[0]).not.toHaveProperty('record')
    expect(() =>
      parseGuestQueryPlan(JSON.stringify({ status: 'EVIDENCE_SUBJECTS', refs: ['n0'] }), prepared, {
        question,
        catalog,
      }),
    ).toThrow(/ambig/i)
    expect(
      source.directory.places.filter((row) => row.name === 'North Pavilion').map((row) => row.id),
    ).toEqual([`${variant}-north-east`, `${variant}-north-west`])
  })
  it('retains the complete qualified access and shared exception bodies for each affected subject', () => {
    const { source } = buildGuestQueryEvaluationVariant(base, variant, EVALUATION_VARIANT_CLOCKS.at)
    const compiled = compileGuestQueryCanonicalSource(source)
    expect(compiled.factApplicabilityRejections).toEqual([])
    const fullBody = (suffix: string) =>
      source.canonicalModules!.modules.find((row) => row.moduleId === `${variant}-${suffix}`)!
        .payload
    const access = fullBody('access-fact'),
      exception = fullBody('shared-fact')
    if (access.kind !== 'OPERATIONAL_FACT' || exception.kind !== 'OPERATIONAL_FACT')
      throw new Error('Expected facts')
    for (const suffix of ['main-service', 'second-service']) {
      const evidence = prepareGuestSubjectEvidence({
        source,
        compiled,
        keys: [`knowledge:alias-${variant}-${suffix}`],
        mode: 'DETAILS',
      })
      expect(
        evidence.canonicalSources.find((body) => body.moduleId === `${variant}-shared-fact`)
          ?.snapshot.payload,
      ).toEqual(exception)
      expect(
        evidence.canonicalSources.some((body) => body.moduleId === `${variant}-global-fact`),
      ).toBe(true)
      expect(
        evidence.canonicalSources.some((body) => body.moduleId === `${variant}-unknown-fact`),
      ).toBe(true)
      if (suffix === 'main-service')
        expect(
          evidence.canonicalSources.find((body) => body.moduleId === `${variant}-access-fact`)
            ?.snapshot.payload,
        ).toEqual(access)
    }
    expect(access.value).toContain('step-free entry')
    expect(access.value).toContain('twelve steps')
    expect(access.value).toContain('not established')
  })
})

it('does not mutate base scope/content and seals source membership and observation time reproducibly', () => {
  const original = structuredClone(base)
  const before = buildGuestQueryEvaluationVariant(
    base,
    'museum-acceptance',
    EVALUATION_VARIANT_CLOCKS.before,
  )
  const same = buildGuestQueryEvaluationVariant(
    base,
    'museum-acceptance',
    EVALUATION_VARIANT_CLOCKS.before,
  )
  const at = buildGuestQueryEvaluationVariant(
    base,
    'museum-acceptance',
    EVALUATION_VARIANT_CLOCKS.at,
  )
  expect(base).toEqual(original)
  expect(before).toEqual(same)
  expect(before.sourceSha256).not.toBe(at.sourceSha256)
  expect(before.underlyingSourceSha256).not.toBe(at.underlyingSourceSha256)
  expect(before.source.directory.searchVersion).toBe(before.source.version)
  expect(before.venueIdentity.category).toBe('museum')
})
