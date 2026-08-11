import { createHash } from 'node:crypto'

import { canonicalEvaluationJson, type CanonicalJsonValue } from '@pathfinder/contracts/evaluation'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'

import type { db } from '../client'

export const VENUE_CONTENT_SNAPSHOT_SCHEMA_VERSION = 'pathfinder-venue-content-snapshot-v1'
const HASH_DOMAIN = 'pathfinder-venue-content-snapshot-v1'

type SnapshotClient = Pick<
  typeof db,
  | 'venue'
  | 'place'
  | 'venueKnowledgeEntry'
  | 'operationalUpdate'
  | 'contentModuleRevision'
  | 'contentVersion'
>

export type VenueContentSnapshotSource = {
  tenantId: string
  venueId: string
  venue: Record<string, unknown>
  places: Record<string, unknown>[]
  knowledgeEntries: Record<string, unknown>[]
  operationalUpdates: Record<string, unknown>[]
  universalRevisions: Record<string, unknown>[]
}

export type VenueContentSnapshot = {
  schemaVersion: typeof VENUE_CONTENT_SNAPSHOT_SCHEMA_VERSION
  hash: string
  contentVersion: bigint
  componentCounts: {
    venue: 1
    places: number
    knowledgeEntries: number
    operationalUpdates: number
    universalRevisions: number
  }
  manifest: CanonicalJsonValue
}

const sorted = (rows: Record<string, unknown>[]) =>
  [...rows].sort((left, right) =>
    String(left.id ?? left.moduleId).localeCompare(String(right.id ?? right.moduleId), 'en-US'),
  )

/** Pure canonical builder used by DB and deterministic tests. Callers must pass
 * only explicitly selected guest-facing fields. */
export function buildVenueContentSnapshot(
  source: VenueContentSnapshotSource,
  contentVersion = 0n,
): VenueContentSnapshot {
  const places = source.places.map((place) => ({
    ...place,
    ...(Array.isArray(place.tags) ? { tags: [...place.tags].sort() } : {}),
  }))
  const universalRevisions = source.universalRevisions.map((revision) => {
    const policy = revision.policy
    if (
      typeof policy !== 'object' ||
      policy === null ||
      !('appliesTo' in policy) ||
      !Array.isArray(policy.appliesTo)
    )
      return revision
    return { ...revision, policy: { ...policy, appliesTo: [...policy.appliesTo].sort() } }
  })
  const manifest = {
    schemaVersion: VENUE_CONTENT_SNAPSHOT_SCHEMA_VERSION,
    tenantId: source.tenantId,
    venueId: source.venueId,
    promptIdentity: { version: GUEST_CHAT_PROMPT_VERSION, hash: GUEST_CHAT_PROMPT_CONTRACT_HASH },
    venue: source.venue,
    places: sorted(places),
    knowledgeEntries: sorted(source.knowledgeEntries),
    operationalUpdates: sorted(source.operationalUpdates),
    universalRevisions: sorted(universalRevisions),
  } as CanonicalJsonValue
  const hash = createHash('sha256')
    .update(`${HASH_DOMAIN}\n${canonicalEvaluationJson(manifest)}`, 'utf8')
    .digest('hex')
  return {
    schemaVersion: VENUE_CONTENT_SNAPSHOT_SCHEMA_VERSION,
    hash,
    contentVersion,
    componentCounts: {
      venue: 1,
      places: source.places.length,
      knowledgeEntries: source.knowledgeEntries.length,
      operationalUpdates: source.operationalUpdates.length,
      universalRevisions: source.universalRevisions.length,
    },
    manifest,
  }
}

export class VenueContentSnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VenueContentSnapshotError'
  }
}

export async function createVenueContentSnapshot(params: {
  db: SnapshotClient
  tenantId: string
  venueId: string
  asOf?: Date
}): Promise<VenueContentSnapshot> {
  if (!params.tenantId.trim() || !params.venueId.trim())
    throw new VenueContentSnapshotError('Tenant and venue scope are required')
  const asOf = params.asOf ?? new Date()
  const [venue, places, knowledgeEntries, operationalUpdates, revisions, version] =
    await Promise.all([
      params.db.venue.findFirst({
        where: { id: params.venueId, tenantId: params.tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          guideNotes: true,
          aiGuideNotes: true,
          aiFeaturedPlaceId: true,
          aiTone: true,
          tonePreset: true,
          tonePresetVersion: true,
          aiGuideName: true,
          category: true,
          guideMode: true,
          defaultCenterLat: true,
          defaultCenterLng: true,
          geoBoundary: true,
          isActive: true,
        },
      }),
      params.db.place.findMany({
        where: { tenantId: params.tenantId, venueId: params.venueId, isActive: true },
        select: {
          id: true,
          name: true,
          type: true,
          itemType: true,
          shortDescription: true,
          longDescription: true,
          lat: true,
          lng: true,
          tags: true,
          importanceScore: true,
          areaName: true,
          hours: true,
          photoUrl: true,
          isActive: true,
        },
      }),
      params.db.venueKnowledgeEntry.findMany({
        where: { tenantId: params.tenantId, venueId: params.venueId, isEnabled: true },
        select: { id: true, title: true, category: true, content: true, isEnabled: true },
      }),
      params.db.operationalUpdate.findMany({
        where: {
          tenantId: params.tenantId,
          venueId: params.venueId,
          status: 'PUBLISHED',
          isActive: true,
          startsAt: { lte: asOf },
          expiresAt: { gt: asOf },
        },
        select: {
          id: true,
          placeId: true,
          updateType: true,
          severity: true,
          priority: true,
          title: true,
          body: true,
          redirectTo: true,
          status: true,
          isActive: true,
        },
      }),
      params.db.contentModuleRevision.findMany({
        where: {
          tenantId: params.tenantId,
          venueId: params.venueId,
          audience: 'PUBLIC',
          OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }],
          AND: [{ OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: asOf } }] }],
        },
        orderBy: [{ moduleId: 'asc' }, { version: 'desc' }],
        select: {
          id: true,
          moduleId: true,
          kind: true,
          version: true,
          audience: true,
          service: { select: { name: true, description: true, availability: true, placeId: true } },
          policy: { select: { title: true, rule: true, appliesTo: true } },
          event: { select: { name: true, description: true, placeId: true } },
          operationalFact: { select: { label: true, value: true } },
          relationship: {
            select: {
              fromModuleId: true,
              toModuleId: true,
              relationshipType: true,
              description: true,
            },
          },
        },
      }),
      params.db.contentVersion.aggregate({
        where: { tenantId: params.tenantId, venueId: params.venueId },
        _max: { sequence: true },
      }),
    ])
  if (!venue)
    throw new VenueContentSnapshotError('Venue was not found in the requested tenant scope')
  const latest = new Map<string, (typeof revisions)[number]>()
  for (const revision of revisions)
    if (!latest.has(revision.moduleId)) latest.set(revision.moduleId, revision)
  return buildVenueContentSnapshot(
    {
      tenantId: params.tenantId,
      venueId: params.venueId,
      venue,
      places,
      knowledgeEntries,
      operationalUpdates,
      universalRevisions: [...latest.values()],
    },
    version._max.sequence ?? 0n,
  )
}
