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
  getVenuePackageSemanticCoverage,
  assertGlobalAiAvailable,
  assertVenueAiAvailable,
  lockVenueContentMutation,
  writeAuditLogStrict,
} from '@pathfinder/db'

import {
  canonicalVenuePackagePayload,
  VenuePackageApprovalInput,
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
} from '../schemas/venue-package'
import { mergeRouters, router } from '../core'
import type { TRPCContext } from '../context'
import { createApiAiUsageRecorder } from '../lib/api-ai-usage'
import {
  type VenuePackageDraftFinalizer,
  VenuePackageDraftFinalizerError,
} from '../lib/venue-package-draft-finalizer'
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
import {
  applyVenuePackageLifecycle,
  approveVenuePackageLifecycle,
  revertVenuePackageLifecycle,
} from '../lib/venue-package-core'
import { withContentVersionActor } from '../middleware/content-version-actor'
import { requireGlobalAi } from '../middleware/require-global-ai'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

type DbClient = TRPCContext['db']
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

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
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
        message: `Another package place has the normalized name �${normalized}�.`,
      })
    } else if (
      existingPlaceNames.has(normalized) &&
      existingPlaceNames.get(normalized) !== place.excludeId
    ) {
      warnings.push({
        code: 'DUPLICATE_EXISTING_CONTENT',
        path: place.path,
        message: `An active venue place already has the normalized name �${normalized}�.`,
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
        message: `Another package knowledge entry has the normalized title �${normalized}�.`,
      })
    } else if (
      existingKnowledgeTitles.has(normalized) &&
      existingKnowledgeTitles.get(normalized) !== entry.excludeId
    ) {
      warnings.push({
        code: 'DUPLICATE_EXISTING_CONTENT',
        path: entry.path,
        message: `Venue knowledge already has the normalized title �${normalized}�.`,
      })
    }
    seenKnowledge.add(normalized)
  })

  return sortVenuePackageIssues(warnings)
}

export async function latestTargetVersions(
  db: DbClient,
  tenantId: string,
  venueId: string,
  placeIds: string[],
  knowledgeIds: string[],
  includeVenue: boolean,
) {
  if (!includeVenue && placeIds.length === 0 && knowledgeIds.length === 0)
    return new Map<string, string>()
  const targetWhere = {
    tenantId,
    venueId,
    OR: [
      ...(includeVenue ? [{ entityType: 'VENUE' as const, entityId: venueId }] : []),
      ...(placeIds.length > 0
        ? [{ entityType: 'PLACE' as const, entityId: { in: placeIds } }]
        : []),
      ...(knowledgeIds.length > 0
        ? [{ entityType: 'KNOWLEDGE_ENTRY' as const, entityId: { in: knowledgeIds } }]
        : []),
    ],
  }
  const latestTargets = await db.contentVersion.groupBy({
    by: ['entityType', 'entityId'],
    where: targetWhere,
    _max: { sequence: true },
  })
  const latestSequences = latestTargets.flatMap((row) =>
    row._max.sequence === null ? [] : [row._max.sequence],
  )
  if (latestSequences.length === 0) return new Map<string, string>()
  const versions = await db.contentVersion.findMany({
    where: {
      tenantId,
      venueId,
      sequence: { in: latestSequences },
    },
    select: { id: true, entityType: true, entityId: true },
    take: latestSequences.length,
  })
  return new Map(
    versions.map((version) => [`${version.entityType}:${version.entityId}`, version.id]),
  )
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

export async function buildVenuePackagePreview(
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
  preview: Awaited<ReturnType<typeof buildVenuePackagePreview>>,
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

export function parseStoredVenuePackagePreview(pkg: {
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

export class VenuePackageApprovedBaseStaleError extends TRPCError {
  constructor() {
    super({ code: 'CONFLICT', message: 'Venue content changed; create a new preview' })
  }
}

export function assertStoredVenuePackageEvidenceCurrent(params: {
  stored: VenuePackageStoredPreview
  deterministic: Awaited<ReturnType<typeof buildVenuePackagePreview>>
}): void {
  if (params.stored.baseDigest !== params.deterministic.baseDigest) {
    throw new VenuePackageApprovedBaseStaleError()
  }
  if (params.stored.payloadHash !== params.deterministic.payloadHash) {
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

export const venuePackageReadRouter = router({
  preview: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackagePreviewInput)
    .mutation(({ ctx, input }) =>
      buildVenuePackagePreview(ctx.db, ctx.session.activeTenantId, input.venueId, input.payload),
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
        const preview = parseStoredVenuePackagePreview(pkg)
        return { ...pkg, validationReport: preview.report, previewPlan: preview }
      })
    }),

  getById: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenuePackageByIdInput)
    .query(async ({ ctx, input }) => {
      const pkg = await findPackage(ctx.db, ctx.session.activeTenantId, input.id)
      if (!pkg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
      const preview = parseStoredVenuePackagePreview(pkg)
      return { ...pkg, validationReport: preview.report, previewPlan: preview }
    }),
})

async function runExplicitFinalizer(
  finalizer: VenuePackageDraftFinalizer | undefined,
  input: Parameters<VenuePackageDraftFinalizer>[0],
) {
  if (!finalizer) return undefined
  try {
    return await finalizer(input)
  } catch (error) {
    throw new VenuePackageDraftFinalizerError(error)
  }
}

export async function createVenuePackageDraftService(request: {
  db: DbClient
  tenantId: string
  actor: { type: 'HUMAN'; id: string; role: 'MANAGER' | 'OWNER' | 'PLATFORM_ADMIN' }
  input: typeof VenuePackageDraftInput._output
  finalizer?: VenuePackageDraftFinalizer
  isolationLevel?: 'ReadCommitted' | 'Serializable'
}) {
  const { db, tenantId, actor, input, finalizer } = request
  await assertGlobalAiAvailable(db)
  const key = {
    tenantId,
    venueId: input.venueId,
    draftKey: input.draftKey,
  }
  const requestedPayloadHash = digest(canonicalVenuePackagePayload(input.venueId, input.payload))
  const claimToken = randomUUID()

  let prepared
  try {
    prepared = await db.$transaction(
      async (transaction) => {
        await lockVenueContentMutation(transaction, { tenantId, venueId: input.venueId })
        const existingPackage = await transaction.venuePackage.findFirst({
          where: key,
          select: venuePackageSelect,
        })
        if (existingPackage) {
          if (existingPackage.payloadHash !== requestedPayloadHash) {
            conflict('Draft key was already used for different venue-package content')
          }
          const existingPreview = parseStoredVenuePackagePreview(existingPackage)
          const attachment = await runExplicitFinalizer(finalizer, {
            tx: transaction as DbClient,
            packageId: existingPackage.id,
            tenantId,
            venueId: input.venueId,
            status: existingPackage.status,
            createdBy: existingPackage.createdBy,
            preview: existingPreview,
            replayed: true,
          })
          return {
            kind: 'complete' as const,
            pkg: existingPackage,
            preview: existingPreview,
            replayed: true,
            attachment,
          }
        }

        const preview = await buildVenuePackagePreview(
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
              createdBy: actor.id,
            },
            select: venuePackageSelect,
          })
          const attachment = await runExplicitFinalizer(finalizer, {
            tx: transaction as DbClient,
            packageId: pkg.id,
            tenantId,
            venueId: input.venueId,
            status: pkg.status,
            createdBy: pkg.createdBy,
            preview: finalPreview,
            replayed: false,
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
              createdBy: actor.id,
              completedAt: new Date(),
            },
          })
          await writeAuditLogStrict(
            {
              tenantId,
              actorId: actor.id,
              actorRole: actor.role,
              action: 'venue-package.created-draft',
              targetType: 'VenuePackage',
              targetId: pkg.id,
              afterState: auditState(pkg),
            },
            transaction as DbClient,
          )
          return {
            kind: 'complete' as const,
            pkg,
            preview: finalPreview,
            replayed: false,
            attachment,
          }
        }

        const analysis = await transaction.venuePackageDuplicateAnalysis.create({
          data: {
            ...key,
            payloadHash: preview.payloadHash,
            baseDigest: preview.baseDigest,
            claimToken,
            embeddingProfiles: jsonValue(VENUE_PACKAGE_SEMANTIC_PROFILES),
            similarityThreshold: VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD,
            createdBy: actor.id,
          },
          select: { id: true },
        })
        return { kind: 'claimed' as const, analysisId: analysis.id, preview }
      },
      { isolationLevel: request.isolationLevel ?? 'ReadCommitted' },
    )
  } catch (error) {
    if (error instanceof VenuePackageDraftFinalizerError) throw error.cause
    throw error
  }

  if (prepared.kind === 'complete') {
    return {
      value: { ...prepared.pkg, preview: prepared.preview, replayed: prepared.replayed },
      attachment: prepared.attachment,
    }
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
    db,
    tenantId,
    venueId: input.venueId,
    feature: 'venue-package-duplicate-analysis',
    surface: 'client-dashboard',
  })

  const settleFailure = async (status: 'FAILED' | 'STALE', errorCode: string) => {
    try {
      await db.venuePackageDuplicateAnalysis.updateMany({
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
      admissionGuard: () => assertVenueAiAvailable(db, { tenantId, venueId: input.venueId }),
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
    const finalized = await db.$transaction(
      async (transaction) => {
        await lockVenueContentMutation(transaction, { tenantId, venueId: input.venueId })
        const preview = await buildVenuePackagePreview(
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
            createdBy: actor.id,
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
        const attachment = await runExplicitFinalizer(finalizer, {
          tx: transaction as DbClient,
          packageId: pkg.id,
          tenantId,
          venueId: input.venueId,
          status: pkg.status,
          createdBy: pkg.createdBy,
          preview: finalPreview,
          replayed: false,
        })
        await writeAuditLogStrict(
          {
            tenantId,
            actorId: actor.id,
            actorRole: actor.role,
            action: 'venue-package.created-draft',
            targetType: 'VenuePackage',
            targetId: pkg.id,
            afterState: auditState(pkg),
          },
          transaction as DbClient,
        )
        return { kind: 'complete' as const, pkg, preview: finalPreview, attachment }
      },
      { isolationLevel: request.isolationLevel ?? 'ReadCommitted' },
    )
    if (finalized.kind === 'stale') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Venue content or embedding coverage changed during analysis; use a new key.',
      })
    }
    return {
      value: { ...finalized.pkg, preview: finalized.preview, replayed: false },
      attachment: finalized.attachment,
    }
  } catch (error) {
    if (error instanceof VenuePackageDraftFinalizerError) {
      await settleFailure('FAILED', 'attachment-finalization-failed')
      throw error.cause
    }
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
}

export const venuePackageCreateRouter = router({
  createDraft: tenantProcedure
    .use(requireRole('MANAGER'))
    .use(requireGlobalAi)
    .input(VenuePackageDraftInput)
    .mutation(async ({ ctx, input }) => {
      const result = await createVenuePackageDraftService({
        db: ctx.db,
        tenantId: ctx.session.activeTenantId,
        actor: {
          type: 'HUMAN',
          id: ctx.session.userId,
          role: ctx.session.role === 'OWNER' ? 'OWNER' : 'MANAGER',
        },
        input,
      })
      return result.value
    }),
})

export const venuePackageLifecycleRouter = router({
  approve: tenantProcedure
    .use(requireRole('OWNER'))
    .input(VenuePackageApprovalInput)
    .mutation(({ ctx, input }) =>
      approveVenuePackageLifecycle({
        db: ctx.db,
        tenantId: ctx.session.activeTenantId,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'OWNER' },
        command: input,
      }),
    ),

  applyPackage: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withContentVersionActor)
    .input(VenuePackageLifecycleInput)
    .mutation(({ ctx, input }) =>
      applyVenuePackageLifecycle({
        db: ctx.db,
        tenantId: ctx.session.activeTenantId,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'OWNER' },
        command: input,
      }),
    ),

  revertPackage: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withContentVersionActor)
    .input(VenuePackageLifecycleInput)
    .mutation(({ ctx, input }) =>
      revertVenuePackageLifecycle({
        db: ctx.db,
        tenantId: ctx.session.activeTenantId,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'OWNER' },
        command: input,
      }),
    ),
})

export const venuePackageRouter = mergeRouters(
  venuePackageReadRouter,
  venuePackageCreateRouter,
  venuePackageLifecycleRouter,
)
