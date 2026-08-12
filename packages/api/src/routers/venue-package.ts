import { createHash, randomUUID } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { AiGatewayError } from '@pathfinder/ai'
import { logger } from '@pathfinder/config'
import {
  LEGACY_AI_TONE_TO_PRESET,
  TONE_PRESET_BEHAVIOR_VERSION,
  TONE_PRESET_TO_LEGACY_AI_TONE,
} from '@pathfinder/contracts/tone-presets'
import {
  approveVenuePackageAction,
  applyVenuePackageAction,
  getVenuePackageSemanticCoverage,
  assertVenueAiAvailable,
  lockVenueContentMutation,
  setContentVersionContext,
  revertVenuePackageAction,
  type ContentVersionSourceProvenance,
  VenuePackageLifecycleError,
  writeAuditLogStrict,
} from '@pathfinder/db'

import {
  canonicalVenuePackagePayload,
  VenuePackageApprovalInput,
  VenuePackageAppliedEntities,
  VenuePackageAppliedEntitiesV1,
  VenuePackageAppliedEntitiesV2,
  VenuePackageAppliedEntitiesV3,
  VenuePackageByIdInput,
  VenuePackageDraftInput,
  VenuePackageLifecycleInput,
  VenuePackagePayload,
  VenuePackagePlaceDesiredState,
  VenuePackagePlaceSnapshot,
  VenuePackagePreviewInput,
  VenuePackageKnowledgeDesiredState,
  VenuePackageKnowledgeSnapshot,
  VenuePackageStoredPreview,
  VenuePackageValidationReport,
  VenuePackageVenueChange,
  VenuePackageVenueSnapshot,
  type VenuePackageIssue,
  type VenuePackagePayloadV3,
  type VenuePackageSourceProvenance,
} from '../schemas/venue-package'
import { router } from '../core'
import type { TRPCContext } from '../context'
import { createApiAiUsageRecorder } from '../lib/api-ai-usage'
import { applyVenuePackageV3ContentEffects } from '../lib/venue-package-v3-content-effects'
import {
  parseVenuePackageContentVersionProvenance,
  venuePackageRollbackCasWhere,
  venuePackageRollbackMutationData,
} from '../lib/venue-package-v3-rollback-state'
import {
  planVenuePackageRollback,
  venuePackageSnapshotsEqual,
  type JsonSnapshot,
  type VenuePackageInversePlan,
} from '../lib/venue-package-rollback'
import {
  analyzeVenuePackageSemanticDuplicates,
  buildIncompleteSemanticScan,
  buildNotRunSemanticScan,
  generateVenuePackageCandidateEmbeddings,
  sortVenuePackageIssues,
  venuePackageSemanticInputs,
  VENUE_PACKAGE_SEMANTIC_PROFILES,
  VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD,
} from '../lib/venue-package-semantic-analysis'
import { withContentVersionActor } from '../middleware/content-version-actor'
import { requireGlobalAi } from '../middleware/require-global-ai'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

type DbClient = TRPCContext['db']
type PlaceCreateData = Parameters<DbClient['place']['create']>[0]['data']
type KnowledgeCreateData = Parameters<DbClient['venueKnowledgeEntry']['create']>[0]['data']
type PackagePayload = VenuePackagePayload

const venuePackageVenueSelect = {
  id: true,
  guideMode: true,
  aiFeaturedPlaceId: true,
  name: true,
  description: true,
  category: true,
  guideNotes: true,
  chatTheme: true,
  chatAccentColor: true,
  chatFont: true,
  chatLogoUrl: true,
  chatBannerUrl: true,
  aiGuideNotes: true,
  aiTone: true,
  tonePreset: true,
  tonePresetVersion: true,
  aiGuideName: true,
} as const

const venuePackageSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  draftKey: true,
  schemaVersion: true,
  payload: true,
  payloadHash: true,
  baseDigest: true,
  validationReport: true,
  previewPlan: true,
  status: true,
  createdBy: true,
  approvedBy: true,
  approvedAt: true,
  approvedCommandKey: true,
  approvalWarningDigest: true,
  approvedWarningCodes: true,
  appliedBy: true,
  appliedAt: true,
  appliedCommandKey: true,
  appliedEntities: true,
  revertedBy: true,
  revertedAt: true,
  revertedCommandKey: true,
  createdAt: true,
  updatedAt: true,
} as const

function conflict(message = 'Venue package changed; refresh and review it again'): never {
  throw new TRPCError({ code: 'CONFLICT', message })
}

function mapLifecycleError(error: unknown): never {
  if (!(error instanceof VenuePackageLifecycleError)) throw error
  throw new TRPCError({
    code:
      error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.code === 'CONFLICT'
          ? 'CONFLICT'
          : 'BAD_REQUEST',
    message: error.message,
    cause: error,
  })
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function deterministicUuid(namespace: string): string {
  const hex = createHash('sha256').update(namespace).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function venuePackageItemKey(packageId: string): string {
  return deterministicUuid(`pathfinder:venue-package:${packageId}:venue`)
}

function sourceProvenance(
  provenance: VenuePackageSourceProvenance,
  importedAt: Date,
  humanConfirmedAt: Date,
) {
  return {
    sourceType: provenance.sourceType,
    ...(provenance.sourceName !== undefined ? { sourceName: provenance.sourceName } : {}),
    ...(provenance.sourceUrl !== undefined ? { sourceUrl: provenance.sourceUrl } : {}),
    contentOrigin: provenance.contentOrigin,
    importedAt: importedAt.toISOString(),
    humanConfirmedAt: humanConfirmedAt.toISOString(),
    lastReviewedAt: humanConfirmedAt.toISOString(),
  }
}

function directProvenanceData(input: {
  provenance: VenuePackageSourceProvenance
  packageId: string
  importedAt: Date
  humanConfirmedAt: Date
  humanConfirmedBy: string
}) {
  return {
    sourceType: input.provenance.sourceType,
    authorship: input.provenance.contentOrigin,
    sourceName: input.provenance.sourceName ?? null,
    sourceUrl: input.provenance.sourceUrl ?? null,
    importedAt: input.importedAt,
    humanConfirmedAt: input.humanConfirmedAt,
    humanConfirmedBy: input.humanConfirmedBy,
    lastReviewedAt: input.humanConfirmedAt,
    lastReviewedBy: input.humanConfirmedBy,
    sourcePackageId: input.packageId,
  }
}

function jsonValue(value: unknown): object {
  return JSON.parse(JSON.stringify(value)) as object
}

function normalizeLabel(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
}

async function assertVenue(db: DbClient, tenantId: string, venueId: string) {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: venuePackageVenueSelect,
  })
  if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
  return venue
}

type PackageVenue = Awaited<ReturnType<typeof assertVenue>>

function venueSnapshot(venue: PackageVenue): VenuePackageVenueSnapshot {
  return VenuePackageVenueSnapshot.parse({
    name: venue.name,
    description: venue.description,
    category: venue.category,
    guideNotes: venue.guideNotes,
    chatTheme: venue.chatTheme,
    chatAccentColor: venue.chatAccentColor,
    chatFont: venue.chatFont,
    chatLogoUrl: venue.chatLogoUrl,
    chatBannerUrl: venue.chatBannerUrl,
    aiGuideNotes: venue.aiGuideNotes,
    aiTone: venue.aiTone,
    ...(venue.tonePreset !== undefined ? { tonePreset: venue.tonePreset } : {}),
    ...(venue.tonePresetVersion !== undefined
      ? { tonePresetVersion: venue.tonePresetVersion }
      : {}),
    aiGuideName: venue.aiGuideName,
  })
}

function venuePatchData(payload: PackagePayload): Partial<VenuePackageVenueSnapshot> {
  if (payload.schemaVersion === 1 || !payload.venue) return {}
  const { identity, branding, aiBehavior } = payload.venue
  return {
    ...(identity?.name !== undefined ? { name: identity.name } : {}),
    ...(identity?.description !== undefined ? { description: identity.description } : {}),
    ...(identity?.category !== undefined ? { category: identity.category } : {}),
    ...(payload.venue.guideNotes !== undefined ? { guideNotes: payload.venue.guideNotes } : {}),
    ...(branding?.chatTheme !== undefined ? { chatTheme: branding.chatTheme } : {}),
    ...(branding?.chatAccentColor !== undefined
      ? { chatAccentColor: branding.chatAccentColor }
      : {}),
    ...(branding?.chatFont !== undefined ? { chatFont: branding.chatFont } : {}),
    ...(branding?.chatLogoUrl !== undefined ? { chatLogoUrl: branding.chatLogoUrl } : {}),
    ...(branding?.chatBannerUrl !== undefined ? { chatBannerUrl: branding.chatBannerUrl } : {}),
    ...(aiBehavior?.aiGuideNotes !== undefined ? { aiGuideNotes: aiBehavior.aiGuideNotes } : {}),
    ...(aiBehavior?.tonePreset !== undefined
      ? {
          tonePreset: aiBehavior.tonePreset,
          tonePresetVersion: TONE_PRESET_BEHAVIOR_VERSION,
          aiTone: TONE_PRESET_TO_LEGACY_AI_TONE[aiBehavior.tonePreset],
        }
      : aiBehavior?.aiTone !== undefined
        ? aiBehavior.aiTone === null
          ? { aiTone: null, tonePreset: null, tonePresetVersion: null }
          : {
              aiTone: aiBehavior.aiTone,
              tonePreset: LEGACY_AI_TONE_TO_PRESET[aiBehavior.aiTone],
              tonePresetVersion: TONE_PRESET_BEHAVIOR_VERSION,
            }
        : {}),
    ...(aiBehavior?.aiGuideName !== undefined ? { aiGuideName: aiBehavior.aiGuideName } : {}),
  }
}

const venueChangePaths = {
  name: 'venue.identity.name',
  description: 'venue.identity.description',
  category: 'venue.identity.category',
  guideNotes: 'venue.guideNotes',
  chatTheme: 'venue.branding.chatTheme',
  chatAccentColor: 'venue.branding.chatAccentColor',
  chatFont: 'venue.branding.chatFont',
  chatLogoUrl: 'venue.branding.chatLogoUrl',
  chatBannerUrl: 'venue.branding.chatBannerUrl',
  aiGuideNotes: 'venue.aiBehavior.aiGuideNotes',
  aiTone: 'venue.aiBehavior.aiTone',
  tonePreset: 'venue.aiBehavior.tonePreset',
  tonePresetVersion: 'venue.aiBehavior.tonePresetVersion',
  aiGuideName: 'venue.aiBehavior.aiGuideName',
} as const

function venueChanges(payload: PackagePayload, current: VenuePackageVenueSnapshot) {
  return Object.entries(venuePatchData(payload)).flatMap(([field, after]) => {
    const key = field as keyof typeof venueChangePaths
    const before = current[key]
    if (before === after) return []
    return [VenuePackageVenueChange.parse({ path: venueChangePaths[key], before, after })]
  })
}

function changedVenuePatchData(
  payload: PackagePayload,
  current: VenuePackageVenueSnapshot,
): Parameters<DbClient['venue']['updateMany']>[0]['data'] {
  return Object.fromEntries(
    Object.entries(venuePatchData(payload)).filter(
      ([field, after]) => current[field as keyof VenuePackageVenueSnapshot] !== after,
    ),
  ) as Parameters<DbClient['venue']['updateMany']>[0]['data']
}

function venueRestoreData(
  snapshot: VenuePackageVenueSnapshot,
): Parameters<DbClient['venue']['updateMany']>[0]['data'] {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) => value !== undefined),
  ) as Parameters<DbClient['venue']['updateMany']>[0]['data']
}

function venueFieldCount(payload: PackagePayload, current: VenuePackageVenueSnapshot): number {
  const requested = venuePatchData(payload)
  return Object.keys(venueChangePaths).filter((field) => {
    const key = field as keyof VenuePackageVenueSnapshot
    return current[key] !== undefined || Object.prototype.hasOwnProperty.call(requested, key)
  }).length
}

async function contentState(db: DbClient, tenantId: string, venueId: string) {
  const [places, knowledgeEntries] = await Promise.all([
    db.place.findMany({
      where: { tenantId, venueId },
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
      orderBy: { id: 'asc' },
    }),
    db.venueKnowledgeEntry.findMany({
      where: { tenantId, venueId },
      select: { id: true, title: true, category: true, content: true, isEnabled: true },
      orderBy: { id: 'asc' },
    }),
  ])
  return { places, knowledgeEntries }
}

async function contentStateWithProvenance(db: DbClient, tenantId: string, venueId: string) {
  const [places, knowledgeEntries] = await Promise.all([
    db.place.findMany({
      where: { tenantId, venueId },
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
        sourceType: true,
        authorship: true,
        sourceName: true,
        sourceUrl: true,
        importedAt: true,
        humanConfirmedAt: true,
        humanConfirmedBy: true,
        lastReviewedAt: true,
        lastReviewedBy: true,
        sourcePackageId: true,
      },
      orderBy: { id: 'asc' },
    }),
    db.venueKnowledgeEntry.findMany({
      where: { tenantId, venueId },
      select: {
        id: true,
        title: true,
        category: true,
        content: true,
        isEnabled: true,
        sourceType: true,
        authorship: true,
        sourceName: true,
        sourceUrl: true,
        importedAt: true,
        humanConfirmedAt: true,
        humanConfirmedBy: true,
        lastReviewedAt: true,
        lastReviewedBy: true,
        sourcePackageId: true,
      },
      orderBy: { id: 'asc' },
    }),
  ])
  return { places, knowledgeEntries }
}

async function contentStateDigest(db: DbClient, tenantId: string, venueId: string) {
  return digest(await contentState(db, tenantId, venueId))
}

async function packageStateDigest(
  db: DbClient,
  tenantId: string,
  venueId: string,
  schemaVersion: PackagePayload['schemaVersion'],
) {
  if (schemaVersion === 1) return contentStateDigest(db, tenantId, venueId)
  if (schemaVersion === 3) {
    const [venue, content] = await Promise.all([
      assertVenue(db, tenantId, venueId),
      contentStateWithProvenance(db, tenantId, venueId),
    ])
    return digest({ venue: venueSnapshot(venue), ...content })
  }
  const [venue, content] = await Promise.all([
    assertVenue(db, tenantId, venueId),
    contentState(db, tenantId, venueId),
  ])
  return digest({ venue: venueSnapshot(venue), ...content })
}

function semanticCoverageParams(payload: PackagePayload) {
  const inputs = venuePackageSemanticInputs(payload)
  return {
    scanPlaces: inputs.places.length > 0,
    scanKnowledgeEntries: inputs.knowledgeEntries.length > 0,
    ...(payload.schemaVersion === 3
      ? {
          excludedPlaceIds: [...payload.places.update, ...payload.places.delete].map(
            (operation) => operation.id,
          ),
          excludedKnowledgeEntryIds: [
            ...payload.knowledgeEntries.update,
            ...payload.knowledgeEntries.delete,
          ].map((operation) => operation.id),
        }
      : {}),
  }
}

function placeDesiredSnapshot(
  id: string,
  value: VenuePackagePlaceDesiredState,
): VenuePackagePlaceSnapshot {
  return VenuePackagePlaceSnapshot.parse({ id, ...value })
}

function knowledgeDesiredSnapshot(
  id: string,
  value: VenuePackageKnowledgeDesiredState,
): VenuePackageKnowledgeSnapshot {
  return VenuePackageKnowledgeSnapshot.parse({ id, ...value })
}

function currentPlaceSnapshot(
  value: Awaited<ReturnType<typeof contentState>>['places'][number],
): VenuePackagePlaceSnapshot {
  return VenuePackagePlaceSnapshot.parse(value)
}

function currentKnowledgeSnapshot(
  value: Awaited<ReturnType<typeof contentState>>['knowledgeEntries'][number],
): VenuePackageKnowledgeSnapshot {
  return VenuePackageKnowledgeSnapshot.parse(value)
}

function duplicateWarnings(
  payload: PackagePayload,
  current: Awaited<ReturnType<typeof contentState>>,
) {
  const warnings: Array<{ code: string; path: string; message: string }> = []
  const existingPlaceNames = new Map(
    current.places
      .filter((place) => place.isActive)
      .map((place) => [normalizeLabel(place.name), place.id]),
  )
  const existingKnowledgeTitles = new Map(
    current.knowledgeEntries.map((entry) => [normalizeLabel(entry.title), entry.id]),
  )

  const placeCandidates =
    payload.schemaVersion === 3
      ? [
          ...payload.places.create.map((operation, index) => ({
            name: operation.value.name,
            path: `places.create.${index}.value.name`,
            excludeId: null,
          })),
          ...payload.places.update.map((operation, index) => ({
            name: operation.value.name,
            path: `places.update.${index}.value.name`,
            excludeId: operation.id,
          })),
        ]
      : payload.places.map((place, index) => ({
          name: place.name,
          path: `places.${index}.name`,
          excludeId: null,
        }))
  const knowledgeCandidates =
    payload.schemaVersion === 3
      ? [
          ...payload.knowledgeEntries.create.map((operation, index) => ({
            title: operation.value.title,
            path: `knowledgeEntries.create.${index}.value.title`,
            excludeId: null,
          })),
          ...payload.knowledgeEntries.update.map((operation, index) => ({
            title: operation.value.title,
            path: `knowledgeEntries.update.${index}.value.title`,
            excludeId: operation.id,
          })),
        ]
      : payload.knowledgeEntries.map((entry, index) => ({
          title: entry.title,
          path: `knowledgeEntries.${index}.title`,
          excludeId: null,
        }))

  const seenPlaces = new Set<string>()
  placeCandidates.forEach((place) => {
    const normalized = normalizeLabel(place.name)
    if (seenPlaces.has(normalized)) {
      warnings.push({
        code: 'DUPLICATE_IN_PACKAGE',
        path: place.path,
        message: `Another package place has the normalized name “${normalized}”.`,
      })
    } else if (
      existingPlaceNames.has(normalized) &&
      existingPlaceNames.get(normalized) !== place.excludeId
    ) {
      warnings.push({
        code: 'DUPLICATE_EXISTING_CONTENT',
        path: place.path,
        message: `An active venue place already has the normalized name “${normalized}”.`,
      })
    }
    seenPlaces.add(normalized)
  })

  const seenKnowledge = new Set<string>()
  knowledgeCandidates.forEach((entry) => {
    const normalized = normalizeLabel(entry.title)
    if (seenKnowledge.has(normalized)) {
      warnings.push({
        code: 'DUPLICATE_IN_PACKAGE',
        path: entry.path,
        message: `Another package knowledge entry has the normalized title “${normalized}”.`,
      })
    } else if (
      existingKnowledgeTitles.has(normalized) &&
      existingKnowledgeTitles.get(normalized) !== entry.excludeId
    ) {
      warnings.push({
        code: 'DUPLICATE_EXISTING_CONTENT',
        path: entry.path,
        message: `Venue knowledge already has the normalized title “${normalized}”.`,
      })
    }
    seenKnowledge.add(normalized)
  })

  return sortVenuePackageIssues(warnings)
}

async function latestTargetVersions(
  db: DbClient,
  tenantId: string,
  venueId: string,
  placeIds: string[],
  knowledgeIds: string[],
  includeVenue: boolean,
) {
  if (!includeVenue && placeIds.length === 0 && knowledgeIds.length === 0)
    return new Map<string, string>()
  const versions = await db.contentVersion.findMany({
    where: {
      tenantId,
      venueId,
      OR: [
        ...(includeVenue ? [{ entityType: 'VENUE', entityId: venueId }] : []),
        ...(placeIds.length > 0 ? [{ entityType: 'PLACE', entityId: { in: placeIds } }] : []),
        ...(knowledgeIds.length > 0
          ? [{ entityType: 'KNOWLEDGE_ENTRY', entityId: { in: knowledgeIds } }]
          : []),
      ],
    },
    select: { id: true, entityType: true, entityId: true },
    orderBy: { sequence: 'desc' },
  })
  const latest = new Map<string, string>()
  for (const version of versions) {
    const key = `${version.entityType}:${version.entityId}`
    if (!latest.has(key)) latest.set(key, version.id)
  }
  return latest
}

async function placeDeleteDependencies(
  db: DbClient,
  tenantId: string,
  venueId: string,
  ids: string[],
  featuredPlaceId: string | null,
) {
  const result = new Map<string, Array<{ type: string; count: number }>>()
  if (ids.length === 0) return result
  const scope = { tenantId, venueId, placeId: { in: ids } }
  const [updates, events, rollups] = await Promise.all([
    db.operationalUpdate.groupBy({ by: ['placeId'], where: scope, _count: { _all: true } }),
    db.analyticsEvent.groupBy({ by: ['placeId'], where: scope, _count: { _all: true } }),
    db.dailyRollup.groupBy({ by: ['placeId'], where: scope, _count: { _all: true } }),
  ])
  const add = (id: string | null, type: string, count: number) => {
    if (!id || count === 0) return
    result.set(id, [...(result.get(id) ?? []), { type, count }])
  }
  updates.forEach((row) => add(row.placeId, 'operational-updates', row._count._all))
  events.forEach((row) => add(row.placeId, 'analytics-events', row._count._all))
  rollups.forEach((row) => add(row.placeId, 'daily-rollups', row._count._all))
  if (featuredPlaceId && ids.includes(featuredPlaceId)) add(featuredPlaceId, 'featured-place', 1)
  return result
}

async function buildPreview(
  db: DbClient,
  tenantId: string,
  venueId: string,
  payload: PackagePayload,
) {
  const venue = await assertVenue(db, tenantId, venueId)
  const current = await contentState(db, tenantId, venueId)
  const currentVenue = venueSnapshot(venue)
  const exactVenueChanges = venueChanges(payload, currentVenue)
  const errors: Array<{ code: string; path: string; message: string }> = []

  if (payload.schemaVersion === 3) {
    const operationCount =
      payload.places.create.length +
      payload.places.update.length +
      payload.places.delete.length +
      payload.knowledgeEntries.create.length +
      payload.knowledgeEntries.update.length +
      payload.knowledgeEntries.delete.length
    if (operationCount === 0 && exactVenueChanges.length === 0) {
      errors.push({
        code: 'NO_CHANGES',
        path: 'venue',
        message: 'The venue already matches the requested package configuration.',
      })
    }
    const currentPlaces = new Map(current.places.map((place) => [place.id, place]))
    const currentKnowledge = new Map(current.knowledgeEntries.map((entry) => [entry.id, entry]))
    const placeTargets = [...payload.places.update, ...payload.places.delete]
    const knowledgeTargets = [
      ...payload.knowledgeEntries.update,
      ...payload.knowledgeEntries.delete,
    ]
    const versions = await latestTargetVersions(
      db,
      tenantId,
      venueId,
      placeTargets.map((operation) => operation.id),
      knowledgeTargets.map((operation) => operation.id),
      exactVenueChanges.length > 0,
    )
    const expectedVenueVersionId = versions.get(`VENUE:${venueId}`) ?? null
    if (exactVenueChanges.length > 0 && !expectedVenueVersionId) {
      errors.push({
        code: 'HISTORY_MISSING',
        path: 'venue',
        message: 'The venue lacks required version history.',
      })
    }
    const dependencies = await placeDeleteDependencies(
      db,
      tenantId,
      venueId,
      payload.places.delete.map((operation) => operation.id),
      venue.aiFeaturedPlaceId,
    )
    const placeChanges = payload.places.update.flatMap((operation, index) => {
      const currentPlace = currentPlaces.get(operation.id)
      const path = `places.update.${index}`
      if (!currentPlace) {
        errors.push({
          code: 'TARGET_NOT_FOUND',
          path,
          message: 'The target place does not exist in this venue.',
        })
        return []
      }
      const expectedVersionId = versions.get(`PLACE:${operation.id}`)
      if (!expectedVersionId) {
        errors.push({
          code: 'HISTORY_MISSING',
          path,
          message: 'The target place lacks required version history.',
        })
        return []
      }
      const before = currentPlaceSnapshot(currentPlace)
      const desired = placeDesiredSnapshot(operation.id, operation.value)
      if (JSON.stringify(before) === JSON.stringify(desired)) {
        errors.push({
          code: 'NO_CHANGES',
          path,
          message: 'The place already matches the complete desired state.',
        })
        return []
      }
      return [
        {
          itemKey: operation.itemKey,
          id: operation.id,
          expectedVersionId,
          before,
          after: operation.value,
        },
      ]
    })
    const placeRemovals = payload.places.delete.flatMap((operation, index) => {
      const currentPlace = currentPlaces.get(operation.id)
      const path = `places.delete.${index}`
      if (!currentPlace) {
        errors.push({
          code: 'TARGET_NOT_FOUND',
          path,
          message: 'The target place does not exist in this venue.',
        })
        return []
      }
      const expectedVersionId = versions.get(`PLACE:${operation.id}`)
      if (!expectedVersionId) {
        errors.push({
          code: 'HISTORY_MISSING',
          path,
          message: 'The target place lacks required version history.',
        })
        return []
      }
      const blockers = dependencies.get(operation.id) ?? []
      if (blockers.length > 0) {
        errors.push({
          code: 'DELETE_BLOCKED',
          path,
          message: `The place has retained dependencies: ${blockers.map((item) => `${item.type} (${item.count})`).join(', ')}.`,
        })
      }
      return [
        {
          itemKey: operation.itemKey,
          id: operation.id,
          expectedVersionId,
          before: currentPlaceSnapshot(currentPlace),
          dependencies: blockers,
        },
      ]
    })
    const knowledgeChanges = payload.knowledgeEntries.update.flatMap((operation, index) => {
      const currentEntry = currentKnowledge.get(operation.id)
      const path = `knowledgeEntries.update.${index}`
      if (!currentEntry) {
        errors.push({
          code: 'TARGET_NOT_FOUND',
          path,
          message: 'The target knowledge entry does not exist in this venue.',
        })
        return []
      }
      const expectedVersionId = versions.get(`KNOWLEDGE_ENTRY:${operation.id}`)
      if (!expectedVersionId) {
        errors.push({
          code: 'HISTORY_MISSING',
          path,
          message: 'The target knowledge entry lacks required version history.',
        })
        return []
      }
      const before = currentKnowledgeSnapshot(currentEntry)
      const desired = knowledgeDesiredSnapshot(operation.id, operation.value)
      if (JSON.stringify(before) === JSON.stringify(desired)) {
        errors.push({
          code: 'NO_CHANGES',
          path,
          message: 'The knowledge entry already matches the complete desired state.',
        })
        return []
      }
      return [
        {
          itemKey: operation.itemKey,
          id: operation.id,
          expectedVersionId,
          before,
          after: operation.value,
        },
      ]
    })
    const knowledgeRemovals = payload.knowledgeEntries.delete.flatMap((operation, index) => {
      const currentEntry = currentKnowledge.get(operation.id)
      const path = `knowledgeEntries.delete.${index}`
      if (!currentEntry) {
        errors.push({
          code: 'TARGET_NOT_FOUND',
          path,
          message: 'The target knowledge entry does not exist in this venue.',
        })
        return []
      }
      const expectedVersionId = versions.get(`KNOWLEDGE_ENTRY:${operation.id}`)
      if (!expectedVersionId) {
        errors.push({
          code: 'HISTORY_MISSING',
          path,
          message: 'The target knowledge entry lacks required version history.',
        })
        return []
      }
      return [
        {
          itemKey: operation.itemKey,
          id: operation.id,
          expectedVersionId,
          before: currentKnowledgeSnapshot(currentEntry),
          dependencies: [],
        },
      ]
    })
    if (venue.guideMode === 'location_aware') {
      payload.places.create.forEach((operation, index) => {
        if (operation.value.lat === undefined || operation.value.lng === undefined) {
          errors.push({
            code: 'LOCATION_REQUIRED',
            path: `places.create.${index}.value`,
            message: 'Latitude and longitude are required for this location-aware venue.',
          })
        }
      })
      payload.places.update.forEach((operation, index) => {
        if (
          operation.value.isActive &&
          (operation.value.lat === null || operation.value.lng === null)
        ) {
          errors.push({
            code: 'LOCATION_REQUIRED',
            path: `places.update.${index}.value`,
            message: 'Active places require latitude and longitude in this location-aware venue.',
          })
        }
      })
    }
    const baseDigest = await packageStateDigest(db, tenantId, venueId, 3)
    const payloadHash = digest(canonicalVenuePackagePayload(venueId, payload))
    const report = VenuePackageValidationReport.parse({
      errors: sortVenuePackageIssues(errors),
      warnings: duplicateWarnings(payload, current),
      semanticDuplicateScan: buildNotRunSemanticScan({
        payload,
        existingPlaceCount: current.places.filter((place) => place.isActive).length,
        existingKnowledgeCount: current.knowledgeEntries.filter((entry) => entry.isEnabled).length,
      }),
    })
    return {
      schemaVersion: 3 as const,
      payloadHash,
      baseDigest,
      mode: 'MUTATING_V3' as const,
      warningDigest: digest(report.warnings),
      report,
      changes: {
        venue: {
          expectedVersionId: expectedVenueVersionId,
          change: exactVenueChanges,
          unchanged: venueFieldCount(payload, venue) - exactVenueChanges.length,
        },
        places: {
          add: payload.places.create.map((operation) => ({
            itemKey: operation.itemKey,
            value: operation.value,
          })),
          change: placeChanges,
          remove: placeRemovals,
          unchanged: Math.max(0, current.places.length - placeTargets.length),
        },
        knowledgeEntries: {
          add: payload.knowledgeEntries.create.map((operation) => ({
            itemKey: operation.itemKey,
            value: operation.value,
          })),
          change: knowledgeChanges,
          remove: knowledgeRemovals,
          unchanged: Math.max(0, current.knowledgeEntries.length - knowledgeTargets.length),
        },
      },
    }
  }

  if (
    payload.schemaVersion === 2 &&
    exactVenueChanges.length === 0 &&
    payload.places.length === 0 &&
    payload.knowledgeEntries.length === 0
  ) {
    errors.push({
      code: 'NO_CHANGES',
      path: 'venue',
      message: 'Every supplied venue value already matches the current venue configuration.',
    })
  }
  if (
    venue.guideMode === 'location_aware' &&
    payload.places.some((place) => place.lat === undefined || place.lng === undefined)
  ) {
    payload.places.forEach((place, index) => {
      if (place.lat === undefined || place.lng === undefined) {
        errors.push({
          code: 'LOCATION_REQUIRED',
          path: `places.${index}`,
          message: 'Latitude and longitude are required for this location-aware venue.',
        })
      }
    })
  }

  const baseDigest =
    payload.schemaVersion === 1 ? digest(current) : digest({ venue: currentVenue, ...current })
  const payloadHash = digest(canonicalVenuePackagePayload(venueId, payload))
  const report = VenuePackageValidationReport.parse({
    errors: sortVenuePackageIssues(errors),
    warnings: duplicateWarnings(payload, current),
    semanticDuplicateScan: buildNotRunSemanticScan({
      payload,
      existingPlaceCount: current.places.filter((place) => place.isActive).length,
      existingKnowledgeCount: current.knowledgeEntries.filter((entry) => entry.isEnabled).length,
    }),
  })
  const contentChanges = {
    places: { add: payload.places, change: [], remove: [], unchanged: current.places.length },
    knowledgeEntries: {
      add: payload.knowledgeEntries,
      change: [],
      remove: [],
      unchanged: current.knowledgeEntries.length,
    },
  }
  return payload.schemaVersion === 1
    ? {
        schemaVersion: 1 as const,
        payloadHash,
        baseDigest,
        mode: 'ADDITIVE_V1' as const,
        warningDigest: digest(report.warnings),
        report,
        changes: contentChanges,
      }
    : {
        schemaVersion: 2 as const,
        payloadHash,
        baseDigest,
        mode: 'CONFIG_PATCH_AND_ADDITIVE_V2' as const,
        warningDigest: digest(report.warnings),
        report,
        changes: {
          venue: {
            change: exactVenueChanges,
            unchanged: venueFieldCount(payload, venue) - exactVenueChanges.length,
          },
          ...contentChanges,
        },
      }
}

function withSemanticEvidence(
  preview: Awaited<ReturnType<typeof buildPreview>>,
  semantic: {
    scan: VenuePackageValidationReport['semanticDuplicateScan']
    errors?: VenuePackageIssue[]
    warnings?: VenuePackageIssue[]
  },
) {
  const report = VenuePackageValidationReport.parse({
    errors: sortVenuePackageIssues([...preview.report.errors, ...(semantic.errors ?? [])]),
    warnings: sortVenuePackageIssues([...preview.report.warnings, ...(semantic.warnings ?? [])]),
    semanticDuplicateScan: semantic.scan,
  })
  return VenuePackageStoredPreview.parse({
    ...preview,
    report,
    warningDigest: digest(report.warnings),
  })
}

function parseStoredPreview(pkg: {
  schemaVersion: number
  payloadHash: string
  baseDigest: string
  validationReport: unknown
  previewPlan: unknown
}) {
  const report = VenuePackageValidationReport.safeParse(pkg.validationReport)
  const preview = VenuePackageStoredPreview.safeParse(pkg.previewPlan)
  if (!report.success || !preview.success)
    conflict('Stored venue package review evidence is invalid')
  if (JSON.stringify(report.data) !== JSON.stringify(preview.data.report)) {
    conflict('Stored venue package review evidence is inconsistent')
  }
  if (
    preview.data.schemaVersion !== pkg.schemaVersion ||
    preview.data.payloadHash !== pkg.payloadHash ||
    preview.data.baseDigest !== pkg.baseDigest
  ) {
    conflict('Stored venue package review evidence does not match its immutable revision')
  }
  return preview.data
}

function isSemanticIssue(issue: VenuePackageIssue): boolean {
  return issue.code.startsWith('SEMANTIC_')
}

function assertStoredEvidenceCurrent(params: {
  stored: VenuePackageStoredPreview
  deterministic: Awaited<ReturnType<typeof buildPreview>>
}): void {
  if (
    params.stored.payloadHash !== params.deterministic.payloadHash ||
    params.stored.baseDigest !== params.deterministic.baseDigest
  ) {
    conflict('Venue content changed; create a new preview')
  }
  const storedExactErrors = params.stored.report.errors.filter((issue) => !isSemanticIssue(issue))
  const storedExactWarnings = params.stored.report.warnings.filter(
    (issue) => !isSemanticIssue(issue),
  )
  if (
    JSON.stringify(storedExactErrors) !== JSON.stringify(params.deterministic.report.errors) ||
    JSON.stringify(storedExactWarnings) !== JSON.stringify(params.deterministic.report.warnings)
  ) {
    conflict('Venue package deterministic validation evidence changed')
  }
  if (JSON.stringify(params.stored.changes) !== JSON.stringify(params.deterministic.changes)) {
    conflict('Venue package exact review plan changed; create a new preview')
  }
}

async function findPackage(db: DbClient, tenantId: string, id: string) {
  return db.venuePackage.findFirst({ where: { id, tenantId }, select: venuePackageSelect })
}

function auditState(pkg: NonNullable<Awaited<ReturnType<typeof findPackage>>>) {
  return {
    id: pkg.id,
    venueId: pkg.venueId,
    schemaVersion: pkg.schemaVersion,
    payloadHash: pkg.payloadHash,
    baseDigest: pkg.baseDigest,
    approvalWarningDigest: pkg.approvalWarningDigest,
    approvedWarningCodes: pkg.approvedWarningCodes,
    status: pkg.status,
    createdBy: pkg.createdBy,
    approvedBy: pkg.approvedBy,
    approvedAt: pkg.approvedAt?.toISOString() ?? null,
    appliedBy: pkg.appliedBy,
    appliedAt: pkg.appliedAt?.toISOString() ?? null,
    revertedBy: pkg.revertedBy,
    revertedAt: pkg.revertedAt?.toISOString() ?? null,
    createdAt: pkg.createdAt.toISOString(),
    updatedAt: pkg.updatedAt.toISOString(),
  }
}

async function finalizePackageApply(input: {
  db: DbClient
  tenantId: string
  id: string
  expectedUpdatedAt: Date
  commandKey: string
  actorId: string
  appliedEntities: object
}) {
  try {
    return await applyVenuePackageAction(
      {
        tenantId: input.tenantId,
        id: input.id,
        expectedUpdatedAt: input.expectedUpdatedAt,
        commandKey: input.commandKey,
        actor: { type: 'HUMAN', id: input.actorId, role: 'OWNER' },
        load: (tx, scope) => findPackage(tx as DbClient, scope.tenantId, scope.id),
        validate: async () => undefined,
        execute: async () => ({ appliedEntities: jsonValue(input.appliedEntities) }),
        auditState,
      },
      input.db,
    )
  } catch (error) {
    mapLifecycleError(error)
  }
}

async function finalizePackageRevert(input: {
  db: DbClient
  tenantId: string
  id: string
  expectedUpdatedAt: Date
  commandKey: string
  actorId: string
}) {
  try {
    return await revertVenuePackageAction(
      {
        tenantId: input.tenantId,
        id: input.id,
        expectedUpdatedAt: input.expectedUpdatedAt,
        commandKey: input.commandKey,
        actor: { type: 'HUMAN', id: input.actorId, role: 'OWNER' },
        load: (tx, scope) => findPackage(tx as DbClient, scope.tenantId, scope.id),
        validate: async () => undefined,
        auditState,
      },
      input.db,
    )
  } catch (error) {
    mapLifecycleError(error)
  }
}

function parsePayload(value: unknown, expectedSchemaVersion?: number): PackagePayload {
  const result = VenuePackagePayload.safeParse(value)
  if (!result.success) conflict('Stored venue package payload is invalid')
  if (expectedSchemaVersion !== undefined && result.data.schemaVersion !== expectedSchemaVersion) {
    conflict('Stored venue package payload version is inconsistent')
  }
  return result.data
}

async function readPackageEffectVersion(input: {
  db: DbClient
  tenantId: string
  venueId: string
  packageId: string
  itemKey: string
  action: 'APPLY' | 'REVERT'
  entityType: 'VENUE' | 'PLACE' | 'KNOWLEDGE_ENTRY'
  entityId: string
  operation: 'CREATE' | 'UPDATE' | 'DELETE'
}) {
  const version = await input.db.contentVersion.findFirst({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      venuePackageId: input.packageId,
      venuePackageItemKey: input.itemKey,
      venuePackageAction: input.action,
    },
    select: {
      id: true,
      entityType: true,
      entityId: true,
      operation: true,
      beforeState: true,
      afterState: true,
      snapshotSchemaVersion: true,
    },
  })
  if (
    !version ||
    version.entityType !== input.entityType ||
    version.entityId !== input.entityId ||
    version.operation !== input.operation
  ) {
    conflict('Package mutation did not produce the expected immutable history record')
  }
  return version
}

async function applyVersionThreePackage(input: {
  db: DbClient
  tenantId: string
  actorId: string
  packageId: string
  venueId: string
  approvedAt: Date
  approvedBy: string
  payload: VenuePackagePayloadV3
}) {
  const importedAt = new Date()
  const effects: VenuePackageAppliedEntitiesV3['effects'] = []
  const establishContext = async (itemKey: string, provenance: VenuePackageSourceProvenance) => {
    await setContentVersionContext(input.db, {
      actorId: input.actorId,
      venuePackage: {
        venuePackageId: input.packageId,
        itemKey,
        action: 'APPLY',
        sourceProvenance: sourceProvenance(provenance, importedAt, input.approvedAt),
      },
    })
  }
  const record = async (effect: {
    itemKey: string
    entityType: 'VENUE' | 'PLACE' | 'KNOWLEDGE_ENTRY'
    entityId: string
    operation: 'CREATE' | 'UPDATE' | 'DELETE'
  }) => {
    const version = await readPackageEffectVersion({
      db: input.db,
      tenantId: input.tenantId,
      venueId: input.venueId,
      packageId: input.packageId,
      action: 'APPLY',
      ...effect,
    })
    effects.push({
      ...effect,
      applyVersionId: version.id,
      snapshotSchemaVersion: version.snapshotSchemaVersion,
      beforeState: version.beforeState as Record<string, unknown> | null,
      afterState: version.afterState as Record<string, unknown> | null,
    })
  }

  const currentVenue = venueSnapshot(await assertVenue(input.db, input.tenantId, input.venueId))
  const venueData = changedVenuePatchData(input.payload, currentVenue)
  if (Object.keys(venueData).length > 0) {
    const itemKey = venuePackageItemKey(input.packageId)
    const provenance: VenuePackageSourceProvenance = {
      sourceType: 'PATHFINDER_VENUE_PACKAGE',
      sourceName: `Venue package ${input.packageId}`,
      contentOrigin: 'HUMAN_AUTHORED',
    }
    await establishContext(itemKey, provenance)
    const changed = await input.db.venue.updateMany({
      where: { id: input.venueId, tenantId: input.tenantId },
      data: venueData,
    })
    if (changed.count !== 1) conflict('Venue changed during package application')
    await record({ itemKey, entityType: 'VENUE', entityId: input.venueId, operation: 'UPDATE' })
  }

  await applyVenuePackageV3ContentEffects({
    db: input.db,
    tenantId: input.tenantId,
    venueId: input.venueId,
    packageId: input.packageId,
    approvedAt: input.approvedAt,
    approvedBy: input.approvedBy,
    importedAt,
    payload: input.payload,
    establishContext,
    provenanceData: directProvenanceData,
    record,
    conflict,
  })
  return effects
}

async function currentEntitySnapshot(input: {
  db: DbClient
  tenantId: string
  venueId: string
  entityType: 'VENUE' | 'PLACE' | 'KNOWLEDGE_ENTRY'
  entityId: string
}): Promise<JsonSnapshot | null> {
  if (input.entityType === 'VENUE') {
    const row = await input.db.venue.findFirst({
      where: { id: input.entityId, tenantId: input.tenantId },
      select: {
        id: true,
        tenantId: true,
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
        chatTheme: true,
        chatAccentColor: true,
        chatFont: true,
        chatLogoUrl: true,
        chatBannerUrl: true,
        category: true,
        guideMode: true,
        defaultCenterLat: true,
        defaultCenterLng: true,
        geoBoundary: true,
        isActive: true,
      },
    })
    return row ? (jsonValue({ ...row, venueId: row.id }) as JsonSnapshot) : null
  }
  if (input.entityType === 'PLACE') {
    const row = await input.db.place.findFirst({
      where: { id: input.entityId, tenantId: input.tenantId, venueId: input.venueId },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
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
        sourceType: true,
        authorship: true,
        sourceName: true,
        sourceUrl: true,
        importedAt: true,
        humanConfirmedAt: true,
        humanConfirmedBy: true,
        lastReviewedAt: true,
        lastReviewedBy: true,
        sourcePackageId: true,
      },
    })
    return row ? (jsonValue(row) as JsonSnapshot) : null
  }
  const row = await input.db.venueKnowledgeEntry.findFirst({
    where: { id: input.entityId, tenantId: input.tenantId, venueId: input.venueId },
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      title: true,
      category: true,
      content: true,
      isEnabled: true,
      sourceType: true,
      authorship: true,
      sourceName: true,
      sourceUrl: true,
      importedAt: true,
      humanConfirmedAt: true,
      humanConfirmedBy: true,
      lastReviewedAt: true,
      lastReviewedBy: true,
      sourcePackageId: true,
    },
  })
  return row ? (jsonValue(row) as JsonSnapshot) : null
}

type PlannedVersionThreeRollback = {
  effect: VenuePackageAppliedEntitiesV3['effects'][number]
  plan: VenuePackageInversePlan
  provenance: ContentVersionSourceProvenance
}

async function planVersionThreeRollback(input: {
  db: DbClient
  tenantId: string
  venueId: string
  packageId: string
  manifest: VenuePackageAppliedEntitiesV3
}): Promise<PlannedVersionThreeRollback[]> {
  const versionIds = new Set<string>()
  const itemKeys = new Set<string>()
  const entityKeys = new Set<string>()
  const plans: PlannedVersionThreeRollback[] = []
  for (const effect of input.manifest.effects) {
    const entityKey = `${effect.entityType}:${effect.entityId}`
    if (
      versionIds.has(effect.applyVersionId) ||
      itemKeys.has(effect.itemKey) ||
      entityKeys.has(entityKey)
    ) {
      conflict('Venue package rollback manifest contains duplicate effects')
    }
    versionIds.add(effect.applyVersionId)
    itemKeys.add(effect.itemKey)
    entityKeys.add(entityKey)

    const applied = await input.db.contentVersion.findFirst({
      where: {
        id: effect.applyVersionId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        entityType: effect.entityType,
        entityId: effect.entityId,
        operation: effect.operation,
        venuePackageId: input.packageId,
        venuePackageItemKey: effect.itemKey,
        venuePackageAction: 'APPLY',
      },
      select: {
        id: true,
        sequence: true,
        beforeState: true,
        afterState: true,
        snapshotSchemaVersion: true,
        sourceProvenance: true,
      },
    })
    if (
      !applied ||
      applied.snapshotSchemaVersion !== effect.snapshotSchemaVersion ||
      !venuePackageSnapshotsEqual(applied.beforeState, effect.beforeState) ||
      !venuePackageSnapshotsEqual(applied.afterState, effect.afterState)
    ) {
      conflict('Venue package rollback manifest does not match immutable history')
    }
    const later = await input.db.contentVersion.findMany({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        entityType: effect.entityType,
        entityId: effect.entityId,
        sequence: { gt: applied.sequence },
      },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        operation: true,
        beforeState: true,
        afterState: true,
        revertedFromId: true,
      },
      orderBy: { sequence: 'asc' },
    })
    const laterVersionIds = new Set(later.map((version) => version.id))
    const externalAncestorIds = [
      ...new Set(
        later
          .map((version) => version.revertedFromId)
          .filter(
            (id): id is string =>
              id != null && id !== effect.applyVersionId && !laterVersionIds.has(id),
          ),
      ),
    ]
    const verifiedAncestors =
      externalAncestorIds.length === 0
        ? []
        : await input.db.contentVersion.findMany({
            where: {
              id: { in: externalAncestorIds },
              tenantId: input.tenantId,
              venueId: input.venueId,
              entityType: effect.entityType,
              entityId: effect.entityId,
              sequence: { lt: applied.sequence },
            },
            select: { id: true },
          })
    const currentState = await currentEntitySnapshot({
      db: input.db,
      tenantId: input.tenantId,
      venueId: input.venueId,
      entityType: effect.entityType,
      entityId: effect.entityId,
    })
    const planned = planVenuePackageRollback({
      effect,
      laterVersions: later.map((version) => ({
        id: version.id,
        entityType: version.entityType as 'VENUE' | 'PLACE' | 'KNOWLEDGE_ENTRY',
        entityId: version.entityId,
        operation: version.operation as 'CREATE' | 'UPDATE' | 'DELETE',
        beforeState: version.beforeState as JsonSnapshot | null,
        afterState: version.afterState as JsonSnapshot | null,
        revertedFromId: version.revertedFromId,
      })),
      knownAncestorVersionIds: verifiedAncestors.map((version) => version.id),
      currentState,
    })
    if (!planned.ok) {
      conflict(`Venue package rollback conflicts with later content: ${planned.message}`)
    }
    plans.push({
      effect,
      plan: planned.plan,
      provenance: parseVenuePackageContentVersionProvenance(applied.sourceProvenance, conflict),
    })
  }
  const createdPlaceDeletes = plans
    .filter((item) => item.effect.entityType === 'PLACE' && item.plan.operation === 'DELETE')
    .map((item) => item.effect.entityId)
  if (createdPlaceDeletes.length > 0) {
    const venue = await assertVenue(input.db, input.tenantId, input.venueId)
    const dependencies = await placeDeleteDependencies(
      input.db,
      input.tenantId,
      input.venueId,
      createdPlaceDeletes,
      venue.aiFeaturedPlaceId,
    )
    const blocked = createdPlaceDeletes.find((id) => (dependencies.get(id) ?? []).length > 0)
    if (blocked) {
      const blockers = dependencies.get(blocked) ?? []
      conflict(
        `Created package place has retained dependencies: ${blockers
          .map((item) => `${item.type} (${item.count})`)
          .join(', ')}`,
      )
    }
  }
  return plans
}

async function executeVersionThreeRollback(input: {
  db: DbClient
  tenantId: string
  venueId: string
  packageId: string
  actorId: string
  plans: PlannedVersionThreeRollback[]
}) {
  for (const item of [...input.plans].reverse()) {
    await setContentVersionContext(input.db, {
      actorId: input.actorId,
      revertedFromId: item.effect.applyVersionId,
      venuePackage: {
        venuePackageId: input.packageId,
        itemKey: item.effect.itemKey,
        action: 'REVERT',
        sourceProvenance: item.provenance,
      },
    })
    const scope = { id: item.effect.entityId, tenantId: input.tenantId }
    let inverseOperation: 'CREATE' | 'UPDATE' | 'DELETE'
    if (item.plan.operation === 'DELETE') {
      inverseOperation = 'DELETE'
      const where = {
        ...scope,
        ...(item.effect.entityType === 'VENUE' ? {} : { venueId: input.venueId }),
        ...venuePackageRollbackCasWhere(item.effect.entityType, item.plan.expectedState),
      }
      const removed =
        item.effect.entityType === 'PLACE'
          ? await input.db.place.deleteMany({ where })
          : item.effect.entityType === 'KNOWLEDGE_ENTRY'
            ? await input.db.venueKnowledgeEntry.deleteMany({ where })
            : { count: 0 }
      if (removed.count !== 1) conflict('Created package content changed during rollback')
    } else if (item.plan.operation === 'CREATE') {
      inverseOperation = 'CREATE'
      const state = item.plan.state
      if (
        state.id !== item.effect.entityId ||
        state.tenantId !== input.tenantId ||
        state.venueId !== input.venueId
      ) {
        conflict('Package rollback create snapshot has invalid scope')
      }
      const data = {
        id: item.effect.entityId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        ...venuePackageRollbackMutationData(item.effect.entityType, state),
      }
      if (item.effect.entityType === 'PLACE') {
        await input.db.place.create({ data: data as PlaceCreateData })
      } else if (item.effect.entityType === 'KNOWLEDGE_ENTRY') {
        await input.db.venueKnowledgeEntry.create({
          data: data as KnowledgeCreateData,
        })
      } else conflict('Venue package rollback cannot recreate a venue')
    } else {
      inverseOperation = 'UPDATE'
      if (item.plan.unsetFields.length > 0 || item.plan.expectedUnsetFields.length > 0) {
        conflict('Package rollback patch contains unsupported sparse snapshots')
      }
      const where = {
        ...scope,
        ...(item.effect.entityType === 'VENUE' ? {} : { venueId: input.venueId }),
        ...venuePackageRollbackCasWhere(item.effect.entityType, item.plan.expectedFields),
      }
      const data = venuePackageRollbackMutationData(item.effect.entityType, item.plan.fields)
      const changed =
        item.effect.entityType === 'VENUE'
          ? await input.db.venue.updateMany({ where, data })
          : item.effect.entityType === 'PLACE'
            ? await input.db.place.updateMany({ where, data })
            : await input.db.venueKnowledgeEntry.updateMany({ where, data })
      if (changed.count !== 1) conflict('Package content changed during rollback')
    }
    await readPackageEffectVersion({
      db: input.db,
      tenantId: input.tenantId,
      venueId: input.venueId,
      packageId: input.packageId,
      itemKey: item.effect.itemKey,
      action: 'REVERT',
      entityType: item.effect.entityType,
      entityId: item.effect.entityId,
      operation: inverseOperation,
    })
  }
}

function matchesPlace(
  current: Awaited<ReturnType<typeof contentState>>['places'][number],
  expected: VenuePackageAppliedEntitiesV1['places'][number],
) {
  return (
    current.id === expected.id &&
    current.name === expected.name &&
    current.type === expected.type &&
    current.itemType === (expected.itemType ?? null) &&
    current.shortDescription === (expected.shortDescription ?? null) &&
    current.longDescription === (expected.longDescription ?? null) &&
    current.lat === (expected.lat ?? null) &&
    current.lng === (expected.lng ?? null) &&
    JSON.stringify(current.tags) === JSON.stringify(expected.tags) &&
    current.importanceScore === expected.importanceScore &&
    current.areaName === (expected.areaName ?? null) &&
    current.hours === (expected.hours ?? null) &&
    current.photoUrl === (expected.photoUrl ?? null) &&
    current.isActive
  )
}

function matchesKnowledge(
  current: Awaited<ReturnType<typeof contentState>>['knowledgeEntries'][number],
  expected: VenuePackageAppliedEntitiesV1['knowledgeEntries'][number],
) {
  return (
    current.id === expected.id &&
    current.title === expected.title &&
    current.category === expected.category &&
    current.content === expected.content &&
    current.isEnabled === expected.isEnabled
  )
}

export const venuePackageRouter = router({
  preview: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackagePreviewInput)
    .mutation(({ ctx, input }) =>
      buildPreview(ctx.db, ctx.session.activeTenantId, input.venueId, input.payload),
    ),

  list: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackagePreviewInput.pick({ venueId: true }))
    .query(async ({ ctx, input }) => {
      await assertVenue(ctx.db, ctx.session.activeTenantId, input.venueId)
      const packages = await ctx.db.venuePackage.findMany({
        where: { tenantId: ctx.session.activeTenantId, venueId: input.venueId },
        select: venuePackageSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 100,
      })
      return packages.map((pkg) => {
        const preview = parseStoredPreview(pkg)
        return { ...pkg, validationReport: preview.report, previewPlan: preview }
      })
    }),

  getById: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackageByIdInput)
    .query(async ({ ctx, input }) => {
      const pkg = await findPackage(ctx.db, ctx.session.activeTenantId, input.id)
      if (!pkg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      const preview = parseStoredPreview(pkg)
      return { ...pkg, validationReport: preview.report, previewPlan: preview }
    }),

  createDraft: tenantProcedure
    .use(requireRole('MANAGER'))
    .use(requireGlobalAi)
    .input(VenuePackageDraftInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const key = {
        tenantId,
        venueId: input.venueId,
        draftKey: input.draftKey,
      }
      const requestedPayloadHash = digest(
        canonicalVenuePackagePayload(input.venueId, input.payload),
      )
      const claimToken = randomUUID()

      const prepared = await ctx.db.$transaction(async (transaction) => {
        await lockVenueContentMutation(transaction, { tenantId, venueId: input.venueId })
        const existingPackage = await transaction.venuePackage.findFirst({
          where: key,
          select: venuePackageSelect,
        })
        if (existingPackage) {
          if (existingPackage.payloadHash !== requestedPayloadHash) {
            conflict('Draft key was already used for different venue-package content')
          }
          return {
            kind: 'complete' as const,
            pkg: existingPackage,
            preview: parseStoredPreview(existingPackage),
            replayed: true,
          }
        }

        const preview = await buildPreview(
          transaction as DbClient,
          tenantId,
          input.venueId,
          input.payload,
        )
        const existingAnalysis = await transaction.venuePackageDuplicateAnalysis.findFirst({
          where: key,
          select: {
            status: true,
            payloadHash: true,
            baseDigest: true,
            errorCode: true,
          },
        })
        if (existingAnalysis) {
          if (
            existingAnalysis.payloadHash !== preview.payloadHash ||
            existingAnalysis.baseDigest !== preview.baseDigest
          ) {
            conflict('Draft key was already used for different venue-package content or base')
          }
          if (existingAnalysis.status === 'RUNNING') {
            return { kind: 'running' as const }
          }
          return { kind: 'terminal-failure' as const, status: existingAnalysis.status }
        }

        const coverage = await getVenuePackageSemanticCoverage(transaction, {
          tenantId,
          venueId: input.venueId,
          placeProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.places,
          knowledgeProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.knowledgeEntries,
          ...semanticCoverageParams(input.payload),
        })
        const incomplete = buildIncompleteSemanticScan({ payload: input.payload, coverage })
        if (incomplete.errors.length > 0) {
          const finalPreview = withSemanticEvidence(preview, incomplete)
          const pkg = await transaction.venuePackage.create({
            data: {
              ...key,
              schemaVersion: input.payload.schemaVersion,
              payload: jsonValue(input.payload),
              payloadHash: finalPreview.payloadHash,
              baseDigest: finalPreview.baseDigest,
              validationReport: jsonValue(finalPreview.report),
              previewPlan: jsonValue(finalPreview),
              createdBy: ctx.session.userId,
            },
            select: venuePackageSelect,
          })
          await transaction.venuePackageDuplicateAnalysis.create({
            data: {
              ...key,
              payloadHash: finalPreview.payloadHash,
              baseDigest: finalPreview.baseDigest,
              status: 'COMPLETE',
              claimToken,
              embeddingProfiles: jsonValue(VENUE_PACKAGE_SEMANTIC_PROFILES),
              similarityThreshold: VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD,
              result: jsonValue(finalPreview),
              usageEventIds: [],
              draftId: pkg.id,
              createdBy: ctx.session.userId,
              completedAt: new Date(),
            },
          })
          await writeAuditLogStrict(
            {
              tenantId,
              actorId: ctx.session.userId,
              actorRole: ctx.session.role ?? 'MANAGER',
              action: 'venue-package.created-draft',
              targetType: 'VenuePackage',
              targetId: pkg.id,
              afterState: auditState(pkg),
            },
            transaction as DbClient,
          )
          return { kind: 'complete' as const, pkg, preview: finalPreview, replayed: false }
        }

        const analysis = await transaction.venuePackageDuplicateAnalysis.create({
          data: {
            ...key,
            payloadHash: preview.payloadHash,
            baseDigest: preview.baseDigest,
            claimToken,
            embeddingProfiles: jsonValue(VENUE_PACKAGE_SEMANTIC_PROFILES),
            similarityThreshold: VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD,
            createdBy: ctx.session.userId,
          },
          select: { id: true },
        })
        return { kind: 'claimed' as const, analysisId: analysis.id, preview }
      })

      if (prepared.kind === 'complete') {
        return { ...prepared.pkg, preview: prepared.preview, replayed: prepared.replayed }
      }
      if (prepared.kind === 'running') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Duplicate analysis is already running for this draft key.',
        })
      }
      if (prepared.kind === 'terminal-failure') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This draft key has terminal duplicate-analysis evidence; use a new key.',
        })
      }

      const usage = createApiAiUsageRecorder({
        db: ctx.db,
        tenantId,
        venueId: input.venueId,
        feature: 'venue-package-duplicate-analysis',
        surface: 'client-dashboard',
      })

      const settleFailure = async (status: 'FAILED' | 'STALE', errorCode: string) => {
        try {
          await ctx.db.venuePackageDuplicateAnalysis.updateMany({
            where: {
              id: prepared.analysisId,
              tenantId,
              venueId: input.venueId,
              status: 'RUNNING',
              claimToken,
            },
            data: {
              status,
              errorCode,
              usageEventIds: jsonValue(usage.usageEventIds()),
              completedAt: new Date(),
            },
          })
        } catch {
          // A failed settlement leaves an intentionally ambiguous RUNNING claim.
          // It must never be auto-redriven because provider idempotency is unavailable.
          logger.error({
            action: 'venue_package.duplicate_analysis.settlement_failed',
            tenantId,
            venueId: input.venueId,
            analysisId: prepared.analysisId,
            terminalStatus: status,
            error: 'Duplicate-analysis settlement failed',
          })
        }
      }

      let candidates
      try {
        candidates = await generateVenuePackageCandidateEmbeddings({
          payload: input.payload,
          usageSink: usage.sink,
          admissionGuard: () =>
            assertVenueAiAvailable(ctx.db, { tenantId, venueId: input.venueId }),
          budgetGate: usage.budgetGate,
          shouldAbort: usage.persistenceFailed,
        })
        if (usage.persistenceFailed()) {
          await settleFailure('FAILED', 'usage-persistence-failed')
          throw new TRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message: 'Duplicate analysis could not be recorded; no draft was saved.',
          })
        }
      } catch (error) {
        if (error instanceof TRPCError) throw error
        const errorCode = usage.persistenceFailed()
          ? 'usage-persistence-failed'
          : error instanceof AiGatewayError
            ? error.code
            : 'unexpected-error'
        await settleFailure('FAILED', errorCode)
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Duplicate analysis could not complete; no draft was saved.',
        })
      }

      try {
        const finalized = await ctx.db.$transaction(async (transaction) => {
          await lockVenueContentMutation(transaction, { tenantId, venueId: input.venueId })
          const preview = await buildPreview(
            transaction as DbClient,
            tenantId,
            input.venueId,
            input.payload,
          )
          const analysis = await transaction.venuePackageDuplicateAnalysis.findFirst({
            where: {
              id: prepared.analysisId,
              tenantId,
              venueId: input.venueId,
              status: 'RUNNING',
              claimToken,
            },
            select: { id: true, payloadHash: true, baseDigest: true },
          })
          if (!analysis) conflict('Duplicate-analysis claim is no longer active')
          if (
            analysis.payloadHash !== preview.payloadHash ||
            analysis.baseDigest !== preview.baseDigest
          ) {
            await transaction.venuePackageDuplicateAnalysis.updateMany({
              where: {
                id: analysis.id,
                tenantId,
                venueId: input.venueId,
                status: 'RUNNING',
                claimToken,
              },
              data: {
                status: 'STALE',
                errorCode: 'venue-base-changed',
                usageEventIds: jsonValue(usage.usageEventIds()),
                completedAt: new Date(),
              },
            })
            return { kind: 'stale' as const }
          }

          const coverage = await getVenuePackageSemanticCoverage(transaction, {
            tenantId,
            venueId: input.venueId,
            placeProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.places,
            knowledgeProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.knowledgeEntries,
            ...semanticCoverageParams(input.payload),
          })
          const incomplete = buildIncompleteSemanticScan({ payload: input.payload, coverage })
          if (incomplete.errors.length > 0) {
            await transaction.venuePackageDuplicateAnalysis.updateMany({
              where: {
                id: analysis.id,
                tenantId,
                venueId: input.venueId,
                status: 'RUNNING',
                claimToken,
              },
              data: {
                status: 'STALE',
                errorCode: 'semantic-scan-became-incomplete',
                usageEventIds: jsonValue(usage.usageEventIds()),
                completedAt: new Date(),
              },
            })
            return { kind: 'stale' as const }
          }

          const semantic = await analyzeVenuePackageSemanticDuplicates({
            db: transaction as DbClient,
            tenantId,
            venueId: input.venueId,
            payload: input.payload,
            coverage,
            candidates,
          })
          const finalPreview = withSemanticEvidence(preview, semantic)
          const pkg = await transaction.venuePackage.create({
            data: {
              ...key,
              schemaVersion: input.payload.schemaVersion,
              payload: jsonValue(input.payload),
              payloadHash: finalPreview.payloadHash,
              baseDigest: finalPreview.baseDigest,
              validationReport: jsonValue(finalPreview.report),
              previewPlan: jsonValue(finalPreview),
              createdBy: ctx.session.userId,
            },
            select: venuePackageSelect,
          })
          const completed = await transaction.venuePackageDuplicateAnalysis.updateMany({
            where: {
              id: analysis.id,
              tenantId,
              venueId: input.venueId,
              status: 'RUNNING',
              claimToken,
            },
            data: {
              status: 'COMPLETE',
              result: jsonValue(finalPreview),
              usageEventIds: jsonValue(usage.usageEventIds()),
              draftId: pkg.id,
              completedAt: new Date(),
            },
          })
          if (completed.count !== 1) conflict('Duplicate-analysis completion lost ownership')
          await writeAuditLogStrict(
            {
              tenantId,
              actorId: ctx.session.userId,
              actorRole: ctx.session.role ?? 'MANAGER',
              action: 'venue-package.created-draft',
              targetType: 'VenuePackage',
              targetId: pkg.id,
              afterState: auditState(pkg),
            },
            transaction as DbClient,
          )
          return { kind: 'complete' as const, pkg, preview: finalPreview }
        })
        if (finalized.kind === 'stale') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Venue content or embedding coverage changed during analysis; use a new key.',
          })
        }
        return { ...finalized.pkg, preview: finalized.preview, replayed: false }
      } catch (error) {
        if (error instanceof TRPCError && error.code === 'CONFLICT') {
          throw error
        }
        logger.error({
          action: 'venue_package.duplicate_analysis.finalization_failed',
          tenantId,
          venueId: input.venueId,
          analysisId: prepared.analysisId,
          errorType: error instanceof Error ? error.name : typeof error,
          errorCode:
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : 'unknown',
          error: 'Duplicate-analysis finalization failed',
        })
        await settleFailure('FAILED', 'finalization-failed')
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Duplicate analysis could not be finalized; no draft was saved.',
        })
      }
    }),

  approve: tenantProcedure
    .use(requireRole('OWNER'))
    .input(VenuePackageApprovalInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      let evidence: ReturnType<typeof parseStoredPreview> | undefined
      try {
        return await approveVenuePackageAction(
          {
            tenantId,
            id: input.id,
            expectedUpdatedAt: input.expectedUpdatedAt,
            commandKey: input.commandKey,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'OWNER' },
            load: (tx, scope) => findPackage(tx as DbClient, scope.tenantId, scope.id),
            auditState,
            validate: async (tx, existing) => {
              const payload = parsePayload(existing.payload, existing.schemaVersion)
              const deterministic = await buildPreview(
                tx as DbClient,
                tenantId,
                existing.venueId,
                payload,
              )
              evidence = parseStoredPreview(existing)
              assertStoredEvidenceCurrent({ stored: evidence, deterministic })
              if (
                evidence.report.errors.length > 0 ||
                evidence.report.semanticDuplicateScan.status !== 'COMPLETE'
              ) {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message:
                    'This draft does not contain a complete semantic scan; save a new draft.',
                })
              }
              if (evidence.payloadHash !== input.acknowledgedPayloadHash) {
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message:
                    'The acknowledged venue-package payload does not match this immutable draft',
                })
              }
              if (evidence.warningDigest !== input.acknowledgedWarningDigest) {
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message:
                    'Review and acknowledge the current venue-package warnings before approval',
                })
              }
            },
            execute: async () => {
              if (!evidence) conflict('Venue-package approval evidence was not retained')
              return {
                approvalWarningDigest: evidence.warningDigest,
                approvedWarningCodes: jsonValue(
                  [...new Set(evidence.report.warnings.map((warning) => warning.code))].sort(),
                ),
              }
            },
          },
          ctx.db,
        )
      } catch (error) {
        mapLifecycleError(error)
      }
    }),

  applyPackage: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withContentVersionActor)
    .input(VenuePackageLifecycleInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      let existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      await lockVenueContentMutation(ctx.db, { tenantId, venueId: existing.venueId })
      existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      if (existing.status !== 'APPROVED') {
        if (existing.appliedCommandKey === input.commandKey) return existing
        conflict('Only an approved venue package can be applied')
      }
      const payload = parsePayload(existing.payload, existing.schemaVersion)
      const deterministic = await buildPreview(ctx.db, tenantId, existing.venueId, payload)
      const stored = parseStoredPreview(existing)
      assertStoredEvidenceCurrent({ stored, deterministic })
      if (
        stored.report.errors.length > 0 ||
        stored.report.semanticDuplicateScan.status !== 'COMPLETE'
      ) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This package does not contain a complete semantic scan.',
        })
      }

      try {
        if (payload.schemaVersion === 3) {
          if (!existing.approvedAt || !existing.approvedBy) {
            conflict('Approved venue package is missing reviewer evidence')
          }
          const effects = await applyVersionThreePackage({
            db: ctx.db,
            tenantId,
            actorId: ctx.session.userId,
            packageId: existing.id,
            venueId: existing.venueId,
            approvedAt: existing.approvedAt,
            approvedBy: existing.approvedBy,
            payload,
          })
          const postApplyDigest = await packageStateDigest(
            ctx.db,
            tenantId,
            existing.venueId,
            payload.schemaVersion,
          )
          const appliedEntities = VenuePackageAppliedEntitiesV3.parse({
            schemaVersion: 3,
            rollbackContractVersion: 2,
            postApplyDigest,
            effects,
          })
          return finalizePackageApply({
            db: ctx.db,
            tenantId,
            id: input.id,
            expectedUpdatedAt: input.expectedUpdatedAt,
            commandKey: input.commandKey,
            actorId: ctx.session.userId,
            appliedEntities,
          })
        }
        let appliedVenue: VenuePackageAppliedEntitiesV2['venue'] = null
        if (payload.schemaVersion === 2) {
          const before = venueSnapshot(await assertVenue(ctx.db, tenantId, existing.venueId))
          const venueData = changedVenuePatchData(payload, before)
          if (Object.keys(venueData).length > 0) {
            const changedVenue = await ctx.db.venue.updateMany({
              where: { id: existing.venueId, tenantId },
              data: venueData,
            })
            if (changedVenue.count !== 1) conflict('Venue changed during package application')
            const after = venueSnapshot(await assertVenue(ctx.db, tenantId, existing.venueId))
            appliedVenue = { before, after }
          }
        }
        const places =
          payload.places.length === 0
            ? []
            : await ctx.db.place.createManyAndReturn({
                data: payload.places.map((place) => ({
                  tenantId,
                  venueId: existing.venueId,
                  name: place.name,
                  type: place.type,
                  ...(place.itemType !== undefined ? { itemType: place.itemType } : {}),
                  ...(place.shortDescription !== undefined
                    ? { shortDescription: place.shortDescription }
                    : {}),
                  ...(place.longDescription !== undefined
                    ? { longDescription: place.longDescription }
                    : {}),
                  ...(place.lat !== undefined ? { lat: place.lat } : {}),
                  ...(place.lng !== undefined ? { lng: place.lng } : {}),
                  tags: place.tags,
                  importanceScore: place.importanceScore,
                  ...(place.areaName !== undefined ? { areaName: place.areaName } : {}),
                  ...(place.hours !== undefined ? { hours: place.hours } : {}),
                  ...(place.photoUrl !== undefined ? { photoUrl: place.photoUrl } : {}),
                })),
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
                },
              })
        const knowledgeEntries =
          payload.knowledgeEntries.length === 0
            ? []
            : await ctx.db.venueKnowledgeEntry.createManyAndReturn({
                data: payload.knowledgeEntries.map((entry) => ({
                  tenantId,
                  venueId: existing.venueId,
                  title: entry.title,
                  category: entry.category,
                  content: entry.content,
                  isEnabled: entry.isEnabled,
                })),
                select: { id: true, title: true, category: true, content: true, isEnabled: true },
              })
        const postApplyDigest = await packageStateDigest(
          ctx.db,
          tenantId,
          existing.venueId,
          payload.schemaVersion,
        )
        const appliedEntities =
          payload.schemaVersion === 1
            ? VenuePackageAppliedEntitiesV1.parse({
                postApplyDigest,
                places,
                knowledgeEntries,
              })
            : VenuePackageAppliedEntitiesV2.parse({
                schemaVersion: 2,
                postApplyDigest,
                venue: appliedVenue,
                places,
                knowledgeEntries,
              })
        return finalizePackageApply({
          db: ctx.db,
          tenantId,
          id: input.id,
          expectedUpdatedAt: input.expectedUpdatedAt,
          commandKey: input.commandKey,
          actorId: ctx.session.userId,
          appliedEntities,
        })
      } catch (error) {
        if (
          error instanceof TRPCError ||
          (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error.code === 'P2002' || error.code === 'P2003'))
        ) {
          if (error instanceof TRPCError) throw error
          if (error.code === 'P2003') {
            conflict('Package deletion acquired a retained dependency; refresh and review it again')
          }
          conflict('Venue-package command key was already used')
        }
        throw error
      }
    }),

  revertPackage: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withContentVersionActor)
    .input(VenuePackageLifecycleInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      let existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      await lockVenueContentMutation(ctx.db, { tenantId, venueId: existing.venueId })
      existing = await findPackage(ctx.db, tenantId, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      if (existing.status !== 'APPLIED') {
        if (existing.revertedCommandKey === input.commandKey) return existing
        conflict('Only an applied venue package can be reverted')
      }
      const manifestResult = VenuePackageAppliedEntities.safeParse(existing.appliedEntities)
      if (!manifestResult.success) conflict('Venue package rollback manifest is invalid')
      const manifest = manifestResult.data
      const payload = parsePayload(existing.payload, existing.schemaVersion)
      if (payload.schemaVersion === 3) {
        if (!('rollbackContractVersion' in manifest) || manifest.schemaVersion !== 3) {
          conflict('Venue package rollback manifest version is inconsistent')
        }
        const plans = await planVersionThreeRollback({
          db: ctx.db,
          tenantId,
          venueId: existing.venueId,
          packageId: existing.id,
          manifest,
        })
        try {
          await executeVersionThreeRollback({
            db: ctx.db,
            tenantId,
            venueId: existing.venueId,
            packageId: existing.id,
            actorId: ctx.session.userId,
            plans,
          })
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'P2003'
          ) {
            conflict('Package rollback acquired a retained dependency; refresh and review it again')
          }
          throw error
        }
        return finalizePackageRevert({
          db: ctx.db,
          tenantId,
          id: input.id,
          expectedUpdatedAt: input.expectedUpdatedAt,
          commandKey: input.commandKey,
          actorId: ctx.session.userId,
        })
      }
      if ('rollbackContractVersion' in manifest) {
        conflict('Venue package rollback manifest version is inconsistent')
      }
      const current = await contentState(ctx.db, tenantId, existing.venueId)
      if (
        (payload.schemaVersion === 1 && 'schemaVersion' in manifest) ||
        (payload.schemaVersion === 2 && !('schemaVersion' in manifest))
      ) {
        conflict('Venue package rollback manifest version is inconsistent')
      }
      if (
        (await packageStateDigest(ctx.db, tenantId, existing.venueId, payload.schemaVersion)) !==
        manifest.postApplyDigest
      ) {
        conflict('Venue content changed after apply; automatic package rollback is unsafe')
      }

      const currentPlaces = new Map(current.places.map((place) => [place.id, place]))
      const currentKnowledge = new Map(current.knowledgeEntries.map((entry) => [entry.id, entry]))
      if (
        manifest.places.some((place) => {
          const row = currentPlaces.get(place.id)
          return !row || !matchesPlace(row, place)
        }) ||
        manifest.knowledgeEntries.some((entry) => {
          const row = currentKnowledge.get(entry.id)
          return !row || !matchesKnowledge(row, entry)
        })
      ) {
        conflict('Applied package content changed; automatic rollback is unsafe')
      }

      const removedKnowledge = await ctx.db.venueKnowledgeEntry.deleteMany({
        where: {
          tenantId,
          venueId: existing.venueId,
          id: { in: manifest.knowledgeEntries.map((entry) => entry.id) },
        },
      })
      if (removedKnowledge.count !== manifest.knowledgeEntries.length) conflict()
      const removedPlaces = await ctx.db.place.deleteMany({
        where: {
          tenantId,
          venueId: existing.venueId,
          id: { in: manifest.places.map((place) => place.id) },
        },
      })
      if (removedPlaces.count !== manifest.places.length) conflict()
      if ('schemaVersion' in manifest && manifest.venue) {
        const restoredVenue = await ctx.db.venue.updateMany({
          where: { id: existing.venueId, tenantId },
          data: venueRestoreData(manifest.venue.before),
        })
        if (restoredVenue.count !== 1) conflict('Venue changed during package rollback')
      }
      if (
        (await packageStateDigest(ctx.db, tenantId, existing.venueId, payload.schemaVersion)) !==
        existing.baseDigest
      ) {
        conflict('Venue package rollback did not restore the approved base state')
      }

      return finalizePackageRevert({
        db: ctx.db,
        tenantId,
        id: input.id,
        expectedUpdatedAt: input.expectedUpdatedAt,
        commandKey: input.commandKey,
        actorId: ctx.session.userId,
      })
    }),
})
