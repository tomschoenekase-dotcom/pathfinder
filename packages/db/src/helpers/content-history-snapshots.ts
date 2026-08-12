import * as prismaClient from '@prisma/client'
import { z } from 'zod'

export class IncompatibleContentSnapshotError extends Error {
  constructor() {
    super('The selected historical snapshot is incompatible with current content')
    this.name = 'IncompatibleContentSnapshotError'
  }
}

const nullableString = z.string().nullable()
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
)

const venueSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    venueId: z.string(),
    name: z.string(),
    slug: z.string(),
    description: nullableString,
    guideNotes: nullableString,
    aiGuideNotes: nullableString,
    aiFeaturedPlaceId: nullableString,
    aiTone: nullableString,
    tonePreset: nullableString.optional(),
    tonePresetVersion: z.number().int().positive().nullable().optional(),
    aiGuideName: nullableString,
    chatTheme: nullableString,
    chatAccentColor: nullableString,
    chatFont: nullableString,
    chatLogoUrl: nullableString,
    chatBannerUrl: nullableString,
    category: nullableString,
    guideMode: z.string(),
    defaultCenterLat: z.number().nullable(),
    defaultCenterLng: z.number().nullable(),
    geoBoundary: jsonValueSchema,
    isActive: z.boolean(),
  })
  .strict()

const placeSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    venueId: z.string(),
    name: z.string(),
    type: z.string(),
    itemType: nullableString,
    shortDescription: nullableString,
    longDescription: nullableString,
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    tags: z.array(z.string()),
    importanceScore: z.number().int(),
    areaName: nullableString,
    hours: nullableString,
    photoUrl: nullableString,
    isActive: z.boolean(),
  })
  .strict()

const provenanceSchema = z.object({
  sourceType: z.string(),
  authorship: z.string(),
  sourceName: nullableString,
  sourceUrl: nullableString,
  importedAt: z.coerce.date().nullable(),
  humanConfirmedAt: z.coerce.date().nullable(),
  humanConfirmedBy: nullableString,
  lastReviewedAt: z.coerce.date().nullable(),
  lastReviewedBy: nullableString,
  sourcePackageId: nullableString,
})

const placeV2Schema = placeSchema.extend(provenanceSchema.shape).strict()
const knowledgeSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    venueId: z.string(),
    title: z.string(),
    category: z.string(),
    content: z.string(),
    isEnabled: z.boolean(),
  })
  .strict()
const knowledgeV2Schema = knowledgeSchema.extend(provenanceSchema.shape).strict()

const operationalUpdateSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    venueId: z.string(),
    placeId: nullableString,
    updateType: z.enum([
      'GENERAL_NOTICE',
      'TEMPORARY_CLOSURE',
      'UNAVAILABLE_EXHIBIT',
      'CHANGED_HOURS',
      'MAINTENANCE',
      'SPECIAL_EVENT',
      'SOLD_OUT_ACTIVITY',
      'TEMPORARY_VENDOR_LOCATION',
    ]),
    severity: z.enum(['INFO', 'WARNING', 'CLOSURE', 'REDIRECT']),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
    title: z.string(),
    body: nullableString,
    redirectTo: nullableString,
    startsAt: z.coerce.date(),
    expiresAt: z.coerce.date(),
    status: z.enum(['DRAFT', 'PUBLISHED']),
    isActive: z.boolean(),
    createdBy: z.string(),
    publishedBy: nullableString,
    publishedAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
  })
  .strict()

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new IncompatibleContentSnapshotError()
  return parsed.data
}

function assertScope(
  snapshot: { id: string; tenantId: string; venueId?: string },
  scope: { tenantId: string; entityId: string; venueId?: string },
): void {
  if (
    snapshot.tenantId !== scope.tenantId ||
    snapshot.id !== scope.entityId ||
    (scope.venueId !== undefined && snapshot.venueId !== scope.venueId)
  ) {
    throw new IncompatibleContentSnapshotError()
  }
}

export function venueSnapshotData(value: unknown, scope: { tenantId: string; entityId: string }) {
  const snapshot = parse(venueSchema, value)
  assertScope(snapshot, { ...scope, venueId: scope.entityId })
  const mutable = {
    name: snapshot.name,
    slug: snapshot.slug,
    description: snapshot.description,
    guideNotes: snapshot.guideNotes,
    aiGuideNotes: snapshot.aiGuideNotes,
    aiFeaturedPlaceId: snapshot.aiFeaturedPlaceId,
    aiTone: snapshot.aiTone,
    ...(snapshot.tonePreset !== undefined ? { tonePreset: snapshot.tonePreset } : {}),
    ...(snapshot.tonePresetVersion !== undefined
      ? { tonePresetVersion: snapshot.tonePresetVersion }
      : {}),
    aiGuideName: snapshot.aiGuideName,
    chatTheme: snapshot.chatTheme,
    chatAccentColor: snapshot.chatAccentColor,
    chatFont: snapshot.chatFont,
    chatLogoUrl: snapshot.chatLogoUrl,
    chatBannerUrl: snapshot.chatBannerUrl,
    category: snapshot.category,
    guideMode: snapshot.guideMode,
    defaultCenterLat: snapshot.defaultCenterLat,
    defaultCenterLng: snapshot.defaultCenterLng,
    geoBoundary:
      snapshot.geoBoundary === null ? prismaClient['Prisma']['DbNull'] : snapshot.geoBoundary,
    isActive: snapshot.isActive,
  }
  return { mutable, create: { id: snapshot.id, tenantId: snapshot.tenantId, ...mutable } }
}

function provenance(snapshot: z.infer<typeof provenanceSchema>) {
  return {
    sourceType: snapshot.sourceType,
    authorship: snapshot.authorship,
    sourceName: snapshot.sourceName,
    sourceUrl: snapshot.sourceUrl,
    importedAt: snapshot.importedAt,
    humanConfirmedAt: snapshot.humanConfirmedAt,
    humanConfirmedBy: snapshot.humanConfirmedBy,
    lastReviewedAt: snapshot.lastReviewedAt,
    lastReviewedBy: snapshot.lastReviewedBy,
    sourcePackageId: snapshot.sourcePackageId,
  }
}

export function placeSnapshotData(
  value: unknown,
  schemaVersion: 1 | 2,
  scope: { tenantId: string; entityId: string; venueId: string },
) {
  const snapshot = schemaVersion === 2 ? parse(placeV2Schema, value) : parse(placeSchema, value)
  assertScope(snapshot, scope)
  const mutable = {
    name: snapshot.name,
    type: snapshot.type,
    itemType: snapshot.itemType,
    shortDescription: snapshot.shortDescription,
    longDescription: snapshot.longDescription,
    lat: snapshot.lat,
    lng: snapshot.lng,
    tags: snapshot.tags,
    importanceScore: snapshot.importanceScore,
    areaName: snapshot.areaName,
    hours: snapshot.hours,
    photoUrl: snapshot.photoUrl,
    isActive: snapshot.isActive,
    ...(schemaVersion === 2 ? provenance(snapshot as z.infer<typeof placeV2Schema>) : {}),
  }
  return {
    mutable,
    create: {
      id: snapshot.id,
      tenantId: snapshot.tenantId,
      venueId: snapshot.venueId,
      ...mutable,
    },
  }
}

export function knowledgeSnapshotData(
  value: unknown,
  schemaVersion: 1 | 2,
  scope: { tenantId: string; entityId: string; venueId: string },
) {
  const snapshot =
    schemaVersion === 2 ? parse(knowledgeV2Schema, value) : parse(knowledgeSchema, value)
  assertScope(snapshot, scope)
  const mutable = {
    title: snapshot.title,
    category: snapshot.category,
    content: snapshot.content,
    isEnabled: snapshot.isEnabled,
    ...(schemaVersion === 2 ? provenance(snapshot as z.infer<typeof knowledgeV2Schema>) : {}),
  }
  return {
    mutable,
    create: {
      id: snapshot.id,
      tenantId: snapshot.tenantId,
      venueId: snapshot.venueId,
      ...mutable,
    },
  }
}

export function operationalUpdateSnapshotData(
  value: unknown,
  scope: { tenantId: string; entityId: string },
) {
  const snapshot = parse(operationalUpdateSchema, value)
  assertScope(snapshot, scope)
  const mutable = {
    venueId: snapshot.venueId,
    placeId: snapshot.placeId,
    updateType: snapshot.updateType,
    severity: snapshot.severity,
    priority: snapshot.priority,
    title: snapshot.title,
    body: snapshot.body,
    redirectTo: snapshot.redirectTo,
    startsAt: snapshot.startsAt,
    expiresAt: snapshot.expiresAt,
    status: snapshot.status,
    isActive: snapshot.isActive,
    createdBy: snapshot.createdBy,
    publishedBy: snapshot.publishedBy,
    publishedAt: snapshot.publishedAt,
    createdAt: snapshot.createdAt,
  }
  return {
    snapshot,
    mutable,
    create: { id: snapshot.id, tenantId: snapshot.tenantId, ...mutable },
  }
}
