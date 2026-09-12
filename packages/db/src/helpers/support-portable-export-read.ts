import { createHash } from 'node:crypto'

import {
  canonicalSupportPortableExportJson,
  SUPPORT_PORTABLE_EXPORT_MAX_BYTES,
  SUPPORT_PORTABLE_EXPORT_OMISSIONS,
  SUPPORT_PORTABLE_EXPORT_SCHEMA_VERSION,
  SUPPORT_PORTABLE_EXPORT_SECTIONS,
  SupportPortableExportEnvelope,
  SupportPortableExportInput,
  SupportPortableExportPayload,
  SupportPortableVenuePackagePayload,
  SupportedVenuePackageSourcePayload,
  type SupportPortableExportSection,
} from '@pathfinder/contracts'

import { db } from '../client'
import {
  IncompatibleContentSnapshotError,
  knowledgeSnapshotData,
  operationalUpdateSnapshotData,
  placeSnapshotData,
  venueSnapshotData,
} from './content-history-snapshots'
import { tenantSupportRequestAccessWhere } from './support-request-access'

export const SUPPORT_PORTABLE_EXPORT_LIMITS = {
  places: 500,
  knowledgeEntries: 500,
  contentHistoryVersions: 2_000,
  venuePackages: 500,
  publishedReports: 250,
  supportRequests: 100,
  supportMessages: 2_000,
  supportAttachments: 2_000,
} as const

// This intentionally uses the same ceiling as the final response. The preflight counts whole
// source rows, including locator fields that the projection later omits, so it can conservatively
// refuse an export whose portable projection might have fit. That tradeoff keeps large JSON/text
// values out of the application heap before projection and canonicalization.
export const SUPPORT_PORTABLE_EXPORT_MAX_SOURCE_BYTES = SUPPORT_PORTABLE_EXPORT_MAX_BYTES

export type SupportPortableExportReadErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'PRECONDITION_FAILED'
  | 'LIMIT_EXCEEDED'
  | 'UNSUPPORTED_RECORD'

export class SupportPortableExportReadError extends Error {
  constructor(
    readonly code: SupportPortableExportReadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SupportPortableExportReadError'
  }
}

type ExportClient = Pick<typeof db, '$transaction'>
type ExportRole = 'STAFF' | 'MANAGER' | 'OWNER'
type PackageSource = ReturnType<typeof SupportedVenuePackageSourcePayload.parse>

function fail(code: SupportPortableExportReadErrorCode, message: string): never {
  throw new SupportPortableExportReadError(code, message)
}

function assertWithinLimit(label: string, rows: unknown[], limit: number): void {
  if (rows.length > limit) fail('LIMIT_EXCEEDED', `${label} exceeds the portable export limit`)
}

function iso(value: Date): string {
  return value.toISOString()
}

const OMITTED_PACKAGE_LOCATOR_FIELDS = new Set([
  'photoUrl',
  'chatLogoUrl',
  'chatBannerUrl',
  'sourceUrl',
])

function projectPackagePayload(source: PackageSource) {
  const clone = JSON.parse(JSON.stringify(source)) as unknown
  const omitLocators = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(omitLocators)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, nested] of Object.entries(value)) {
      if (OMITTED_PACKAGE_LOCATOR_FIELDS.has(key)) delete (value as Record<string, unknown>)[key]
      else omitLocators(nested)
    }
  }
  omitLocators(clone)
  return SupportPortableVenuePackagePayload.parse(clone)
}

function assertSupportedPackageItemCount(source: PackageSource): void {
  const count =
    source.schemaVersion === 3
      ? source.places.create.length +
        source.places.update.length +
        source.places.delete.length +
        source.knowledgeEntries.create.length +
        source.knowledgeEntries.update.length +
        source.knowledgeEntries.delete.length
      : source.places.length + source.knowledgeEntries.length
  if (count > 500) fail('UNSUPPORTED_RECORD', 'Venue package exceeds its supported item limit')
  if (count === 0 && (source.schemaVersion === 1 || source.venue === undefined)) {
    fail('UNSUPPORTED_RECORD', 'Venue package has no supported content')
  }
  const createdPlaces =
    source.schemaVersion === 3 ? source.places.create.map((row) => row.value) : source.places
  if (createdPlaces.some((place) => (place.lat === undefined) !== (place.lng === undefined))) {
    fail('UNSUPPORTED_RECORD', 'Venue package has incomplete coordinates')
  }
  if (source.schemaVersion === 3) {
    const operations = [
      ...source.places.create,
      ...source.places.update,
      ...source.places.delete,
      ...source.knowledgeEntries.create,
      ...source.knowledgeEntries.update,
      ...source.knowledgeEntries.delete,
    ]
    if (new Set(operations.map((operation) => operation.itemKey)).size !== operations.length) {
      fail('UNSUPPORTED_RECORD', 'Venue package has duplicate item identities')
    }
  }
}

function assertProjectedSize(value: unknown): void {
  if (
    Buffer.byteLength(canonicalSupportPortableExportJson(value), 'utf8') >
    SUPPORT_PORTABLE_EXPORT_MAX_BYTES
  ) {
    fail('LIMIT_EXCEEDED', 'Portable export exceeds the byte limit')
  }
}

type SourcePreflight = {
  placesCount: bigint
  knowledgeEntriesCount: bigint
  contentHistoryVersionsCount: bigint
  venuePackagesCount: bigint
  publishedReportsCount: bigint
  supportRequestsCount: bigint
  supportMessagesCount: bigint
  supportAttachmentsCount: bigint
  sourceBytes: bigint
}

async function assertSourcePreflight(
  tx: typeof db,
  input: SupportPortableExportInput,
  requested: ReadonlySet<SupportPortableExportSection>,
): Promise<void> {
  const [result] = await tx.$queryRaw<SourcePreflight[]>`
    WITH accessible_support_requests AS (
      SELECT request.id
      FROM support_requests request
      WHERE request.tenant_id = ${input.tenantId}
        AND request.venue_id = ${input.venueId}
        AND (
          (
            request.created_by_kind = 'CLIENT'
            AND request.requester_user_id = ${input.recipientUserId}
            AND EXISTS (
              SELECT 1
              FROM tenant_memberships requester_membership
              WHERE requester_membership.tenant_id = request.tenant_id
                AND requester_membership.user_id = request.requester_user_id
                AND requester_membership.status = 'ACTIVE'
            )
          )
          OR EXISTS (
            SELECT 1
            FROM support_request_participants participant
            JOIN tenant_memberships participant_membership
              ON participant_membership.tenant_id = participant.tenant_id
              AND participant_membership.user_id = participant.user_id
              AND participant_membership.status = 'ACTIVE'
            WHERE participant.tenant_id = request.tenant_id
              AND participant.venue_id = request.venue_id
              AND participant.support_request_id = request.id
              AND participant.user_id = ${input.recipientUserId}
              AND participant.revoked_at IS NULL
          )
        )
    ),
    visible_support_messages AS (
      SELECT message.id
      FROM support_messages message
      JOIN accessible_support_requests request ON request.id = message.support_request_id
      WHERE message.tenant_id = ${input.tenantId}
        AND message.venue_id = ${input.venueId}
        AND message.visibility = 'CLIENT_VISIBLE'
    )
    SELECT
      CASE WHEN ${requested.has('current-venue')} THEN
        (SELECT COUNT(*) FROM places WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId})
      ELSE 0 END::bigint AS "placesCount",
      CASE WHEN ${requested.has('current-venue')} THEN
        (SELECT COUNT(*) FROM venue_knowledge_entries WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId})
      ELSE 0 END::bigint AS "knowledgeEntriesCount",
      CASE WHEN ${requested.has('content-history')} THEN
        (SELECT COUNT(*) FROM content_versions WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId})
      ELSE 0 END::bigint AS "contentHistoryVersionsCount",
      CASE WHEN ${requested.has('venue-packages')} THEN
        (SELECT COUNT(*) FROM venue_packages WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId})
      ELSE 0 END::bigint AS "venuePackagesCount",
      CASE WHEN ${requested.has('published-reports')} THEN
        (SELECT COUNT(*) FROM weekly_reports WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId} AND status = 'PUBLISHED' AND content IS NOT NULL AND published_at IS NOT NULL)
      ELSE 0 END::bigint AS "publishedReportsCount",
      CASE WHEN ${requested.has('recipient-support')} THEN
        (SELECT COUNT(*) FROM accessible_support_requests)
      ELSE 0 END::bigint AS "supportRequestsCount",
      CASE WHEN ${requested.has('recipient-support')} THEN
        (SELECT COUNT(*) FROM visible_support_messages)
      ELSE 0 END::bigint AS "supportMessagesCount",
      CASE WHEN ${requested.has('recipient-support')} THEN
        (SELECT COUNT(*) FROM support_message_attachments attachment JOIN visible_support_messages message ON message.id = attachment.support_message_id WHERE attachment.tenant_id = ${input.tenantId} AND attachment.venue_id = ${input.venueId})
      ELSE 0 END::bigint AS "supportAttachmentsCount",
      (
        CASE WHEN ${requested.has('current-venue')} THEN
          COALESCE((SELECT SUM(octet_length(to_jsonb(place)::text)) FROM places place WHERE place.tenant_id = ${input.tenantId} AND place.venue_id = ${input.venueId}), 0)
          + COALESCE((SELECT SUM(octet_length(to_jsonb(entry)::text)) FROM venue_knowledge_entries entry WHERE entry.tenant_id = ${input.tenantId} AND entry.venue_id = ${input.venueId}), 0)
        ELSE 0 END
        + CASE WHEN ${requested.has('content-history')} THEN
          COALESCE((SELECT SUM(octet_length(to_jsonb(version)::text)) FROM content_versions version WHERE version.tenant_id = ${input.tenantId} AND version.venue_id = ${input.venueId}), 0)
        ELSE 0 END
        + CASE WHEN ${requested.has('venue-packages')} THEN
          COALESCE((SELECT SUM(octet_length(to_jsonb(package)::text)) FROM venue_packages package WHERE package.tenant_id = ${input.tenantId} AND package.venue_id = ${input.venueId}), 0)
        ELSE 0 END
        + CASE WHEN ${requested.has('published-reports')} THEN
          COALESCE((SELECT SUM(octet_length(to_jsonb(report)::text)) FROM weekly_reports report WHERE report.tenant_id = ${input.tenantId} AND report.venue_id = ${input.venueId} AND report.status = 'PUBLISHED' AND report.content IS NOT NULL AND report.published_at IS NOT NULL), 0)
        ELSE 0 END
        + CASE WHEN ${requested.has('recipient-support')} THEN
          COALESCE((SELECT SUM(octet_length(to_jsonb(request)::text)) FROM support_requests request JOIN accessible_support_requests accessible ON accessible.id = request.id), 0)
          + COALESCE((SELECT SUM(octet_length(to_jsonb(message)::text)) FROM support_messages message JOIN visible_support_messages visible ON visible.id = message.id), 0)
          + COALESCE((SELECT SUM(octet_length(to_jsonb(attachment)::text)) FROM support_message_attachments attachment JOIN visible_support_messages message ON message.id = attachment.support_message_id WHERE attachment.tenant_id = ${input.tenantId} AND attachment.venue_id = ${input.venueId}), 0)
        ELSE 0 END
      )::bigint AS "sourceBytes"
  `
  if (!result) fail('PRECONDITION_FAILED', 'Portable export source preflight failed')
  const countLimits = [
    ['Places', result.placesCount, SUPPORT_PORTABLE_EXPORT_LIMITS.places],
    [
      'Knowledge entries',
      result.knowledgeEntriesCount,
      SUPPORT_PORTABLE_EXPORT_LIMITS.knowledgeEntries,
    ],
    [
      'Content history',
      result.contentHistoryVersionsCount,
      SUPPORT_PORTABLE_EXPORT_LIMITS.contentHistoryVersions,
    ],
    ['Venue packages', result.venuePackagesCount, SUPPORT_PORTABLE_EXPORT_LIMITS.venuePackages],
    [
      'Published reports',
      result.publishedReportsCount,
      SUPPORT_PORTABLE_EXPORT_LIMITS.publishedReports,
    ],
    [
      'Support requests',
      result.supportRequestsCount,
      SUPPORT_PORTABLE_EXPORT_LIMITS.supportRequests,
    ],
    [
      'Support messages',
      result.supportMessagesCount,
      SUPPORT_PORTABLE_EXPORT_LIMITS.supportMessages,
    ],
    [
      'Support attachments',
      result.supportAttachmentsCount,
      SUPPORT_PORTABLE_EXPORT_LIMITS.supportAttachments,
    ],
  ] as const
  for (const [label, count, limit] of countLimits) {
    if (count > BigInt(limit)) fail('LIMIT_EXCEEDED', `${label} exceeds the portable export limit`)
  }
  if (result.sourceBytes > BigInt(SUPPORT_PORTABLE_EXPORT_MAX_SOURCE_BYTES)) {
    fail('LIMIT_EXCEEDED', 'Portable export source exceeds the byte limit')
  }
}

function venueHistoryState(row: ReturnType<typeof venueSnapshotData>['create']) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    venueId: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    guideNotes: row.guideNotes,
    aiGuideNotes: row.aiGuideNotes,
    aiFeaturedPlaceId: row.aiFeaturedPlaceId,
    aiTone: row.aiTone,
    tonePreset: row.tonePreset ?? null,
    tonePresetVersion: row.tonePresetVersion ?? null,
    aiGuideName: row.aiGuideName,
    chatTheme: row.chatTheme,
    chatAccentColor: row.chatAccentColor,
    chatFont: row.chatFont,
    category: row.category,
    guideMode: row.guideMode,
    defaultCenterLat: row.defaultCenterLat,
    defaultCenterLng: row.defaultCenterLng,
    isActive: row.isActive,
  }
}

function provenance(row: Record<string, unknown>) {
  return {
    sourceType: String(row.sourceType),
    authorship: String(row.authorship),
    sourceName: (row.sourceName as string | null) ?? null,
    importedAt: row.importedAt instanceof Date ? iso(row.importedAt) : null,
    humanConfirmedAt: row.humanConfirmedAt instanceof Date ? iso(row.humanConfirmedAt) : null,
    lastReviewedAt: row.lastReviewedAt instanceof Date ? iso(row.lastReviewedAt) : null,
    sourcePackageId: (row.sourcePackageId as string | null) ?? null,
  }
}

function placeHistoryState(
  row: ReturnType<typeof placeSnapshotData>['create'],
  schemaVersion: number,
) {
  const record = row as typeof row & Record<string, unknown>
  return {
    id: row.id,
    tenantId: row.tenantId,
    venueId: row.venueId,
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
    isActive: row.isActive,
    provenance: schemaVersion === 2 ? provenance(record) : null,
  }
}

function knowledgeHistoryState(
  row: ReturnType<typeof knowledgeSnapshotData>['create'],
  schemaVersion: number,
) {
  const record = row as typeof row & Record<string, unknown>
  return {
    id: row.id,
    tenantId: row.tenantId,
    venueId: row.venueId,
    title: row.title,
    category: row.category,
    content: row.content,
    isEnabled: row.isEnabled,
    provenance: schemaVersion === 2 ? provenance(record) : null,
  }
}

function operationalUpdateHistoryState(
  row: ReturnType<typeof operationalUpdateSnapshotData>['snapshot'],
) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    venueId: row.venueId,
    placeId: row.placeId,
    updateType: row.updateType,
    severity: row.severity,
    priority: row.priority,
    title: row.title,
    body: row.body,
    redirectTo: row.redirectTo,
    startsAt: iso(row.startsAt),
    expiresAt: iso(row.expiresAt),
    status: row.status,
    isActive: row.isActive,
    publishedAt: row.publishedAt ? iso(row.publishedAt) : null,
    createdAt: iso(row.createdAt),
  }
}

function historyState(
  value: unknown,
  row: {
    tenantId: string
    venueId: string
    entityType: string
    entityId: string
    snapshotSchemaVersion: number
  },
) {
  if (value === null) return null
  if (row.entityType === 'VENUE') {
    if (row.entityId !== row.venueId) throw new IncompatibleContentSnapshotError()
    if (![1, 2].includes(row.snapshotSchemaVersion)) throw new IncompatibleContentSnapshotError()
    return venueHistoryState(
      venueSnapshotData(value, { tenantId: row.tenantId, entityId: row.entityId }).create,
    )
  }
  if (row.entityType === 'PLACE') {
    if (![1, 2].includes(row.snapshotSchemaVersion)) throw new IncompatibleContentSnapshotError()
    return placeHistoryState(
      placeSnapshotData(value, row.snapshotSchemaVersion as 1 | 2, {
        tenantId: row.tenantId,
        venueId: row.venueId,
        entityId: row.entityId,
      }).create,
      row.snapshotSchemaVersion,
    )
  }
  if (row.entityType === 'KNOWLEDGE_ENTRY') {
    if (![1, 2].includes(row.snapshotSchemaVersion)) throw new IncompatibleContentSnapshotError()
    return knowledgeHistoryState(
      knowledgeSnapshotData(value, row.snapshotSchemaVersion as 1 | 2, {
        tenantId: row.tenantId,
        venueId: row.venueId,
        entityId: row.entityId,
      }).create,
      row.snapshotSchemaVersion,
    )
  }
  if (row.entityType === 'OPERATIONAL_UPDATE') {
    if (row.snapshotSchemaVersion !== 1) throw new IncompatibleContentSnapshotError()
    const snapshot = operationalUpdateSnapshotData(value, {
      tenantId: row.tenantId,
      entityId: row.entityId,
    }).snapshot
    if (snapshot.venueId !== row.venueId) throw new IncompatibleContentSnapshotError()
    return operationalUpdateHistoryState(snapshot)
  }
  throw new IncompatibleContentSnapshotError()
}

function hasManagerRole(role: ExportRole): boolean {
  return role === 'MANAGER' || role === 'OWNER'
}

export async function readSupportPortableExport(
  rawInput: SupportPortableExportInput,
  client: ExportClient = db,
  options: { now?: () => Date } = {},
): Promise<SupportPortableExportEnvelope> {
  const input = SupportPortableExportInput.parse(rawInput)
  const now = options.now ?? (() => new Date())

  return client.$transaction(
    async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const membership = await tx.tenantMembership.findFirst({
        where: { tenantId: input.tenantId, userId: input.recipientUserId, status: 'ACTIVE' },
        select: { role: true },
      })
      if (!membership) fail('NOT_FOUND', 'Active export recipient not found')
      const role = membership.role as ExportRole
      if (
        input.sections.some((section) =>
          (['content-history', 'venue-packages'] as SupportPortableExportSection[]).includes(
            section,
          ),
        ) &&
        !hasManagerRole(role)
      ) {
        fail('FORBIDDEN', 'The recipient role cannot access the requested export sections')
      }

      const venue = await tx.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
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
          chatTheme: true,
          chatAccentColor: true,
          chatFont: true,
          chatShowPhotos: true,
          chatShowLinks: true,
          category: true,
          guideMode: true,
          defaultCenterLat: true,
          defaultCenterLng: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          venueBotConfiguration: {
            select: {
              presentationMode: true,
              personalityMode: true,
              tonePreset: true,
              tonePresetVersion: true,
              responseDepth: true,
              characterKey: true,
              customCharacterId: true,
              publicDisplayName: true,
              greeting: true,
              revision: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      })
      if (!venue) fail('NOT_FOUND', 'Venue not found')

      const orderedSections = SUPPORT_PORTABLE_EXPORT_SECTIONS.filter((section) =>
        input.sections.includes(section),
      )
      const requested = new Set(orderedSections)
      if (requested.has('published-reports')) {
        if (!venue.isActive) fail('PRECONDITION_FAILED', 'Published reports are unavailable')
        const configuration = await tx.venueReportConfiguration.findFirst({
          where: { tenantId: input.tenantId, venueId: input.venueId, enabled: true },
          select: { id: true },
        })
        if (!configuration) fail('PRECONDITION_FAILED', 'Published reports are unavailable')
      }
      await assertSourcePreflight(tx, input, requested)
      const counts = {
        places: 0,
        knowledgeEntries: 0,
        contentHistoryVersions: 0,
        venuePackages: 0,
        publishedReports: 0,
        supportRequests: 0,
        supportMessages: 0,
        supportAttachments: 0,
      }
      const sections: Partial<SupportPortableExportPayload> = {}

      if (requested.has('current-venue')) {
        const [places, knowledgeEntries] = await Promise.all([
          tx.place.findMany({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: SUPPORT_PORTABLE_EXPORT_LIMITS.places + 1,
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
              isActive: true,
              visibility: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
          tx.venueKnowledgeEntry.findMany({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: SUPPORT_PORTABLE_EXPORT_LIMITS.knowledgeEntries + 1,
            select: {
              id: true,
              title: true,
              category: true,
              content: true,
              isEnabled: true,
              visibility: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
        ])
        assertWithinLimit('Places', places, SUPPORT_PORTABLE_EXPORT_LIMITS.places)
        assertWithinLimit(
          'Knowledge entries',
          knowledgeEntries,
          SUPPORT_PORTABLE_EXPORT_LIMITS.knowledgeEntries,
        )
        counts.places = places.length
        counts.knowledgeEntries = knowledgeEntries.length
        sections.currentVenue = {
          venue: {
            id: venue.id,
            name: venue.name,
            slug: venue.slug,
            description: venue.description,
            guideNotes: venue.guideNotes,
            aiGuideNotes: venue.aiGuideNotes,
            aiFeaturedPlaceId: venue.aiFeaturedPlaceId,
            aiTone: venue.aiTone,
            tonePreset: venue.tonePreset,
            tonePresetVersion: venue.tonePresetVersion,
            aiGuideName: venue.aiGuideName,
            chatTheme: venue.chatTheme,
            chatAccentColor: venue.chatAccentColor,
            chatFont: venue.chatFont,
            chatShowPhotos: venue.chatShowPhotos,
            chatShowLinks: venue.chatShowLinks,
            category: venue.category,
            guideMode: venue.guideMode,
            defaultCenterLat: venue.defaultCenterLat,
            defaultCenterLng: venue.defaultCenterLng,
            isActive: venue.isActive,
            createdAt: iso(venue.createdAt),
            updatedAt: iso(venue.updatedAt),
          },
          botConfiguration: venue.venueBotConfiguration
            ? {
                presentationMode: venue.venueBotConfiguration.presentationMode,
                personalityMode: venue.venueBotConfiguration.personalityMode,
                tonePreset: venue.venueBotConfiguration.tonePreset,
                tonePresetVersion: venue.venueBotConfiguration.tonePresetVersion,
                responseDepth: venue.venueBotConfiguration.responseDepth,
                characterKey: venue.venueBotConfiguration.characterKey,
                customCharacterId: venue.venueBotConfiguration.customCharacterId,
                publicDisplayName: venue.venueBotConfiguration.publicDisplayName,
                greeting: venue.venueBotConfiguration.greeting,
                revision: venue.venueBotConfiguration.revision,
                createdAt: iso(venue.venueBotConfiguration.createdAt),
                updatedAt: iso(venue.venueBotConfiguration.updatedAt),
              }
            : null,
          places: places.map((place) => ({
            id: place.id,
            name: place.name,
            type: place.type,
            itemType: place.itemType,
            shortDescription: place.shortDescription,
            longDescription: place.longDescription,
            lat: place.lat,
            lng: place.lng,
            tags: place.tags,
            importanceScore: place.importanceScore,
            areaName: place.areaName,
            hours: place.hours,
            isActive: place.isActive,
            visibility: place.visibility,
            createdAt: iso(place.createdAt),
            updatedAt: iso(place.updatedAt),
          })),
          knowledgeEntries: knowledgeEntries.map((entry) => ({
            id: entry.id,
            title: entry.title,
            category: entry.category,
            content: entry.content,
            isEnabled: entry.isEnabled,
            visibility: entry.visibility,
            createdAt: iso(entry.createdAt),
            updatedAt: iso(entry.updatedAt),
          })),
        }
        assertProjectedSize(sections)
      }

      if (requested.has('content-history')) {
        const rows = await tx.contentVersion.findMany({
          where: { tenantId: input.tenantId, venueId: input.venueId },
          orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
          take: SUPPORT_PORTABLE_EXPORT_LIMITS.contentHistoryVersions + 1,
          select: {
            id: true,
            sequence: true,
            tenantId: true,
            venueId: true,
            entityType: true,
            entityId: true,
            operation: true,
            beforeState: true,
            afterState: true,
            snapshotSchemaVersion: true,
            createdAt: true,
          },
        })
        assertWithinLimit(
          'Content history',
          rows,
          SUPPORT_PORTABLE_EXPORT_LIMITS.contentHistoryVersions,
        )
        try {
          sections.contentHistory = rows.map((row) => ({
            id: row.id,
            sequence: row.sequence.toString(),
            entityType: row.entityType as
              | 'VENUE'
              | 'PLACE'
              | 'KNOWLEDGE_ENTRY'
              | 'OPERATIONAL_UPDATE',
            entityId: row.entityId,
            operation: row.operation,
            snapshotSchemaVersion: row.snapshotSchemaVersion,
            beforeState: historyState(row.beforeState, row),
            afterState: historyState(row.afterState, row),
            createdAt: iso(row.createdAt),
          }))
        } catch (error) {
          if (error instanceof SupportPortableExportReadError) throw error
          if (error instanceof IncompatibleContentSnapshotError) {
            fail('UNSUPPORTED_RECORD', 'Content history contains an unsupported snapshot')
          }
          throw error
        }
        counts.contentHistoryVersions = rows.length
        assertProjectedSize(sections)
      }

      if (requested.has('venue-packages')) {
        const rows = await tx.venuePackage.findMany({
          where: { tenantId: input.tenantId, venueId: input.venueId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: SUPPORT_PORTABLE_EXPORT_LIMITS.venuePackages + 1,
          select: {
            id: true,
            schemaVersion: true,
            payload: true,
            payloadHash: true,
            status: true,
            approvedAt: true,
            appliedAt: true,
            revertedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        })
        assertWithinLimit('Venue packages', rows, SUPPORT_PORTABLE_EXPORT_LIMITS.venuePackages)
        sections.venuePackages = rows.map((row) => {
          const source = SupportedVenuePackageSourcePayload.safeParse(row.payload)
          if (!source.success || source.data.schemaVersion !== row.schemaVersion) {
            return fail('UNSUPPORTED_RECORD', 'Venue package uses an unsupported payload version')
          }
          assertSupportedPackageItemCount(source.data)
          const projection = projectPackagePayload(source.data)
          const projectionJson = canonicalSupportPortableExportJson(projection)
          return {
            id: row.id,
            schemaVersion: projection.schemaVersion,
            status: row.status,
            payload: projection,
            sourcePayloadSha256: row.payloadHash,
            exportedProjectionSha256: createHash('sha256').update(projectionJson).digest('hex'),
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt),
            approvedAt: row.approvedAt ? iso(row.approvedAt) : null,
            appliedAt: row.appliedAt ? iso(row.appliedAt) : null,
            revertedAt: row.revertedAt ? iso(row.revertedAt) : null,
          }
        })
        counts.venuePackages = rows.length
        assertProjectedSize(sections)
      }

      if (requested.has('published-reports')) {
        const rows = await tx.weeklyReport.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: 'PUBLISHED',
            content: { not: null },
            publishedAt: { not: null },
          },
          orderBy: [{ weekStart: 'asc' }, { id: 'asc' }],
          take: SUPPORT_PORTABLE_EXPORT_LIMITS.publishedReports + 1,
          select: {
            id: true,
            title: true,
            weekStart: true,
            weekEnd: true,
            content: true,
            publishedAt: true,
          },
        })
        assertWithinLimit(
          'Published reports',
          rows,
          SUPPORT_PORTABLE_EXPORT_LIMITS.publishedReports,
        )
        sections.publishedReports = rows.map((report) => ({
          id: report.id,
          title: report.title,
          weekStart: iso(report.weekStart),
          weekEnd: iso(report.weekEnd),
          content: report.content!,
          publishedAt: iso(report.publishedAt!),
        }))
        counts.publishedReports = rows.length
        assertProjectedSize(sections)
      }

      if (requested.has('recipient-support')) {
        const requests = await tx.supportRequest.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...tenantSupportRequestAccessWhere({ actorId: input.recipientUserId, role }),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: SUPPORT_PORTABLE_EXPORT_LIMITS.supportRequests + 1,
          select: {
            id: true,
            category: true,
            status: true,
            subject: true,
            missingInformation: true,
            requesterUserId: true,
            clientActivityAt: true,
            statusChangedAt: true,
            createdAt: true,
            participants: {
              where: { userId: input.recipientUserId, revokedAt: null },
              select: { userId: true, membership: { select: { status: true } } },
            },
          },
        })
        assertWithinLimit(
          'Support requests',
          requests,
          SUPPORT_PORTABLE_EXPORT_LIMITS.supportRequests,
        )
        const messages = requests.length
          ? await tx.supportMessage.findMany({
              where: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                supportRequestId: { in: requests.map((request) => request.id) },
                visibility: 'CLIENT_VISIBLE',
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: SUPPORT_PORTABLE_EXPORT_LIMITS.supportMessages + 1,
              select: {
                id: true,
                supportRequestId: true,
                authorKind: true,
                authorId: true,
                body: true,
                completionOutcome: true,
                createdAt: true,
              },
            })
          : []
        assertWithinLimit(
          'Support messages',
          messages,
          SUPPORT_PORTABLE_EXPORT_LIMITS.supportMessages,
        )
        const attachments = messages.length
          ? await tx.supportMessageAttachment.findMany({
              where: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                supportMessageId: { in: messages.map((message) => message.id) },
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: SUPPORT_PORTABLE_EXPORT_LIMITS.supportAttachments + 1,
              select: {
                id: true,
                supportMessageId: true,
                filename: true,
                mediaType: true,
                byteSize: true,
              },
            })
          : []
        assertWithinLimit(
          'Support attachments',
          attachments,
          SUPPORT_PORTABLE_EXPORT_LIMITS.supportAttachments,
        )
        const byRequest = new Map<string, typeof messages>()
        for (const message of messages) {
          const current = byRequest.get(message.supportRequestId) ?? []
          current.push(message)
          byRequest.set(message.supportRequestId, current)
        }
        const byMessage = new Map<string, typeof attachments>()
        for (const attachment of attachments) {
          const current = byMessage.get(attachment.supportMessageId) ?? []
          current.push(attachment)
          byMessage.set(attachment.supportMessageId, current)
        }
        sections.recipientSupport = requests.map((request) => ({
          id: request.id,
          category: request.category,
          status: request.status,
          subject: request.subject,
          missingInformation: request.missingInformation,
          requesterIsRecipient: request.requesterUserId === input.recipientUserId,
          participantIsRecipient: request.participants.some(
            (participant) =>
              participant.userId === input.recipientUserId &&
              participant.membership.status === 'ACTIVE',
          ),
          clientActivityAt: iso(request.clientActivityAt),
          statusChangedAt: iso(request.statusChangedAt),
          createdAt: iso(request.createdAt),
          messages: (byRequest.get(request.id) ?? []).map((message) => ({
            id: message.id,
            authorKind: message.authorKind,
            authorIsRecipient: message.authorId === input.recipientUserId,
            body: message.body,
            completionOutcome: message.completionOutcome,
            createdAt: iso(message.createdAt),
            attachments: (byMessage.get(message.id) ?? []).map((attachment) => ({
              id: attachment.id,
              filename: attachment.filename,
              mediaType: attachment.mediaType,
              byteSize: attachment.byteSize.toString(),
            })),
          })),
        }))
        counts.supportRequests = requests.length
        counts.supportMessages = messages.length
        counts.supportAttachments = attachments.length
        assertProjectedSize(sections)
      }

      const payload = SupportPortableExportPayload.parse({
        schemaVersion: SUPPORT_PORTABLE_EXPORT_SCHEMA_VERSION,
        capturedAt: iso(now()),
        scope: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          recipientUserId: input.recipientUserId,
        },
        recipient: { role },
        sections: orderedSections,
        counts,
        omissions: SUPPORT_PORTABLE_EXPORT_OMISSIONS,
        ...sections,
      })
      const canonicalPayload = canonicalSupportPortableExportJson(payload)
      const envelope = SupportPortableExportEnvelope.parse({
        ...payload,
        contentSha256: createHash('sha256').update(canonicalPayload).digest('hex'),
      })
      if (
        Buffer.byteLength(canonicalSupportPortableExportJson(envelope), 'utf8') >
        SUPPORT_PORTABLE_EXPORT_MAX_BYTES
      ) {
        fail('LIMIT_EXCEEDED', 'Portable export exceeds the byte limit')
      }
      return envelope
    },
    { isolationLevel: 'RepeatableRead' },
  )
}
