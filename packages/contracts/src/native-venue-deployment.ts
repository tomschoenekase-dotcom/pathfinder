import { z } from 'zod'

import { EvidenceLocator, sha256Hex } from './venue-deployment-manifest'

const Hash = z.string().regex(/^[a-f0-9]{64}$/u)
const Id = z.string().trim().min(1).max(191)
const EvidenceSourceId = z.string().trim().min(1).max(500)
export const NATIVE_CORE_MAX_CANONICAL_BYTES = 2_000_000
export const NATIVE_CORE_MAX_TOTAL_EVIDENCE = 5_000
const Text = (maximum: number) => z.string().max(maximum)
const UtcMillis = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
const SafeUrl = z
  .string()
  .url()
  .max(2_000)
  .nullable()
  .refine((value) => {
    if (value === null) return true
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  }, 'URLs must be credential-free HTTPS references without query or fragment.')

function boundedJson(value: unknown, budget: { nodes: number }, depth = 0): boolean {
  if (depth > 8 || ++budget.nodes > 10_000) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value))
    return value.length <= 1_000 && value.every((item) => boundedJson(item, budget, depth + 1))
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    return false
  return (
    Object.keys(value).length <= 1_000 &&
    Object.values(value).every((item) => boundedJson(item, budget, depth + 1))
  )
}
const GeoBoundary = z
  .union([z.record(z.unknown()), z.array(z.unknown())])
  .refine(
    (value) =>
      boundedJson(value, { nodes: 0 }) &&
      new TextEncoder().encode(JSON.stringify(value)).length <= 100_000,
    'Geo boundary exceeds structural bounds.',
  )
  .nullable()

export const NATIVE_VENUE_DEPLOYMENT_PROFILE = 'NATIVE_CORE_V1' as const

export const NativeVenueConfiguration = z
  .object({
    name: Text(200).min(1),
    slug: z
      .string()
      .max(191)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    description: Text(10_000).nullable(),
    guideNotes: Text(2_000).nullable(),
    aiGuideNotes: Text(2_000).nullable(),
    aiFeaturedPlaceId: Id.nullable(),
    aiTone: Text(64).nullable(),
    tonePreset: Text(64).nullable(),
    tonePresetVersion: z.number().int().positive().nullable(),
    aiGuideName: Text(80).nullable(),
    chatTheme: Text(64).nullable(),
    chatAccentColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/u)
      .nullable(),
    chatFont: Text(64).nullable(),
    chatLogoUrl: SafeUrl,
    chatBannerUrl: SafeUrl,
    category: Text(100).nullable(),
    guideMode: Text(64),
    defaultCenterLat: z.number().min(-90).max(90).nullable(),
    defaultCenterLng: z.number().min(-180).max(180).nullable(),
    geoBoundary: GeoBoundary,
    isActive: z.boolean(),
  })
  .strict()
  .refine((value) => (value.defaultCenterLat === null) === (value.defaultCenterLng === null), {
    path: ['defaultCenterLng'],
    message: 'Venue coordinates must be paired.',
  })

const SourceFields = {
  sourceType: Text(64).min(1),
  authorship: Text(64).min(1),
  sourceName: Text(200).nullable(),
  sourceUrl: SafeUrl,
  importedAt: UtcMillis.nullable(),
  humanConfirmedAt: UtcMillis.nullable(),
  humanConfirmedBy: Text(191).nullable(),
  lastReviewedAt: UtcMillis.nullable(),
  lastReviewedBy: Text(191).nullable(),
  sourcePackageId: Id.nullable(),
} as const
export const NativePlaceState = z
  .object({
    id: Id,
    name: Text(200).min(1),
    type: Text(100).min(1),
    itemType: Text(100).nullable(),
    shortDescription: Text(500).nullable(),
    longDescription: Text(2_000).nullable(),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    tags: z.array(Text(100)).max(100),
    importanceScore: z.number().int().min(0).max(100),
    areaName: Text(200).nullable(),
    hours: Text(200).nullable(),
    photoUrl: SafeUrl,
    isActive: z.literal(true),
    ...SourceFields,
  })
  .strict()
  .refine((value) => (value.lat === null) === (value.lng === null), {
    path: ['lng'],
    message: 'Place coordinates must be paired.',
  })
export const NativeKnowledgeState = z
  .object({
    id: Id,
    title: Text(200).min(1),
    category: Text(100).min(1),
    content: Text(5_000).min(1),
    isEnabled: z.literal(true),
    ...SourceFields,
  })
  .strict()

const Evidence = z
  .object({
    sourceId: EvidenceSourceId,
    locator: EvidenceLocator.nullable(),
    capturedAt: UtcMillis,
    excerptHash: Hash.nullable(),
  })
  .strict()
const Payload = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('SERVICE'),
      name: Text(200).min(1),
      description: Text(10_000).nullable(),
      availability: Text(2_000).nullable(),
      placeId: Id.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('POLICY'),
      title: Text(200).min(1),
      rule: Text(20_000).min(1),
      appliesTo: z.array(Id).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal('EVENT'),
      name: Text(200).min(1),
      description: Text(10_000).nullable(),
      startsAt: UtcMillis,
      endsAt: UtcMillis.nullable(),
      placeId: Id.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('OPERATIONAL_FACT'),
      label: Text(200).min(1),
      value: Text(5_000).min(1),
      expiresAt: UtcMillis.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('RELATIONSHIP'),
      fromModuleId: Id,
      toModuleId: Id,
      relationshipType: Text(100).min(1),
      description: Text(2_000).nullable(),
    })
    .strict(),
])
const Kinds = z.enum(['SERVICE', 'POLICY', 'EVENT', 'OPERATIONAL_FACT', 'RELATIONSHIP'])
export const NativeGeneralizedModuleState = z
  .object({
    moduleId: Id,
    kind: Kinds,
    version: z.number().int().positive(),
    revisionId: Id,
    audience: z.literal('PUBLIC'),
    effectiveFrom: UtcMillis.nullable(),
    effectiveUntil: UtcMillis.nullable(),
    evidence: z.array(Evidence).max(100),
    payload: Payload,
    publication: z.object({ status: z.literal('PUBLISHED'), revisionId: Id }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.payload.kind !== value.kind)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'kind'],
        message: 'Payload kind must match.',
      })
    if (value.publication.revisionId !== value.revisionId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publication', 'revisionId'],
        message: 'Published revision must equal the declared revision.',
      })
    if (value.effectiveFrom && value.effectiveUntil && value.effectiveUntil <= value.effectiveFrom)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveUntil'],
        message: 'Effective end must follow effective start.',
      })
    if (
      value.payload.kind === 'EVENT' &&
      value.payload.endsAt !== null &&
      value.payload.endsAt <= value.payload.startsAt
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'endsAt'],
        message: 'Event end must follow its start.',
      })
    if (
      value.payload.kind === 'RELATIONSHIP' &&
      value.payload.fromModuleId === value.payload.toModuleId
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'toModuleId'],
        message: 'Relationship endpoints must differ.',
      })
  })

export const NativeCoreFullManifest = z
  .object({
    schemaVersion: z.literal(2),
    packageType: z.literal('FULL'),
    materializationProfile: z.literal(NATIVE_VENUE_DEPLOYMENT_PROFILE),
    manifestId: z.string().uuid(),
    idempotencyKey: z.string().uuid(),
    venueRef: Id,
    provenance: z
      .object({
        sourceIds: z.array(Id).min(1).max(500),
        evidenceIds: z.array(Id).max(5_000),
        createdAt: UtcMillis,
        createdBy: z.object({ kind: z.literal('OPERATOR'), actorRef: Id }).strict(),
      })
      .strict(),
    venue: NativeVenueConfiguration,
    places: z.array(NativePlaceState).max(1_000),
    knowledgeEntries: z.array(NativeKnowledgeState).max(1_000),
    generalizedModules: z.array(NativeGeneralizedModuleState).max(1_000),
    items: z.tuple([]),
    assets: z.tuple([]),
    capabilityOverrides: z.tuple([]),
    modelReferences: z.tuple([]),
    evaluation: z
      .object({
        status: z.literal('NOT_REQUIRED_FOR_CORE_PROFILE'),
        policyVersion: z.literal('native-core-v1'),
      })
      .strict(),
    baseState: z
      .object({
        stateHash: Hash,
        activePlaceIds: z.array(Id).max(1_000),
        enabledKnowledgeEntryIds: z.array(Id).max(1_000),
        publishedGeneralizedHeads: z
          .array(
            z
              .object({
                moduleId: Id,
                kind: Kinds,
                revisionId: Id,
                version: z.number().int().positive(),
                publicationId: Id,
                eventOrder: z.string().regex(/^\d+$/u),
              })
              .strict(),
          )
          .max(1_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.generalizedModules.reduce((sum, item) => sum + item.evidence.length, 0) >
      NATIVE_CORE_MAX_TOTAL_EVIDENCE
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['generalizedModules'],
        message: 'Manifest exceeds the total evidence bound.',
      })
    if (new TextEncoder().encode(JSON.stringify(value)).length > NATIVE_CORE_MAX_CANONICAL_BYTES)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'Manifest exceeds the canonical byte bound.',
      })
    const groups: Array<[Array<string>, (string | number)[]]> = [
      [value.places.map((item) => item.id), ['places']],
      [value.knowledgeEntries.map((item) => item.id), ['knowledgeEntries']],
      [value.generalizedModules.map((item) => item.moduleId), ['generalizedModules']],
      [value.provenance.sourceIds, ['provenance', 'sourceIds']],
      [value.provenance.evidenceIds, ['provenance', 'evidenceIds']],
      [value.baseState.activePlaceIds, ['baseState', 'activePlaceIds']],
      [value.baseState.enabledKnowledgeEntryIds, ['baseState', 'enabledKnowledgeEntryIds']],
      [
        value.baseState.publishedGeneralizedHeads.map((item) => item.moduleId),
        ['baseState', 'publishedGeneralizedHeads'],
      ],
    ]
    for (const [items, path] of groups)
      if (new Set(items).size !== items.length)
        context.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Values must be unique.' })
    const placeIds = new Set(value.places.map((item) => item.id))
    const moduleIds = new Set(value.generalizedModules.map((item) => item.moduleId))
    if (value.venue.aiFeaturedPlaceId && !placeIds.has(value.venue.aiFeaturedPlaceId))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['venue', 'aiFeaturedPlaceId'],
        message: 'Featured place must be declared.',
      })
    value.places.forEach((item, index) => {
      if (new Set(item.tags).size !== item.tags.length)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['places', index, 'tags'],
          message: 'Tags must be unique.',
        })
    })
    value.generalizedModules.forEach((item, index) => {
      const evidence = item.evidence.map((entry) => `${entry.sourceId}:${entry.locator ?? ''}`)
      if (new Set(evidence).size !== evidence.length)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['generalizedModules', index, 'evidence'],
          message: 'Evidence identities must be unique.',
        })
      if ('placeId' in item.payload && item.payload.placeId && !placeIds.has(item.payload.placeId))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['generalizedModules', index, 'payload', 'placeId'],
          message: 'Place must be declared.',
        })
      if (
        item.payload.kind === 'POLICY' &&
        new Set(item.payload.appliesTo).size !== item.payload.appliesTo.length
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['generalizedModules', index, 'payload', 'appliesTo'],
          message: 'Targets must be unique.',
        })
      if (
        item.payload.kind === 'RELATIONSHIP' &&
        (!moduleIds.has(item.payload.fromModuleId) || !moduleIds.has(item.payload.toModuleId))
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['generalizedModules', index, 'payload'],
          message: 'Relationship endpoints must be declared.',
        })
    })
  })
export type NativeCoreFullManifest = z.infer<typeof NativeCoreFullManifest>

export const NativeCoreVisibleState = z
  .object({
    venue: NativeVenueConfiguration,
    places: z.array(NativePlaceState).max(1_000),
    knowledgeEntries: z.array(NativeKnowledgeState).max(1_000),
    generalizedModules: z.array(NativeGeneralizedModuleState).max(1_000),
  })
  .strict()
export type NativeCoreVisibleState = z.infer<typeof NativeCoreVisibleState>

export const NativeDeploymentScopeInput = z.object({ tenantId: Id, venueId: Id }).strict()
export const NativeDeploymentCreateInput = NativeDeploymentScopeInput.extend({
  manifest: NativeCoreFullManifest,
}).strict()
export const NativeDeploymentLifecycleInput = NativeDeploymentScopeInput.extend({
  releaseId: z.string().uuid(),
  commandId: z.string().uuid(),
  expectedUpdatedAt: UtcMillis,
}).strict()

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
export function canonicalNativeCoreFullManifest(value: unknown) {
  const parsed = NativeCoreFullManifest.parse(value)
  return JSON.stringify(
    canonical({
      ...parsed,
      provenance: {
        ...parsed.provenance,
        sourceIds: [...parsed.provenance.sourceIds].sort(),
        evidenceIds: [...parsed.provenance.evidenceIds].sort(),
      },
      places: [...parsed.places]
        .map((item) => ({ ...item, tags: [...item.tags].sort() }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      knowledgeEntries: [...parsed.knowledgeEntries].sort((a, b) => a.id.localeCompare(b.id)),
      generalizedModules: [...parsed.generalizedModules]
        .map((item) => ({
          ...item,
          payload:
            item.payload.kind === 'POLICY'
              ? { ...item.payload, appliesTo: [...item.payload.appliesTo].sort() }
              : item.payload,
          evidence: [...item.evidence].sort((a, b) =>
            `${a.sourceId}:${a.locator ?? ''}`.localeCompare(`${b.sourceId}:${b.locator ?? ''}`),
          ),
        }))
        .sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
      baseState: {
        ...parsed.baseState,
        activePlaceIds: [...parsed.baseState.activePlaceIds].sort(),
        enabledKnowledgeEntryIds: [...parsed.baseState.enabledKnowledgeEntryIds].sort(),
        publishedGeneralizedHeads: [...parsed.baseState.publishedGeneralizedHeads].sort((a, b) =>
          a.moduleId.localeCompare(b.moduleId),
        ),
      },
    }),
  )
}
export function nativeCoreFullManifestHash(value: unknown) {
  return sha256Hex(canonicalNativeCoreFullManifest(value))
}

export function canonicalNativeCoreVisibleState(value: unknown) {
  const parsed = NativeCoreVisibleState.parse(value)
  return JSON.stringify(
    canonical({
      ...parsed,
      places: [...parsed.places]
        .map((item) => ({ ...item, tags: [...item.tags].sort() }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      knowledgeEntries: [...parsed.knowledgeEntries].sort((a, b) => a.id.localeCompare(b.id)),
      generalizedModules: [...parsed.generalizedModules]
        .map((item) => ({
          ...item,
          payload:
            item.payload.kind === 'POLICY'
              ? { ...item.payload, appliesTo: [...item.payload.appliesTo].sort() }
              : item.payload,
          evidence: [...item.evidence].sort((a, b) =>
            `${a.sourceId}:${a.locator ?? ''}`.localeCompare(`${b.sourceId}:${b.locator ?? ''}`),
          ),
        }))
        .sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
    }),
  )
}

export function nativeCoreVisibleStateHash(value: unknown) {
  return sha256Hex(canonicalNativeCoreVisibleState(value))
}
