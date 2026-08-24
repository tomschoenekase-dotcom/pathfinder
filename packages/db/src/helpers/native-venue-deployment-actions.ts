import {
  canonicalNativeCoreFullManifest,
  NativeCoreFullManifest,
  type NativeCoreFullManifest as NativeManifest,
  NativeCoreVisibleState,
  resolveEffectiveTone,
  nativeCoreFullManifestHash,
  nativeCoreVisibleStateHash,
  sha256Hex,
} from '@pathfinder/contracts'

/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma extension and heterogeneous typed revision rows require a bounded structural surface. */

import { lockVenueContentMutation } from './venue-content-lock'
import { writeAuditLogStrict } from './audit'

// Extended Prisma clients and transaction clients share this structural surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NativeVenueDeploymentClient = any
export type NativeVenueDeploymentActor = {
  type: 'HUMAN'
  role: 'PLATFORM_ADMIN'
  id: string
}

export class NativeVenueDeploymentError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'INVALID_INPUT' | 'NOT_FOUND' | 'PRECONDITION_FAILED',
    message: string,
  ) {
    super(message)
  }
}

type Scope = { tenantId: string; venueId: string }
type BaseUniverse = NativeManifest['baseState']
type VisibleState = ReturnType<typeof NativeCoreVisibleState.parse>
export const NATIVE_GUEST_CONTENT_READ_PATH =
  'LEGACY_SEMANTIC_PLUS_NATIVE_GENERALIZED_PROMPT' as const
export type NativeContentConvergencePhase =
  | 'NO_NATIVE_HEAD'
  | 'NATIVE_HEAD_INVALID'
  | 'NATIVE_HEAD_DRIFTED'
  | 'NATIVE_HEAD_IN_SYNC'
export type NativeContentConvergenceBlocker =
  | 'NO_NATIVE_HEAD'
  | 'INVALID_NATIVE_HEAD'
  | 'MATERIALIZED_STATE_DRIFT'
  | 'LEGACY_SEMANTIC_READ_PATH'
type NativeContentConvergenceHead = {
  releaseId: string
  artifactId: string
  manifestHash: string
  stateHash: string
  revision: number
  updatedAt: Date
  release: {
    id: string
    artifactId: string
    manifestHash: string
    desiredStateHash: string
    status: string
  }
} | null
type HeadSnapshot = {
  releaseId: string
  artifactId: string
  manifestHash: string
  stateHash: string
  revision: number
  updatedAt: string
} | null
type Plan = {
  before: VisibleState
  desired: VisibleState
  priorHead: HeadSnapshot
  hiddenPlaces: Record<string, Record<string, unknown>>
  hiddenKnowledge: Record<string, Record<string, unknown>>
  effects: Array<{
    effectOrder: number
    kind: string
    targetId: string
    beforeHash: string
    afterHash: string
    beforeState: ReturnType<typeof envelope>
    afterState: ReturnType<typeof envelope>
  }>
}

const txOptions = { isolationLevel: 'Serializable' as const, maxWait: 5_000, timeout: 30_000 }
const iso = (value: Date | null) => value?.toISOString() ?? null
const envelope = (value: unknown | null) => ({ present: value !== null, value })
const hashEnvelope = (value: unknown | null) => sha256Hex(JSON.stringify(envelope(value)))
function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedJson)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizedJson(item)]),
    )
  return value
}
// PostgreSQL jsonb normalizes object-key order. Compare reloaded evidence by
// JSON value, while retaining the immutable pre-storage hashes recorded in the plan.
const sameJsonValue = (left: unknown, right: unknown) =>
  JSON.stringify(normalizedJson(left)) === JSON.stringify(normalizedJson(right))
const isRetryable = (error: unknown) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['P2002', 'P2034'].includes(String((error as { code?: unknown }).code)),
  )

function assertActor(actor: NativeVenueDeploymentActor) {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || actor.id.trim() === '')
    throw new NativeVenueDeploymentError('INVALID_INPUT', 'A platform administrator is required.')
}

const stateHash = (state: VisibleState) => nativeCoreVisibleStateHash(state)

function venueState(row: Record<string, unknown>) {
  return {
    name: row.name,
    slug: row.slug,
    description: row.description,
    guideNotes: row.guideNotes,
    aiGuideNotes: row.aiGuideNotes,
    aiFeaturedPlaceId: row.aiFeaturedPlaceId,
    aiTone: row.aiTone,
    tonePreset: row.tonePreset,
    tonePresetVersion: row.tonePresetVersion,
    aiGuideName: row.aiGuideName,
    chatTheme: row.chatTheme,
    chatAccentColor: row.chatAccentColor,
    chatFont: row.chatFont,
    chatLogoUrl: row.chatLogoUrl,
    chatBannerUrl: row.chatBannerUrl,
    category: row.category,
    guideMode: row.guideMode,
    defaultCenterLat: row.defaultCenterLat,
    defaultCenterLng: row.defaultCenterLng,
    geoBoundary: row.geoBoundary,
    isActive: row.isActive,
  }
}

function venueBotConfigurationState(
  row: Record<string, unknown> | null | undefined,
  venue: Record<string, unknown>,
) {
  const tone = resolveEffectiveTone({
    tonePreset: typeof venue.tonePreset === 'string' ? venue.tonePreset : null,
    tonePresetVersion: typeof venue.tonePresetVersion === 'number' ? venue.tonePresetVersion : null,
    aiTone: typeof venue.aiTone === 'string' ? venue.aiTone : null,
  })
  return {
    presentationMode: row?.presentationMode ?? 'CLASSIC',
    personalityMode: row?.personalityMode ?? 'PRESET',
    tonePreset: row?.tonePreset ?? tone.preset,
    tonePresetVersion: row?.tonePresetVersion ?? tone.behaviorVersion,
    personalityProfileId: row?.personalityProfileId ?? null,
    characterKey: row?.characterKey ?? null,
    customCharacterId: row?.customCharacterId ?? null,
    publicDisplayName: row?.publicDisplayName ?? null,
    greeting: row?.greeting ?? null,
    voiceProfileId: row?.voiceProfileId ?? null,
  }
}

function sourcedState(row: Record<string, unknown>) {
  return {
    sourceType: row.sourceType,
    authorship: row.authorship,
    sourceName: row.sourceName,
    sourceUrl: row.sourceUrl,
    importedAt: iso(row.importedAt as Date | null),
    humanConfirmedAt: iso(row.humanConfirmedAt as Date | null),
    humanConfirmedBy: row.humanConfirmedBy,
    lastReviewedAt: iso(row.lastReviewedAt as Date | null),
    lastReviewedBy: row.lastReviewedBy,
    sourcePackageId: row.sourcePackageId,
  }
}

function typedPayload(revision: Record<string, any>) {
  const kind = revision.kind as string
  if (kind === 'SERVICE')
    return {
      kind,
      name: revision.service.name,
      description: revision.service.description,
      availability: revision.service.availability,
      placeId: revision.service.placeId,
    }
  if (kind === 'POLICY')
    return {
      kind,
      title: revision.policy.title,
      rule: revision.policy.rule,
      appliesTo: revision.policy.appliesTo,
    }
  if (kind === 'EVENT')
    return {
      kind,
      name: revision.event.name,
      description: revision.event.description,
      startsAt: revision.event.startsAt.toISOString(),
      endsAt: iso(revision.event.endsAt),
      placeId: revision.event.placeId,
    }
  if (kind === 'OPERATIONAL_FACT')
    return {
      kind,
      label: revision.operationalFact.label,
      value: revision.operationalFact.value,
      expiresAt: iso(revision.operationalFact.expiresAt),
    }
  return {
    kind: 'RELATIONSHIP',
    fromModuleId: revision.relationship.fromModuleId,
    toModuleId: revision.relationship.toModuleId,
    relationshipType: revision.relationship.relationshipType,
    description: revision.relationship.description,
  }
}

const revisionInclude = {
  evidence: { orderBy: [{ sourceId: 'asc' }, { locator: 'asc' }] },
  service: true,
  policy: true,
  event: true,
  operationalFact: true,
  relationship: true,
}

async function projectLocked(tx: NativeVenueDeploymentClient, scope: Scope) {
  const venue = await tx.venue.findFirst({ where: { id: scope.venueId, tenantId: scope.tenantId } })
  if (!venue) throw new NativeVenueDeploymentError('NOT_FOUND', 'Venue was not found.')
  const [places, knowledge, headIds, venueBotConfiguration] = await Promise.all([
    tx.place.findMany({
      where: { tenantId: scope.tenantId, venueId: scope.venueId, isActive: true },
      orderBy: { id: 'asc' },
      take: 1_001,
    }),
    tx.venueKnowledgeEntry.findMany({
      where: { tenantId: scope.tenantId, venueId: scope.venueId, isEnabled: true },
      orderBy: { id: 'asc' },
      take: 1_001,
    }),
    tx.$queryRaw<Array<{ id: string }>>`
      SELECT head.id FROM (
        SELECT DISTINCT ON (p.module_id) p.id, p.module_id, p.action
        FROM content_module_publications p
        WHERE p.tenant_id = ${scope.tenantId} AND p.venue_id = ${scope.venueId}
        ORDER BY p.module_id, p.event_order DESC
      ) head
      WHERE head.action = 'PUBLISH'
      ORDER BY head.module_id
      LIMIT 1001
    `,
    tx.venueBotConfiguration?.findUnique
      ? tx.venueBotConfiguration.findUnique({
          where: {
            tenantId_venueId: { tenantId: scope.tenantId, venueId: scope.venueId },
          },
        })
      : Promise.resolve(null),
  ])
  if (places.length > 1_000 || knowledge.length > 1_000)
    throw new NativeVenueDeploymentError(
      'PRECONDITION_FAILED',
      'Visible venue state exceeds native profile bounds.',
    )
  if (headIds.length > 1_000)
    throw new NativeVenueDeploymentError(
      'PRECONDITION_FAILED',
      'Published module state exceeds native profile bounds.',
    )
  const publications = headIds.length
    ? await tx.contentModulePublication.findMany({
        where: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          id: { in: headIds.map((item: { id: string }) => item.id) },
        },
        include: { revision: { include: revisionInclude } },
      })
    : []
  const published = publications
    .filter((item: any): item is NonNullable<typeof item> => item !== null)
    .filter((item: any) => item.action === 'PUBLISH')
    .sort((a: any, b: any) => a.moduleId.localeCompare(b.moduleId))
  if (published.some((item: any) => item.moduleKind === 'ITEM'))
    throw new NativeVenueDeploymentError(
      'PRECONDITION_FAILED',
      'Published ITEM content is outside NATIVE_CORE_V1.',
    )
  if (published.length > 1_000)
    throw new NativeVenueDeploymentError(
      'PRECONDITION_FAILED',
      'Published module state exceeds native profile bounds.',
    )
  const state = NativeCoreVisibleState.parse({
    venue: venueState(venue),
    venueBotConfiguration: venueBotConfigurationState(venueBotConfiguration, venue),
    places: places.map((item: Record<string, unknown>) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      itemType: item.itemType,
      shortDescription: item.shortDescription,
      longDescription: item.longDescription,
      lat: item.lat,
      lng: item.lng,
      tags: item.tags,
      importanceScore: item.importanceScore,
      areaName: item.areaName,
      hours: item.hours,
      photoUrl: item.photoUrl,
      isActive: true,
      ...sourcedState(item),
    })),
    knowledgeEntries: knowledge.map((item: Record<string, unknown>) => ({
      id: item.id,
      title: item.title,
      category: item.category,
      content: item.content,
      isEnabled: true,
      ...sourcedState(item),
    })),
    generalizedModules: published.map((item: any) => ({
      moduleId: item.moduleId,
      kind: item.moduleKind,
      version: item.revision.version,
      revisionId: item.revisionId,
      audience: item.revision.audience,
      effectiveFrom: iso(item.revision.effectiveFrom),
      effectiveUntil: iso(item.revision.effectiveUntil),
      evidence: item.revision.evidence.map((e: Record<string, unknown>) => ({
        sourceId: e.sourceId,
        locator: e.locator,
        capturedAt: (e.capturedAt as Date).toISOString(),
        excerptHash: e.excerptHash,
      })),
      payload: typedPayload(item.revision),
      publication: { status: 'PUBLISHED', revisionId: item.revisionId },
    })),
  })
  const universe = {
    activePlaceIds: state.places.map((item) => item.id),
    enabledKnowledgeEntryIds: state.knowledgeEntries.map((item) => item.id),
    publishedGeneralizedHeads: published.map((item: any) => ({
      moduleId: item.moduleId,
      kind: item.moduleKind,
      revisionId: item.revisionId,
      version: item.revision.version,
      publicationId: item.id,
      eventOrder: String(item.eventOrder),
    })),
  }
  return { state, universe, stateHash: stateHash(state) }
}

async function validateSourcePackages(
  tx: NativeVenueDeploymentClient,
  scope: Scope,
  manifest: NativeManifest,
) {
  const ids = [
    ...new Set(
      [...manifest.places, ...manifest.knowledgeEntries]
        .map((item) => item.sourcePackageId)
        .filter((id): id is string => id !== null),
    ),
  ]
  if (!ids.length) return
  const count = await tx.venuePackage.count({
    where: { tenantId: scope.tenantId, venueId: scope.venueId, id: { in: ids } },
  })
  if (count !== ids.length)
    throw new NativeVenueDeploymentError(
      'PRECONDITION_FAILED',
      'A source package is outside the exact venue scope.',
    )
}

function sameUniverse(actual: Omit<BaseUniverse, 'stateHash'>, expected: BaseUniverse) {
  return (
    JSON.stringify(actual) ===
    JSON.stringify({
      activePlaceIds: [...expected.activePlaceIds].sort(),
      enabledKnowledgeEntryIds: [...expected.enabledKnowledgeEntryIds].sort(),
      publishedGeneralizedHeads: [...expected.publishedGeneralizedHeads].sort((a, b) =>
        a.moduleId.localeCompare(b.moduleId),
      ),
    })
  )
}

async function validateVenueBotConfigurationReferences(
  tx: NativeVenueDeploymentClient,
  scope: Scope,
  configuration: VisibleState['venueBotConfiguration'],
) {
  if (configuration.personalityProfileId) {
    const profile = await tx.personalityProfile.findFirst({
      where: {
        id: configuration.personalityProfileId,
        tenantId: scope.tenantId,
        status: 'ACTIVE',
        OR: [{ venueId: scope.venueId }, { venueId: null }],
      },
      select: { id: true },
    })
    if (!profile)
      throw new NativeVenueDeploymentError(
        'PRECONDITION_FAILED',
        'Venue Bot personality profile is outside the exact deployment scope.',
      )
  }
  if (configuration.customCharacterId) {
    const character = await tx.customCharacter.findFirst({
      where: {
        id: configuration.customCharacterId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        status: 'ACTIVE',
      },
      select: { id: true },
    })
    if (!character)
      throw new NativeVenueDeploymentError(
        'PRECONDITION_FAILED',
        'Custom character is outside the exact deployment scope.',
      )
  }
}

function plannedEffects(
  venueId: string,
  before: VisibleState,
  desired: VisibleState,
  hiddenPlaces: Record<string, unknown>,
  hiddenKnowledge: Record<string, unknown>,
) {
  const list: Array<{
    kind: string
    targetId: string
    beforeHash: string
    afterHash: string
    beforeState: ReturnType<typeof envelope>
    afterState: ReturnType<typeof envelope>
  }> = []
  const add = (kind: string, targetId: string, old: unknown | null, next: unknown | null) =>
    list.push({
      kind,
      targetId,
      beforeHash: hashEnvelope(old),
      afterHash: hashEnvelope(next),
      beforeState: envelope(old),
      afterState: envelope(next),
    })
  if (JSON.stringify(before.venue) !== JSON.stringify(desired.venue))
    add('VENUE', venueId, before.venue, desired.venue)
  if (
    JSON.stringify(before.venueBotConfiguration) !== JSON.stringify(desired.venueBotConfiguration)
  )
    add(
      'VENUE_BOT_CONFIGURATION',
      venueId,
      before.venueBotConfiguration,
      desired.venueBotConfiguration,
    )
  const entities = <T extends { id: string }>(
    kind: string,
    left: T[],
    right: T[],
    hidden: Record<string, unknown>,
  ) => {
    const a = new Map(left.map((item) => [item.id, item]))
    const b = new Map(right.map((item) => [item.id, item]))
    for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const visibleOld = a.get(id) ?? null
      const next = b.get(id) ?? null
      if (JSON.stringify(visibleOld) !== JSON.stringify(next)) {
        const old = hidden[id] ? { runtimeVisible: false, row: hidden[id] } : visibleOld
        const after =
          next ??
          (visibleOld
            ? {
                runtimeVisible: false,
                row: {
                  ...visibleOld,
                  ...(kind === 'PLACE' ? { isActive: false } : { isEnabled: false }),
                },
              }
            : null)
        add(kind, id, old, after)
      }
    }
  }
  entities('PLACE', before.places, desired.places, hiddenPlaces)
  entities('KNOWLEDGE', before.knowledgeEntries, desired.knowledgeEntries, hiddenKnowledge)
  const a = new Map(before.generalizedModules.map((item) => [item.moduleId, item]))
  const b = new Map(desired.generalizedModules.map((item) => [item.moduleId, item]))
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const old = a.get(id) ?? null
    const next = b.get(id) ?? null
    if (JSON.stringify(old) === JSON.stringify(next)) continue
    if (next) add('GENERALIZED_MODULE', id, old, next)
    add('GENERALIZED_PUBLICATION', id, old, next)
  }
  return list.map((item, index) => ({ ...item, effectOrder: index + 1 }))
}

export async function projectNativeVenueStateAction(
  client: NativeVenueDeploymentClient,
  scope: Scope,
) {
  return client.$transaction(async (tx: NativeVenueDeploymentClient) => {
    await lockVenueContentMutation(tx, scope)
    return projectLocked(tx, scope)
  }, txOptions)
}

export function classifyNativeContentConvergence(input: {
  current: Awaited<ReturnType<typeof projectNativeVenueStateAction>>
  head: NativeContentConvergenceHead
}) {
  const headValid = Boolean(
    input.head &&
    input.head.release.id === input.head.releaseId &&
    input.head.release.artifactId === input.head.artifactId &&
    input.head.release.manifestHash === input.head.manifestHash &&
    input.head.release.desiredStateHash === input.head.stateHash &&
    input.head.release.status === 'APPLIED',
  )
  const stateMatchesHead = Boolean(
    input.head && headValid && input.current.stateHash === input.head.stateHash,
  )
  const phase: NativeContentConvergencePhase = !input.head
    ? 'NO_NATIVE_HEAD'
    : !headValid
      ? 'NATIVE_HEAD_INVALID'
      : !stateMatchesHead
        ? 'NATIVE_HEAD_DRIFTED'
        : 'NATIVE_HEAD_IN_SYNC'
  const blockers: NativeContentConvergenceBlocker[] = [
    ...(!input.head
      ? (['NO_NATIVE_HEAD'] as const)
      : !headValid
        ? (['INVALID_NATIVE_HEAD'] as const)
        : !stateMatchesHead
          ? (['MATERIALIZED_STATE_DRIFT'] as const)
          : []),
    'LEGACY_SEMANTIC_READ_PATH',
  ]

  return {
    contractVersion: 1 as const,
    phase,
    guestReadPath: NATIVE_GUEST_CONTENT_READ_PATH,
    headValid,
    stateMatchesHead,
    readyForShadowEvaluation: phase === 'NATIVE_HEAD_IN_SYNC',
    readyForLegacyRetirement: false as const,
    needsOperatorAttention: phase === 'NATIVE_HEAD_INVALID' || phase === 'NATIVE_HEAD_DRIFTED',
    blockers,
    counts: {
      activePlaces: input.current.state.places.length,
      enabledKnowledgeEntries: input.current.state.knowledgeEntries.length,
      publishedGeneralizedModules: input.current.state.generalizedModules.length,
    },
    venueActive: input.current.state.venue.isActive,
    currentStateHash: input.current.stateHash,
    head: input.head
      ? {
          releaseId: input.head.releaseId,
          revision: input.head.revision,
          updatedAt: input.head.updatedAt,
          stateHash: input.head.stateHash,
          desiredStateHash: input.head.release.desiredStateHash,
          releaseStatus: input.head.release.status,
        }
      : null,
  }
}

/**
 * Measures whether the mutable materialized guest-content state still matches the
 * exact native deployment head. This is observation only: it neither changes the
 * guest read path nor authorizes compatibility-table retirement.
 */
export async function measureNativeContentConvergenceAction(
  client: NativeVenueDeploymentClient,
  scope: Scope,
) {
  if (!scope.tenantId.trim() || !scope.venueId.trim())
    throw new NativeVenueDeploymentError(
      'INVALID_INPUT',
      'Exact tenant and venue scope is required.',
    )
  return client.$transaction(async (tx: NativeVenueDeploymentClient) => {
    await lockVenueContentMutation(tx, scope)
    const current = await projectLocked(tx, scope)
    const head = await tx.nativeVenueDeploymentHead.findFirst({
      where: { tenantId: scope.tenantId, venueId: scope.venueId },
      select: {
        releaseId: true,
        artifactId: true,
        manifestHash: true,
        stateHash: true,
        revision: true,
        updatedAt: true,
        release: {
          select: {
            id: true,
            artifactId: true,
            manifestHash: true,
            desiredStateHash: true,
            status: true,
          },
        },
      },
    })
    return classifyNativeContentConvergence({ current, head })
  }, txOptions)
}

export async function createNativeVenueDeploymentAction(
  input: Scope & { manifest: unknown; actor: NativeVenueDeploymentActor },
  client: NativeVenueDeploymentClient,
) {
  assertActor(input.actor)
  const parsedManifest = NativeCoreFullManifest.parse(input.manifest)
  if (
    parsedManifest.venueRef !== input.venueId ||
    parsedManifest.provenance.createdBy.actorRef !== input.actor.id
  )
    throw new NativeVenueDeploymentError(
      'INVALID_INPUT',
      'Manifest scope or actor evidence does not match.',
    )
  const canonicalManifest = JSON.parse(canonicalNativeCoreFullManifest(parsedManifest))
  const manifest = NativeCoreFullManifest.parse(canonicalManifest)
  const manifestHash = nativeCoreFullManifestHash(manifest)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.$transaction(async (tx: NativeVenueDeploymentClient) => {
        await lockVenueContentMutation(tx, input)
        const replay = await tx.nativeVenueDeploymentArtifact.findFirst({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            idempotencyKey: manifest.idempotencyKey,
          },
          include: { release: true },
        })
        if (replay) {
          if (replay.manifestHash !== manifestHash)
            throw new NativeVenueDeploymentError(
              'CONFLICT',
              'Idempotency key was already used for different input.',
            )
          if (
            !replay.release ||
            replay.release.artifactId !== replay.id ||
            replay.release.profile !== replay.profile ||
            replay.release.manifestHash !== replay.manifestHash
          )
            throw new NativeVenueDeploymentError(
              'CONFLICT',
              'Stored native deployment evidence is incomplete.',
            )
          return replay.release
        }
        const current = await projectLocked(tx, input)
        if (
          manifest.baseState.stateHash !== current.stateHash ||
          !sameUniverse(current.universe, manifest.baseState)
        )
          throw new NativeVenueDeploymentError(
            'PRECONDITION_FAILED',
            'Manifest base state is stale.',
          )
        await validateSourcePackages(tx, input, manifest)
        const desired = NativeCoreVisibleState.parse({
          venue: manifest.venue,
          venueBotConfiguration:
            manifest.venueBotConfiguration ?? current.state.venueBotConfiguration,
          places: manifest.places,
          knowledgeEntries: manifest.knowledgeEntries,
          generalizedModules: manifest.generalizedModules,
        })
        await validateVenueBotConfigurationReferences(tx, input, desired.venueBotConfiguration)
        const [placeRows, knowledgeRows, identities, revisionRows] = await Promise.all([
          tx.place.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              id: { in: desired.places.map((item) => item.id) },
            },
          }),
          tx.venueKnowledgeEntry.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              id: { in: desired.knowledgeEntries.map((item) => item.id) },
            },
          }),
          tx.contentModuleIdentity.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              id: { in: desired.generalizedModules.map((item) => item.moduleId) },
            },
            include: { revisions: { orderBy: { version: 'desc' }, take: 1 } },
          }),
          tx.contentModuleRevision.findMany({
            where: { id: { in: desired.generalizedModules.map((item) => item.revisionId) } },
            select: {
              id: true,
              tenantId: true,
              venueId: true,
              moduleId: true,
              kind: true,
              version: true,
            },
          }),
        ])
        const visiblePlaceIds = new Set(current.state.places.map((item) => item.id))
        const visibleKnowledgeIds = new Set(current.state.knowledgeEntries.map((item) => item.id))
        const currentModules = new Map(
          current.state.generalizedModules.map((item) => [item.moduleId, item]),
        )
        const hiddenPlaces = Object.fromEntries(
          placeRows
            .filter((row: { id: string }) => !visiblePlaceIds.has(row.id))
            .map((row: { id: string }) => [row.id, row]),
        )
        const hiddenKnowledge = Object.fromEntries(
          knowledgeRows
            .filter((row: { id: string }) => !visibleKnowledgeIds.has(row.id))
            .map((row: { id: string }) => [row.id, row]),
        )
        const identityById = new Map(identities.map((row: { id: string }) => [row.id, row]))
        const revisionById = new Map(revisionRows.map((row: { id: string }) => [row.id, row]))
        for (const item of desired.generalizedModules) {
          const revisionCollision = revisionById.get(item.revisionId) as
            | { tenantId: string; venueId: string; moduleId: string; kind: string; version: number }
            | undefined
          if (
            revisionCollision &&
            (revisionCollision.tenantId !== input.tenantId ||
              revisionCollision.venueId !== input.venueId ||
              revisionCollision.moduleId !== item.moduleId ||
              revisionCollision.kind !== item.kind ||
              revisionCollision.version !== item.version)
          )
            throw new NativeVenueDeploymentError(
              'PRECONDITION_FAILED',
              'A revision identifier is already bound to different evidence.',
            )
          const identity = identityById.get(item.moduleId) as
            | { kind: string; revisions: Array<{ id: string; version: number }> }
            | undefined
          const visible = currentModules.get(item.moduleId)
          if (identity && identity.kind !== item.kind)
            throw new NativeVenueDeploymentError(
              'PRECONDITION_FAILED',
              'A module identifier belongs to a different kind.',
            )
          if (visible && JSON.stringify(visible) === JSON.stringify(item)) {
            if (!revisionCollision)
              throw new NativeVenueDeploymentError(
                'PRECONDITION_FAILED',
                'Published revision evidence is missing.',
              )
            continue
          }
          if (revisionCollision)
            throw new NativeVenueDeploymentError(
              'PRECONDITION_FAILED',
              'A changed module must use a new revision identifier.',
            )
          const latest = identity?.revisions[0]
          if (latest && (item.version !== latest.version + 1 || item.revisionId === latest.id))
            throw new NativeVenueDeploymentError(
              'PRECONDITION_FAILED',
              'A changed module must use the exact next revision version and a new revision identifier.',
            )
          if (!latest && item.version !== 1)
            throw new NativeVenueDeploymentError(
              'PRECONDITION_FAILED',
              'A new module must begin at version one.',
            )
        }
        const desiredStateHash = stateHash(desired)
        const prior = await tx.nativeVenueDeploymentHead.findFirst({
          where: { tenantId: input.tenantId, venueId: input.venueId },
        })
        const priorHead = prior ? { ...prior, updatedAt: prior.updatedAt.toISOString() } : null
        const effects = plannedEffects(
          input.venueId,
          current.state,
          desired,
          hiddenPlaces,
          hiddenKnowledge,
        )
        const plan: Plan = {
          before: current.state,
          desired,
          priorHead,
          hiddenPlaces,
          hiddenKnowledge,
          effects,
        }
        const planHash = sha256Hex(JSON.stringify(plan))
        await tx.nativeVenueDeploymentArtifact.create({
          data: {
            id: manifest.manifestId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            profile: 'NATIVE_CORE_V1',
            idempotencyKey: manifest.idempotencyKey,
            canonicalManifest,
            manifestHash,
            baseStateHash: current.stateHash,
            desiredStateHash,
            baseUniverse: manifest.baseState,
            createdBy: input.actor.id,
          },
        })
        const release = await tx.nativeVenueDeploymentRelease.create({
          data: {
            id: manifest.manifestId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            artifactId: manifest.manifestId,
            profile: 'NATIVE_CORE_V1',
            manifestHash,
            baseStateHash: current.stateHash,
            desiredStateHash,
            planHash,
            expectedEffectCount: effects.length,
            replacementUniverse: manifest.baseState,
            plan,
            createdBy: input.actor.id,
          },
        })
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: input.actor.id,
            actorRole: 'PLATFORM_ADMIN',
            action: 'native_venue_deployment.created',
            targetType: 'NativeVenueDeploymentRelease',
            targetId: release.id,
            beforeState: { status: 'ABSENT' },
            afterState: {
              venueId: input.venueId,
              status: 'DRAFT',
              manifestHash,
              profile: 'NATIVE_CORE_V1',
            },
          },
          tx,
        )
        return release
      }, txOptions)
    } catch (error) {
      if (!isRetryable(error) || attempt === 2) throw error
    }
  }
  throw new NativeVenueDeploymentError('CONFLICT', 'Deployment transaction did not converge.')
}

function commandHash(
  input: Scope & { releaseId: string; commandId: string; expectedUpdatedAt: string },
  kind: string,
  actorId: string,
) {
  return sha256Hex(
    JSON.stringify({
      version: 1,
      kind,
      tenantId: input.tenantId,
      venueId: input.venueId,
      releaseId: input.releaseId,
      commandId: input.commandId,
      expectedUpdatedAt: input.expectedUpdatedAt,
      actorId,
    }),
  )
}

async function replayCommand(
  tx: NativeVenueDeploymentClient,
  input: Scope & { commandId: string },
  hash: string,
) {
  const receipt = await tx.nativeVenueDeploymentCommand.findFirst({
    where: { id: input.commandId, tenantId: input.tenantId, venueId: input.venueId },
  })
  if (!receipt) return null
  if (receipt.commandHash !== hash)
    throw new NativeVenueDeploymentError(
      'CONFLICT',
      'Command identifier was reused for different input.',
    )
  return receipt.producedSnapshot
}

export async function approveNativeVenueDeploymentAction(
  input: Scope & {
    releaseId: string
    commandId: string
    expectedUpdatedAt: string
    actor: NativeVenueDeploymentActor
  },
  client: NativeVenueDeploymentClient,
) {
  assertActor(input.actor)
  const hash = commandHash(input, 'APPROVE', input.actor.id)
  return lifecycleWithRetry(client, async (tx) => {
    await lockVenueContentMutation(tx, input)
    const replay = await replayCommand(tx, input, hash)
    if (replay) return replay
    const now = new Date()
    const updated = await tx.nativeVenueDeploymentRelease.updateMany({
      where: {
        id: input.releaseId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'DRAFT',
        updatedAt: new Date(input.expectedUpdatedAt),
      },
      data: {
        status: 'APPROVED',
        approvedBy: input.actor.id,
        approvedAt: now,
        approvedCommandId: input.commandId,
        approvedCommandHash: hash,
        updatedAt: now,
      },
    })
    if (updated.count !== 1)
      throw new NativeVenueDeploymentError('PRECONDITION_FAILED', 'Release approval state changed.')
    const snapshot = {
      releaseId: input.releaseId,
      status: 'APPROVED' as const,
      updatedAt: now.toISOString(),
      head: null,
    }
    await recordCommand(tx, input, input.actor.id, hash, 'APPROVE', 'APPROVED', snapshot)
    return snapshot
  })
}

async function lifecycleWithRetry(
  client: NativeVenueDeploymentClient,
  action: (tx: NativeVenueDeploymentClient) => Promise<unknown>,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.$transaction(action, txOptions)
    } catch (error) {
      if (!isRetryable(error) || attempt === 2) throw error
    }
  }
  throw new NativeVenueDeploymentError('CONFLICT', 'Deployment command did not converge.')
}

async function recordCommand(
  tx: NativeVenueDeploymentClient,
  input: Scope & { releaseId: string; commandId: string },
  actorId: string,
  hash: string,
  kind: string,
  status: string,
  snapshot: unknown,
) {
  await tx.nativeVenueDeploymentCommand.create({
    data: {
      id: input.commandId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      releaseId: input.releaseId,
      kind,
      commandHash: hash,
      actorId,
      producedStatus: status,
      producedSnapshot: snapshot,
      createdAt: new Date((snapshot as { updatedAt: string }).updatedAt),
    },
  })
  const priorStatus = kind === 'APPROVE' ? 'DRAFT' : kind === 'APPLY' ? 'APPROVED' : 'APPLIED'
  await writeAuditLogStrict(
    {
      tenantId: input.tenantId,
      actorId,
      actorRole: 'PLATFORM_ADMIN',
      action: `native_venue_deployment.${kind.toLowerCase()}`,
      targetType: 'NativeVenueDeploymentRelease',
      targetId: input.releaseId,
      beforeState: { venueId: input.venueId, status: priorStatus },
      afterState: { venueId: input.venueId, status, commandId: input.commandId },
    },
    tx,
  )
}

const toDate = (value: string | null) => (value === null ? null : new Date(value))
function sourceData(
  item: NativeManifest['places'][number] | NativeManifest['knowledgeEntries'][number],
) {
  return {
    sourceType: item.sourceType,
    authorship: item.authorship,
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
    importedAt: toDate(item.importedAt),
    humanConfirmedAt: toDate(item.humanConfirmedAt),
    humanConfirmedBy: item.humanConfirmedBy,
    lastReviewedAt: toDate(item.lastReviewedAt),
    lastReviewedBy: item.lastReviewedBy,
    sourcePackageId: item.sourcePackageId,
  }
}
function placeData(item: NativeManifest['places'][number], scope: Scope) {
  return {
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    name: item.name,
    type: item.type,
    itemType: item.itemType,
    shortDescription: item.shortDescription,
    longDescription: item.longDescription,
    lat: item.lat,
    lng: item.lng,
    tags: item.tags,
    importanceScore: item.importanceScore,
    areaName: item.areaName,
    hours: item.hours,
    photoUrl: item.photoUrl,
    isActive: true,
    ...sourceData(item),
  }
}
function knowledgeData(item: NativeManifest['knowledgeEntries'][number], scope: Scope) {
  return {
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    title: item.title,
    category: item.category,
    content: item.content,
    isEnabled: true,
    ...sourceData(item),
  }
}
function placeRowState(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    itemType: row.itemType,
    shortDescription: row.shortDescription,
    longDescription: row.longDescription,
    lat: row.lat,
    lng: row.lng,
    tags: row.tags,
    importanceScore: row.importanceScore,
    areaName: row.areaName,
    hours: row.hours,
    photoUrl: row.photoUrl,
    isActive: row.isActive,
    ...sourcedState(row),
  }
}
function knowledgeRowState(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    content: row.content,
    isEnabled: row.isEnabled,
    ...sourcedState(row),
  }
}
function venueData(item: NativeManifest['venue']) {
  return { ...item }
}
function hiddenRowData(row: Record<string, unknown>) {
  const data = { ...row }
  delete data.id
  delete data.tenantId
  delete data.venueId
  delete data.createdAt
  delete data.updatedAt
  for (const key of ['importedAt', 'humanConfirmedAt', 'lastReviewedAt'])
    if (typeof data[key] === 'string') data[key] = new Date(data[key] as string)
  return data
}

async function createRevision(
  tx: NativeVenueDeploymentClient,
  scope: Scope,
  item: NativeManifest['generalizedModules'][number],
  actorId: string,
) {
  await tx.contentModuleIdentity.upsert({
    where: {
      id_tenantId_venueId: { id: item.moduleId, tenantId: scope.tenantId, venueId: scope.venueId },
    },
    create: {
      id: item.moduleId,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      kind: item.kind,
    },
    update: {},
  })
  await tx.contentModuleRevision.create({
    data: {
      id: item.revisionId,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      moduleId: item.moduleId,
      kind: item.kind,
      version: item.version,
      audience: 'PUBLIC',
      effectiveFrom: toDate(item.effectiveFrom),
      effectiveUntil: toDate(item.effectiveUntil),
      createdBy: actorId,
    },
  })
  if (item.evidence.length)
    await tx.contentModuleEvidence.createMany({
      data: item.evidence.map((e) => ({
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        revisionId: item.revisionId,
        moduleKind: item.kind,
        sourceId: e.sourceId,
        locator: e.locator,
        capturedAt: new Date(e.capturedAt),
        excerptHash: e.excerptHash,
      })),
    })
  const base = {
    revisionId: item.revisionId,
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    kind: item.kind,
  }
  if (item.payload.kind === 'SERVICE')
    await tx.serviceContent.create({
      data: {
        ...base,
        name: item.payload.name,
        description: item.payload.description,
        availability: item.payload.availability,
        placeId: item.payload.placeId,
      },
    })
  else if (item.payload.kind === 'POLICY')
    await tx.policyContent.create({
      data: {
        ...base,
        title: item.payload.title,
        rule: item.payload.rule,
        appliesTo: item.payload.appliesTo,
      },
    })
  else if (item.payload.kind === 'EVENT')
    await tx.eventContent.create({
      data: {
        ...base,
        name: item.payload.name,
        description: item.payload.description,
        startsAt: new Date(item.payload.startsAt),
        endsAt: toDate(item.payload.endsAt),
        placeId: item.payload.placeId,
      },
    })
  else if (item.payload.kind === 'OPERATIONAL_FACT')
    await tx.operationalFactContent.create({
      data: {
        ...base,
        label: item.payload.label,
        value: item.payload.value,
        expiresAt: toDate(item.payload.expiresAt),
      },
    })
  else
    await tx.relationshipContent.create({
      data: {
        ...base,
        fromModuleId: item.payload.fromModuleId,
        toModuleId: item.payload.toModuleId,
        relationshipType: item.payload.relationshipType,
        description: item.payload.description,
      },
    })
}

async function publish(
  tx: NativeVenueDeploymentClient,
  scope: Scope,
  item: NativeManifest['generalizedModules'][number],
  actorId: string,
  requestId: string,
) {
  return tx.contentModulePublication.create({
    data: {
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      moduleId: item.moduleId,
      revisionId: item.revisionId,
      moduleKind: item.kind,
      action: 'PUBLISH',
      requestId,
      actorId,
    },
  })
}

async function recordEffect(
  tx: NativeVenueDeploymentClient,
  scope: Scope & { releaseId: string; plan: Plan },
  order: number,
  kind: string,
  targetId: string,
  before: unknown | null,
  after: unknown | null,
) {
  const planned = scope.plan.effects[order - 1]
  if (
    !planned ||
    planned.effectOrder !== order ||
    planned.kind !== kind ||
    planned.targetId !== targetId ||
    !sameJsonValue(planned.beforeState, envelope(before)) ||
    !sameJsonValue(planned.afterState, envelope(after))
  )
    throw new NativeVenueDeploymentError(
      'CONFLICT',
      'Runtime effect diverged from the immutable release plan.',
    )
  return tx.nativeVenueDeploymentEffect.create({
    data: {
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      releaseId: scope.releaseId,
      effectOrder: planned.effectOrder,
      kind: planned.kind,
      targetId: planned.targetId,
      beforeState: planned.beforeState,
      afterState: planned.afterState,
      beforeHash: planned.beforeHash,
      afterHash: planned.afterHash,
    },
  })
}

async function applyVisibleState(
  tx: NativeVenueDeploymentClient,
  scope: Scope & { releaseId: string; plan: Plan },
  before: VisibleState,
  desired: VisibleState,
  actorId: string,
) {
  let order = 1
  const venueChanged = JSON.stringify(before.venue) !== JSON.stringify(desired.venue)
  const venueBotChanged =
    JSON.stringify(before.venueBotConfiguration) !== JSON.stringify(desired.venueBotConfiguration)
  if (venueChanged)
    await recordEffect(tx, scope, order++, 'VENUE', scope.venueId, before.venue, desired.venue)
  if (venueBotChanged) {
    await recordEffect(
      tx,
      scope,
      order++,
      'VENUE_BOT_CONFIGURATION',
      scope.venueId,
      before.venueBotConfiguration,
      desired.venueBotConfiguration,
    )
    await tx.venueBotConfiguration.upsert({
      where: {
        tenantId_venueId: { tenantId: scope.tenantId, venueId: scope.venueId },
      },
      create: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        ...desired.venueBotConfiguration,
        createdBy: actorId,
        updatedBy: actorId,
      },
      update: {
        ...desired.venueBotConfiguration,
        revision: { increment: 1 },
        updatedBy: actorId,
      },
    })
  }
  const beforePlaces = new Map(before.places.map((item) => [item.id, item]))
  const desiredPlaces = new Map(desired.places.map((item) => [item.id, item]))
  for (const [id, old] of beforePlaces)
    if (!desiredPlaces.has(id)) {
      await recordEffect(tx, scope, order++, 'PLACE', id, old, {
        runtimeVisible: false,
        row: { ...old, isActive: false },
      })
      await tx.place.update({
        where: { id_tenantId_venueId: { id, tenantId: scope.tenantId, venueId: scope.venueId } },
        data: { isActive: false },
      })
    }
  for (const [id, item] of desiredPlaces) {
    const old = beforePlaces.get(id) ?? null
    const hidden = scope.plan.hiddenPlaces[id] ?? null
    if (JSON.stringify(old) === JSON.stringify(item)) continue
    await recordEffect(
      tx,
      scope,
      order++,
      'PLACE',
      id,
      hidden ? { runtimeVisible: false, row: hidden } : old,
      item,
    )
    await tx.place.upsert({
      where: { id_tenantId_venueId: { id, tenantId: scope.tenantId, venueId: scope.venueId } },
      create: { id, ...placeData(item, scope) },
      update: placeData(item, scope),
    })
  }
  const beforeKnowledge = new Map(before.knowledgeEntries.map((item) => [item.id, item]))
  const desiredKnowledge = new Map(desired.knowledgeEntries.map((item) => [item.id, item]))
  for (const [id, old] of beforeKnowledge)
    if (!desiredKnowledge.has(id)) {
      await recordEffect(tx, scope, order++, 'KNOWLEDGE', id, old, {
        runtimeVisible: false,
        row: { ...old, isEnabled: false },
      })
      const changed = await tx.venueKnowledgeEntry.updateMany({
        where: { id, tenantId: scope.tenantId, venueId: scope.venueId },
        data: { isEnabled: false },
      })
      if (changed.count !== 1)
        throw new NativeVenueDeploymentError('CONFLICT', 'Knowledge scope changed.')
    }
  for (const [id, item] of desiredKnowledge) {
    const old = beforeKnowledge.get(id) ?? null
    const hidden = scope.plan.hiddenKnowledge[id] ?? null
    if (JSON.stringify(old) === JSON.stringify(item)) continue
    await recordEffect(
      tx,
      scope,
      order++,
      'KNOWLEDGE',
      id,
      hidden ? { runtimeVisible: false, row: hidden } : old,
      item,
    )
    if (old || hidden) {
      const changed = await tx.venueKnowledgeEntry.updateMany({
        where: { id, tenantId: scope.tenantId, venueId: scope.venueId },
        data: knowledgeData(item, scope),
      })
      if (changed.count !== 1)
        throw new NativeVenueDeploymentError('CONFLICT', 'Knowledge scope changed.')
    } else await tx.venueKnowledgeEntry.create({ data: { id, ...knowledgeData(item, scope) } })
  }
  const beforeModules = new Map(before.generalizedModules.map((item) => [item.moduleId, item]))
  const desiredModules = new Map(desired.generalizedModules.map((item) => [item.moduleId, item]))
  for (const item of desiredModules.values())
    await tx.contentModuleIdentity.upsert({
      where: {
        id_tenantId_venueId: {
          id: item.moduleId,
          tenantId: scope.tenantId,
          venueId: scope.venueId,
        },
      },
      create: {
        id: item.moduleId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        kind: item.kind,
      },
      update: {},
    })
  for (const [id, old] of beforeModules)
    if (!desiredModules.has(id)) {
      const effect = await recordEffect(
        tx,
        scope,
        order++,
        'GENERALIZED_PUBLICATION',
        id,
        old,
        null,
      )
      const requestId = crypto.randomUUID()
      const publication = await tx.contentModulePublication.create({
        data: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          moduleId: id,
          revisionId: old.revisionId,
          moduleKind: old.kind,
          action: 'WITHDRAW',
          requestId,
          actorId,
        },
      })
      await tx.nativeVenueDeploymentPublicationLineage.create({
        data: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          effectId: effect.id,
          phase: 'APPLY',
          publicationId: publication.id,
          requestId,
        },
      })
    }
  for (const [id, item] of desiredModules) {
    const old = beforeModules.get(id) ?? null
    if (JSON.stringify(old) === JSON.stringify(item)) continue
    await recordEffect(tx, scope, order++, 'GENERALIZED_MODULE', id, old, item)
    if (!old || old.revisionId !== item.revisionId) await createRevision(tx, scope, item, actorId)
    const effect = await recordEffect(tx, scope, order++, 'GENERALIZED_PUBLICATION', id, old, item)
    const requestId = crypto.randomUUID()
    const publication = await publish(tx, scope, item, actorId, requestId)
    await tx.nativeVenueDeploymentPublicationLineage.create({
      data: {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        effectId: effect.id,
        phase: 'APPLY',
        publicationId: publication.id,
        requestId,
      },
    })
  }
  if (venueChanged)
    await tx.venue.update({
      where: { id_tenantId: { id: scope.venueId, tenantId: scope.tenantId } },
      data: venueData(desired.venue),
    })
  return order - 1
}

export const nativeVenueDeploymentTestHooks = {
  applyVisibleState,
  plannedEffects,
  sameJsonValue,
  validateVenueBotConfigurationReferences,
}

export async function applyNativeVenueDeploymentAction(
  input: Scope & {
    releaseId: string
    commandId: string
    expectedUpdatedAt: string
    actor: NativeVenueDeploymentActor
  },
  client: NativeVenueDeploymentClient,
) {
  assertActor(input.actor)
  const hash = commandHash(input, 'APPLY', input.actor.id)
  return lifecycleWithRetry(client, async (tx) => {
    await lockVenueContentMutation(tx, input)
    const replay = await replayCommand(tx, input, hash)
    if (replay) return replay
    const release = await tx.nativeVenueDeploymentRelease.findFirst({
      where: {
        id: input.releaseId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'APPROVED',
        updatedAt: new Date(input.expectedUpdatedAt),
      },
    })
    if (!release)
      throw new NativeVenueDeploymentError('PRECONDITION_FAILED', 'Release apply state changed.')
    const plan = release.plan as Plan
    const current = await projectLocked(tx, input)
    if (
      current.stateHash !== release.baseStateHash ||
      !sameUniverse(current.universe, release.replacementUniverse as BaseUniverse)
    )
      throw new NativeVenueDeploymentError(
        'PRECONDITION_FAILED',
        'Venue state changed after planning.',
      )
    const effectCount = await applyVisibleState(
      tx,
      { ...input, plan },
      plan.before,
      plan.desired,
      input.actor.id,
    )
    const materialized = await projectLocked(tx, input)
    if (materialized.stateHash !== release.desiredStateHash)
      throw new NativeVenueDeploymentError(
        'CONFLICT',
        'Native materialization did not exactly match its plan.',
      )
    const now = new Date()
    await tx.nativeVenueDeploymentRelease.update({
      where: { id: release.id },
      data: {
        status: 'APPLIED',
        appliedBy: input.actor.id,
        appliedAt: now,
        appliedCommandId: input.commandId,
        appliedCommandHash: hash,
        updatedAt: now,
      },
    })
    const priorRevision = plan.priorHead?.revision ?? 0
    const head = await tx.nativeVenueDeploymentHead.upsert({
      where: { tenantId_venueId: { tenantId: input.tenantId, venueId: input.venueId } },
      create: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        releaseId: release.id,
        artifactId: release.artifactId,
        manifestHash: release.manifestHash,
        stateHash: release.desiredStateHash,
        revision: 1,
        updatedAt: now,
      },
      update: {
        releaseId: release.id,
        artifactId: release.artifactId,
        manifestHash: release.manifestHash,
        stateHash: release.desiredStateHash,
        revision: priorRevision + 1,
        updatedAt: now,
      },
    })
    const snapshot = {
      releaseId: release.id,
      status: 'APPLIED' as const,
      updatedAt: now.toISOString(),
      effectCount,
      appliedUniverse: materialized.universe,
      head: { ...head, updatedAt: head.updatedAt.toISOString() },
    }
    await recordCommand(tx, input, input.actor.id, hash, 'APPLY', 'APPLIED', snapshot)
    return snapshot
  })
}

export async function revertNativeVenueDeploymentAction(
  input: Scope & {
    releaseId: string
    commandId: string
    expectedUpdatedAt: string
    actor: NativeVenueDeploymentActor
  },
  client: NativeVenueDeploymentClient,
) {
  assertActor(input.actor)
  const hash = commandHash(input, 'REVERT', input.actor.id)
  return lifecycleWithRetry(client, async (tx) => {
    await lockVenueContentMutation(tx, input)
    const replay = await replayCommand(tx, input, hash)
    if (replay) return replay
    const release = await tx.nativeVenueDeploymentRelease.findFirst({
      where: {
        id: input.releaseId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'APPLIED',
        updatedAt: new Date(input.expectedUpdatedAt),
      },
    })
    if (!release)
      throw new NativeVenueDeploymentError('PRECONDITION_FAILED', 'Release revert state changed.')
    const currentHead = await tx.nativeVenueDeploymentHead.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId },
    })
    if (
      !currentHead ||
      currentHead.releaseId !== release.id ||
      currentHead.artifactId !== release.artifactId ||
      currentHead.stateHash !== release.desiredStateHash
    )
      throw new NativeVenueDeploymentError(
        'PRECONDITION_FAILED',
        'A later native release replaced this release.',
      )
    const current = await projectLocked(tx, input)
    if (current.stateHash !== release.desiredStateHash)
      throw new NativeVenueDeploymentError(
        'PRECONDITION_FAILED',
        'Runtime state changed after apply.',
      )
    const applyReceipt = await tx.nativeVenueDeploymentCommand.findFirst({
      where: {
        id: release.appliedCommandId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        releaseId: release.id,
        kind: 'APPLY',
      },
    })
    const appliedUniverse = (
      applyReceipt?.producedSnapshot as { appliedUniverse?: BaseUniverse } | undefined
    )?.appliedUniverse
    if (!appliedUniverse || !sameUniverse(current.universe, appliedUniverse))
      throw new NativeVenueDeploymentError(
        'PRECONDITION_FAILED',
        'Applied publication head evidence changed after apply.',
      )
    const plan = release.plan as Plan
    const effects = await tx.nativeVenueDeploymentEffect.findMany({
      where: { releaseId: release.id, tenantId: input.tenantId, venueId: input.venueId },
      orderBy: { effectOrder: 'desc' },
    })
    let venueBefore: NativeManifest['venue'] | null = null
    for (const effect of effects) {
      const before = (effect.beforeState as { present: boolean; value: any }).value
      const after = (effect.afterState as { present: boolean; value: any }).value
      const planned = plan.effects[effect.effectOrder - 1]
      if (
        !planned ||
        planned.kind !== effect.kind ||
        planned.targetId !== effect.targetId ||
        planned.beforeHash !== effect.beforeHash ||
        planned.afterHash !== effect.afterHash ||
        !sameJsonValue(planned.beforeState, effect.beforeState) ||
        !sameJsonValue(planned.afterState, effect.afterState) ||
        !sameJsonValue(effect.beforeState, envelope(before)) ||
        !sameJsonValue(effect.afterState, envelope(after))
      )
        throw new NativeVenueDeploymentError(
          'CONFLICT',
          'Deployment effect evidence is inconsistent.',
        )
      if (effect.kind === 'VENUE') venueBefore = before
      else if (effect.kind === 'VENUE_BOT_CONFIGURATION') {
        const row = await tx.venueBotConfiguration.findUnique({
          where: {
            tenantId_venueId: { tenantId: input.tenantId, venueId: input.venueId },
          },
        })
        if (!row)
          throw new NativeVenueDeploymentError(
            'CONFLICT',
            'Applied Venue Bot configuration evidence is missing.',
          )
        const actual = venueBotConfigurationState(row, plan.desired.venue)
        if (!sameJsonValue(actual, after))
          throw new NativeVenueDeploymentError(
            'PRECONDITION_FAILED',
            'Venue Bot configuration changed after materialization.',
          )
        await tx.venueBotConfiguration.update({
          where: {
            tenantId_venueId: { tenantId: input.tenantId, venueId: input.venueId },
          },
          data: { ...before, revision: { increment: 1 }, updatedBy: input.actor.id },
        })
      } else if (effect.kind === 'PLACE') {
        const row = await tx.place.findFirst({
          where: { id: effect.targetId, tenantId: input.tenantId, venueId: input.venueId },
        })
        if (!row)
          throw new NativeVenueDeploymentError('CONFLICT', 'Applied place evidence is missing.')
        const actual =
          after?.runtimeVisible === false
            ? { runtimeVisible: false, row: placeRowState(row) }
            : placeRowState(row)
        if (!sameJsonValue(actual, after))
          throw new NativeVenueDeploymentError(
            'PRECONDITION_FAILED',
            'An applied place changed after materialization.',
          )
        if (before?.runtimeVisible === false) {
          await tx.place.update({
            where: {
              id_tenantId_venueId: {
                id: effect.targetId,
                tenantId: input.tenantId,
                venueId: input.venueId,
              },
            },
            data: hiddenRowData(before.row),
          })
          continue
        }
        if (before === null) {
          await tx.place.update({
            where: {
              id_tenantId_venueId: {
                id: effect.targetId,
                tenantId: input.tenantId,
                venueId: input.venueId,
              },
            },
            data: { isActive: false },
          })
        } else
          await tx.place.update({
            where: {
              id_tenantId_venueId: {
                id: effect.targetId,
                tenantId: input.tenantId,
                venueId: input.venueId,
              },
            },
            data: placeData(before, input),
          })
      } else if (effect.kind === 'KNOWLEDGE') {
        const row = await tx.venueKnowledgeEntry.findFirst({
          where: { id: effect.targetId, tenantId: input.tenantId, venueId: input.venueId },
        })
        if (!row)
          throw new NativeVenueDeploymentError('CONFLICT', 'Applied knowledge evidence is missing.')
        const actual =
          after?.runtimeVisible === false
            ? { runtimeVisible: false, row: knowledgeRowState(row) }
            : knowledgeRowState(row)
        if (!sameJsonValue(actual, after))
          throw new NativeVenueDeploymentError(
            'PRECONDITION_FAILED',
            'Applied knowledge changed after materialization.',
          )
        if (before?.runtimeVisible === false) {
          const changed = await tx.venueKnowledgeEntry.updateMany({
            where: { id: effect.targetId, tenantId: input.tenantId, venueId: input.venueId },
            data: hiddenRowData(before.row),
          })
          if (changed.count !== 1)
            throw new NativeVenueDeploymentError(
              'CONFLICT',
              'Knowledge scope changed during revert.',
            )
          continue
        }
        if (before === null) {
          await tx.venueKnowledgeEntry.updateMany({
            where: { id: effect.targetId, tenantId: input.tenantId, venueId: input.venueId },
            data: { isEnabled: false },
          })
        } else
          await tx.venueKnowledgeEntry.updateMany({
            where: { id: effect.targetId, tenantId: input.tenantId, venueId: input.venueId },
            data: knowledgeData(before, input),
          })
      } else if (effect.kind === 'GENERALIZED_PUBLICATION') {
        const reference = before ?? after
        const requestId = crypto.randomUUID()
        const publication = await tx.contentModulePublication.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            moduleId: effect.targetId,
            revisionId: reference.revisionId,
            moduleKind: reference.kind,
            action: before === null ? 'WITHDRAW' : 'PUBLISH',
            requestId,
            actorId: input.actor.id,
          },
        })
        await tx.nativeVenueDeploymentPublicationLineage.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            effectId: effect.id,
            phase: 'REVERT',
            publicationId: publication.id,
            requestId,
          },
        })
      }
    }
    if (venueBefore)
      await tx.venue.update({
        where: { id_tenantId: { id: input.venueId, tenantId: input.tenantId } },
        data: venueData(venueBefore),
      })
    const restored = await projectLocked(tx, input)
    if (restored.stateHash !== release.baseStateHash)
      throw new NativeVenueDeploymentError(
        'CONFLICT',
        'Exact runtime restoration could not be proven.',
      )
    const now = new Date()
    await tx.nativeVenueDeploymentRelease.update({
      where: { id: release.id },
      data: {
        status: 'REVERTED',
        revertedBy: input.actor.id,
        revertedAt: now,
        revertedCommandId: input.commandId,
        revertedCommandHash: hash,
        updatedAt: now,
      },
    })
    const snapshot = {
      releaseId: release.id,
      status: 'REVERTED' as const,
      updatedAt: now.toISOString(),
      restoredStateHash: restored.stateHash,
      head: plan.priorHead,
    }
    await recordCommand(tx, input, input.actor.id, hash, 'REVERT', 'REVERTED', snapshot)
    if (plan.priorHead === null)
      await tx.nativeVenueDeploymentHead.delete({
        where: { tenantId_venueId: { tenantId: input.tenantId, venueId: input.venueId } },
      })
    else
      await tx.nativeVenueDeploymentHead.update({
        where: { tenantId_venueId: { tenantId: input.tenantId, venueId: input.venueId } },
        data: {
          releaseId: plan.priorHead.releaseId,
          artifactId: plan.priorHead.artifactId,
          manifestHash: plan.priorHead.manifestHash,
          stateHash: plan.priorHead.stateHash,
          revision: currentHead.revision + 1,
          updatedAt: now,
        },
      })
    return snapshot
  })
}
