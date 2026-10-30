/** Fictional offline evaluation fixtures only. Never imported by a production route. */
import { createHash } from 'node:crypto'
import type { EffectivePublishedUniversalContentSnapshot } from '@pathfinder/db'
import { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'
import { guestQuerySourceIsTemporallyAdmitted } from '../guest-query-canonical-projection'
import type { GuestQuerySource } from '../guest-query-source'
import { guestCanonicalAliasBody } from '../guest-query-whole-sources'

export const EVALUATION_VARIANT_BOUNDARY = '2026-10-24T17:00:00.000Z'
export const EVALUATION_VARIANT_CLOCKS = Object.freeze({
  before: '2026-10-24T16:59:59.000Z',
  at: EVALUATION_VARIANT_BOUNDARY,
  after: '2026-10-24T17:00:01.000Z',
})
export const EVALUATION_VARIANTS = Object.freeze({
  'museum-acceptance': {
    name: 'Fictional Helix Museum',
    category: 'museum',
    primary: 'Orion Gallery',
    secondary: 'Comet Workshop',
  },
  'park-acceptance': {
    name: 'Fictional Lantern Park',
    category: 'amusement-park',
    primary: 'Moonwheel',
    secondary: 'River Skiff',
  },
  'garden-acceptance': {
    name: 'Fictional Moss Garden',
    category: 'botanical-garden',
    primary: 'Fern Conservatory',
    secondary: 'Orchid House',
  },
})
export type GuestEvaluationVariantId = keyof typeof EVALUATION_VARIANTS
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * Reuses scope only; deliberately replaces narrative content with a new fictional source family.
 * Temporal membership uses the existing compiler predicate, not a real DB loader or DB proof.
 * Raw candidates are returned separately and must never be passed as current guest context.
 */
export function buildGuestQueryEvaluationVariant(
  base: GuestQuerySource,
  variantId: GuestEvaluationVariantId,
  asOf: string,
) {
  if (!Object.hasOwn(EVALUATION_VARIANTS, variantId)) throw new Error('Unknown evaluation variant')
  if (!Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf)
    throw new Error('Invalid fixture clock')
  if (!['LEGACY', 'DARK'].includes(base.readPath) || !base.tenantId || !base.venueId)
    throw new Error('A scoped legacy/dark fixture source is required')
  const definition = EVALUATION_VARIANTS[variantId]
  const id = (suffix: string) => `${variantId}-${suffix}`
  const place = (suffix: string, name: string, areaName: string) => ({
    id: id(suffix),
    name,
    areaName,
    type: 'ATTRACTION',
    itemType: null,
    shortDescription: null,
    longDescription: null,
    lat: null,
    lng: null,
    tags: [],
    hours: null,
    photoUrl: null,
    sourceType: 'MANUAL',
    sourceName: null,
    sourceUrl: null,
  })
  const source: GuestQuerySource = {
    tenantId: base.tenantId,
    venueId: base.venueId,
    readPath: base.readPath,
    includeSecondLayer: false,
    coverage: 'COMPLETE',
    asOf,
    version: '',
    directory: {
      incomplete: false,
      searchVersion: '',
      knowledge: [],
      places: [
        place('main-place', `${definition.primary} entrance`, 'East'),
        place('second-place', `${definition.secondary} entrance`, 'West'),
        place('north-east', 'North Pavilion', 'East'),
        place('north-west', 'North Pavilion', 'West'),
      ],
    },
    canonicalModules: { contract: 'published-query-source-v1', modules: [] },
  }
  const rawModules: EffectivePublishedUniversalContentSnapshot[] = []
  function add(suffix: string, payload: unknown, effectiveUntil: string | null = null) {
    const parsed = GeneralizedContentPayload.parse(payload)
    const moduleId = id(suffix)
    rawModules.push({
      moduleId,
      revisionId: `${moduleId}-r1`,
      publicationId: `${moduleId}-p1`,
      publicationOrder: String(rawModules.length + 1),
      version: 1,
      kind: parsed.kind,
      audience: 'PUBLIC',
      effectiveFrom: null,
      effectiveUntil,
      payload: parsed,
      evidence: [
        {
          sourceId: `fictional-fixture:${variantId}`,
          locator: `#${suffix}`,
          capturedAt: '2026-10-23T12:00:00.000Z',
          excerptHash: hash(parsed),
        },
      ],
    })
  }
  const subjects = (suffixes: string[]) => ({
    scope: 'SUBJECTS',
    subjectModuleIds: suffixes.map(id),
    placeIds: [],
  })
  add('main-service', {
    kind: 'SERVICE',
    name: definition.primary,
    placeId: id('main-place'),
    description: `Visitor activity at ${definition.primary}.`,
  })
  add('second-service', {
    kind: 'SERVICE',
    name: definition.secondary,
    placeId: id('second-place'),
    description: `Visitor activity at ${definition.secondary}.`,
  })
  add(
    'until-fact',
    {
      kind: 'OPERATIONAL_FACT',
      label: 'Temporary demonstration',
      value: `${definition.primary} has a temporary demonstration at 5 PM.`,
      applicability: subjects(['main-service']),
    },
    EVALUATION_VARIANT_BOUNDARY,
  )
  add('expiry-fact', {
    kind: 'OPERATIONAL_FACT',
    label: 'Temporary check-in entrance',
    value: `${definition.primary} uses the east entrance for check-in.`,
    expiresAt: EVALUATION_VARIANT_BOUNDARY,
    applicability: subjects(['main-service']),
  })
  add('access-fact', {
    kind: 'OPERATIONAL_FACT',
    label: 'Qualified step-free access',
    value: `${definition.primary} has step-free entry through the east ramp. Its upper viewing platform requires twelve steps; lift access to that platform is not established.`,
    applicability: subjects(['main-service']),
  })
  add('shared-fact', {
    kind: 'OPERATIONAL_FACT',
    label: 'Shared queue exception',
    value: `${definition.primary} and ${definition.secondary} share a queue, except during the 4 PM maintenance handover when ${definition.primary} uses the east entrance and ${definition.secondary} uses the west entrance.`,
    applicability: subjects(['main-service', 'second-service']),
  })
  add('global-fact', {
    kind: 'OPERATIONAL_FACT',
    label: 'Venue admission',
    value:
      'Venue admission ends at 5 PM. Free amenities do not establish an exception to admission.',
    applicability: { scope: 'VENUE' },
  })
  add('unknown-fact', {
    kind: 'OPERATIONAL_FACT',
    label: 'Drinking water',
    value: 'Drinking water is free.',
  })
  // Apply the actual compiler temporal rule to each raw candidate. This is fixture admission.
  const admitted = rawModules.filter((module) =>
    guestQuerySourceIsTemporallyAdmitted({
      ...source,
      canonicalModules: { contract: 'published-query-source-v1', modules: [module] },
    }),
  )
  source.canonicalModules!.modules = admitted
  source.directory.knowledge = admitted.map((module) => {
    const body = guestCanonicalAliasBody(module)
    if (!body) throw new Error('Unsupported fixture alias kind')
    return {
      id: `alias-${module.moduleId}`,
      title: body.title,
      category: module.kind,
      content: body.content,
      sourceType: 'UNIVERSAL_CONTENT',
      sourceName: null,
      sourceUrl: null,
      updatedAt: new Date('2026-10-23T12:00:00.000Z'),
      lastReviewedAt: null,
      contentModuleId: module.moduleId,
      contentRevisionId: module.revisionId,
      contentPublicationId: module.publicationId,
    }
  })
  // Same content-derived fixture sealing convention used by existing compiler tests. This is
  // explicitly not loadGuestQuerySource's database authorityVersion.
  source.version = hash({
    fixtureContract: 'fictional-acceptance-source-v1',
    ...source,
    version: '',
    directory: { ...source.directory, searchVersion: '' },
  })
  source.directory.searchVersion = source.version
  const admittedModuleIds = admitted.map((module) => module.moduleId)
  return {
    source,
    rawModules,
    admittedModuleIds,
    omittedModuleIds: rawModules
      .filter((module) => !admittedModuleIds.includes(module.moduleId))
      .map((module) => module.moduleId),
    sourceSha256: hash(source),
    underlyingSourceSha256: hash({
      places: source.directory.places,
      knowledge: source.directory.knowledge,
      canonicalModules: source.canonicalModules,
    }),
    venueIdentity: {
      name: definition.name,
      category: definition.category,
      timeZone: 'America/Chicago',
    },
    provenance: {
      fixtureContract: 'fictional-acceptance-source-v1',
      fictionalOnly: true,
      membership: 'EXISTING_COMPILER_TEMPORAL_PREDICATE_NOT_DATABASE_LOADER',
      boundary: EVALUATION_VARIANT_BOUNDARY,
    },
  }
}
