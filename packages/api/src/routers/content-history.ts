import * as prismaClient from '@prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  lockContentVersionEntity,
  lockOperationalUpdateCapacity,
  lockVenueContentMutation,
  setContentVersionContext,
} from '@pathfinder/db'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { MAX_GUEST_OPERATIONAL_UPDATES } from '../schemas/operational-update'
import { tenantProcedure } from '../trpc'

const EntityType = z.enum(['VENUE', 'PLACE', 'KNOWLEDGE_ENTRY', 'OPERATIONAL_UPDATE'])

const versionSelect = {
  id: true,
  sequence: true,
  tenantId: true,
  venueId: true,
  entityType: true,
  entityId: true,
  operation: true,
  beforeState: true,
  afterState: true,
  actorId: true,
  revertedFromId: true,
  snapshotSchemaVersion: true,
  createdAt: true,
} as const

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
const venueSnapshotSchema = z
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

const placeSnapshotSchema = z
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

const directProvenanceSnapshotSchema = z.object({
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

const placeSnapshotV2Schema = placeSnapshotSchema
  .extend(directProvenanceSnapshotSchema.shape)
  .strict()

const knowledgeSnapshotSchema = z
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

const knowledgeSnapshotV2Schema = knowledgeSnapshotSchema
  .extend(directProvenanceSnapshotSchema.shape)
  .strict()

const operationalUpdateSnapshotSchema = z
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

function invalidSnapshot(): never {
  throw new TRPCError({
    code: 'CONFLICT',
    message: 'The selected historical snapshot is incompatible with current content',
  })
}

function parseSnapshot<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) invalidSnapshot()
  return parsed.data
}

function venueMutableData(snapshot: z.infer<typeof venueSnapshotSchema>) {
  return {
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
}

function venueData(snapshot: z.infer<typeof venueSnapshotSchema>) {
  return { id: snapshot.id, tenantId: snapshot.tenantId, ...venueMutableData(snapshot) }
}

function placeMutableData(snapshot: z.infer<typeof placeSnapshotSchema>) {
  return {
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
  }
}

function provenanceMutableData(snapshot: z.infer<typeof directProvenanceSnapshotSchema>) {
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

function placeMutableDataV2(snapshot: z.infer<typeof placeSnapshotV2Schema>) {
  return { ...placeMutableData(snapshot), ...provenanceMutableData(snapshot) }
}

function placeData(snapshot: z.infer<typeof placeSnapshotSchema>) {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    ...placeMutableData(snapshot),
  }
}

function placeDataV2(snapshot: z.infer<typeof placeSnapshotV2Schema>) {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    ...placeMutableDataV2(snapshot),
  }
}

function knowledgeMutableData(snapshot: z.infer<typeof knowledgeSnapshotSchema>) {
  return {
    title: snapshot.title,
    category: snapshot.category,
    content: snapshot.content,
    isEnabled: snapshot.isEnabled,
  }
}

function knowledgeMutableDataV2(snapshot: z.infer<typeof knowledgeSnapshotV2Schema>) {
  return { ...knowledgeMutableData(snapshot), ...provenanceMutableData(snapshot) }
}

function knowledgeData(snapshot: z.infer<typeof knowledgeSnapshotSchema>) {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    ...knowledgeMutableData(snapshot),
  }
}

function knowledgeDataV2(snapshot: z.infer<typeof knowledgeSnapshotV2Schema>) {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    ...knowledgeMutableDataV2(snapshot),
  }
}

function operationalUpdateMutableData(snapshot: z.infer<typeof operationalUpdateSnapshotSchema>) {
  return {
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
}

function operationalUpdateData(snapshot: z.infer<typeof operationalUpdateSnapshotSchema>) {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    ...operationalUpdateMutableData(snapshot),
  }
}

function mapRevertError(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'P2002') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'That historical state conflicts with current content',
        cause: error,
      })
    }
    if (error.code === 'P2003') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Dependent records prevent restoring that historical deletion',
        cause: error,
      })
    }
  }
  throw error
}

export const contentHistoryRouter = router({
  list: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          entityType: EntityType,
          entityId: z.string().min(1),
          limit: z.number().int().min(1).max(100).default(50),
          beforeSequence: z.bigint().positive().optional(),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      ctx.db.contentVersion.findMany({
        where: {
          tenantId: ctx.session.activeTenantId,
          entityType: input.entityType,
          entityId: input.entityId,
          ...(input.beforeSequence !== undefined ? { sequence: { lt: input.beforeSequence } } : {}),
        },
        select: versionSelect,
        orderBy: { sequence: 'desc' },
        take: input.limit,
      }),
    ),

  listForVenue: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          venueId: z.string().min(1),
          limit: z.number().int().min(1).max(100).default(50),
          beforeSequence: z.bigint().positive().optional(),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      ctx.db.contentVersion.findMany({
        where: {
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          ...(input.beforeSequence !== undefined ? { sequence: { lt: input.beforeSequence } } : {}),
        },
        select: versionSelect,
        orderBy: { sequence: 'desc' },
        take: input.limit,
      }),
    ),

  listDeletedVenues: tenantProcedure
    .use(requireRole('OWNER'))
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(50),
          beforeSequence: z.bigint().positive().optional(),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      ctx.db.contentVersion.findMany({
        where: {
          tenantId: ctx.session.activeTenantId,
          entityType: 'VENUE',
          ...(input.beforeSequence !== undefined ? { sequence: { lt: input.beforeSequence } } : {}),
        },
        select: versionSelect,
        orderBy: { sequence: 'desc' },
        take: input.limit,
      }),
    ),

  revert: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          versionId: z.string().uuid(),
          expectedCurrentVersionId: z.string().uuid(),
          snapshotSide: z.enum(['BEFORE', 'AFTER']).default('AFTER'),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      try {
        return await ctx.db.$transaction(async (tx) => {
          const target = await tx.contentVersion.findFirst({
            where: { id: input.versionId, tenantId },
            select: versionSelect,
          })
          if (!target) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Content version not found' })
          }

          if (target.entityType !== 'OPERATIONAL_UPDATE') {
            await lockVenueContentMutation(tx, { tenantId, venueId: target.venueId })
          }

          await lockContentVersionEntity(tx, {
            tenantId,
            entityType: EntityType.parse(target.entityType),
            entityId: target.entityId,
          })

          const latest = await tx.contentVersion.findFirst({
            where: {
              tenantId,
              entityType: target.entityType,
              entityId: target.entityId,
            },
            select: { id: true },
            orderBy: { sequence: 'desc' },
          })
          if (!latest || latest.id !== input.expectedCurrentVersionId) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Content changed after this history view was loaded; refresh and try again',
            })
          }

          await setContentVersionContext(tx, {
            actorId: ctx.session.userId,
            revertedFromId: target.id,
          })
          const isDirectProvenanceSnapshot =
            target.snapshotSchemaVersion === 2 &&
            (target.entityType === 'PLACE' || target.entityType === 'KNOWLEDGE_ENTRY')
          if (target.snapshotSchemaVersion !== 1 && !isDirectProvenanceSnapshot) invalidSnapshot()
          const targetState =
            input.snapshotSide === 'BEFORE' ? target.beforeState : target.afterState

          if (target.entityType === 'VENUE') {
            const current = await tx.venue.findFirst({
              where: { id: target.entityId, tenantId },
              select: { id: true },
            })
            if ((current === null || targetState === null) && ctx.session.role !== 'OWNER') {
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: 'Only an owner can restore or remove a venue',
              })
            }
            if (targetState === null) {
              if (!current)
                throw new TRPCError({ code: 'BAD_REQUEST', message: 'Venue is already deleted' })
              const removed = await tx.venue.deleteMany({
                where: { id: target.entityId, tenantId },
              })
              if (removed.count !== 1)
                throw new TRPCError({ code: 'CONFLICT', message: 'Venue changed during revert' })
            } else {
              const snapshot = parseSnapshot(venueSnapshotSchema, targetState)
              if (
                snapshot.tenantId !== tenantId ||
                snapshot.id !== target.entityId ||
                snapshot.venueId !== target.entityId
              )
                invalidSnapshot()
              const data = venueData(snapshot)
              if (current) {
                const updated = await tx.venue.updateMany({
                  where: { id: target.entityId, tenantId },
                  data: venueMutableData(snapshot),
                })
                if (updated.count !== 1)
                  throw new TRPCError({ code: 'CONFLICT', message: 'Venue changed during revert' })
              } else {
                await tx.venue.create({ data })
              }
            }
          } else if (target.entityType === 'PLACE') {
            const current = await tx.place.findFirst({
              where: { id: target.entityId, tenantId },
              select: { id: true, venueId: true },
            })
            if (current && current.venueId !== target.venueId) invalidSnapshot()
            if (targetState === null) {
              if (!current)
                throw new TRPCError({ code: 'BAD_REQUEST', message: 'Place is already deleted' })
              const removed = await tx.place.deleteMany({
                where: { id: target.entityId, tenantId },
              })
              if (removed.count !== 1)
                throw new TRPCError({ code: 'CONFLICT', message: 'Place changed during revert' })
            } else {
              const parentVenue = await tx.venue.findFirst({
                where: { id: target.venueId, tenantId },
                select: { id: true },
              })
              if (!parentVenue) invalidSnapshot()
              const snapshot = isDirectProvenanceSnapshot
                ? parseSnapshot(placeSnapshotV2Schema, targetState)
                : parseSnapshot(placeSnapshotSchema, targetState)
              if (
                snapshot.tenantId !== tenantId ||
                snapshot.id !== target.entityId ||
                snapshot.venueId !== target.venueId
              )
                invalidSnapshot()
              if (current) {
                const updated = await tx.place.updateMany({
                  where: { id: target.entityId, tenantId },
                  data: isDirectProvenanceSnapshot
                    ? placeMutableDataV2(snapshot as z.infer<typeof placeSnapshotV2Schema>)
                    : placeMutableData(snapshot),
                })
                if (updated.count !== 1)
                  throw new TRPCError({ code: 'CONFLICT', message: 'Place changed during revert' })
              } else {
                await tx.place.create({
                  data: isDirectProvenanceSnapshot
                    ? placeDataV2(snapshot as z.infer<typeof placeSnapshotV2Schema>)
                    : placeData(snapshot),
                })
              }
            }
          } else if (target.entityType === 'KNOWLEDGE_ENTRY') {
            const current = await tx.venueKnowledgeEntry.findFirst({
              where: { id: target.entityId, tenantId },
              select: { id: true, venueId: true },
            })
            if (current && current.venueId !== target.venueId) invalidSnapshot()
            if (targetState === null) {
              if (!current)
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message: 'Knowledge entry is already deleted',
                })
              const removed = await tx.venueKnowledgeEntry.deleteMany({
                where: { id: target.entityId, tenantId },
              })
              if (removed.count !== 1)
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'Knowledge entry changed during revert',
                })
            } else {
              const parentVenue = await tx.venue.findFirst({
                where: { id: target.venueId, tenantId },
                select: { id: true },
              })
              if (!parentVenue) invalidSnapshot()
              const snapshot = isDirectProvenanceSnapshot
                ? parseSnapshot(knowledgeSnapshotV2Schema, targetState)
                : parseSnapshot(knowledgeSnapshotSchema, targetState)
              if (
                snapshot.tenantId !== tenantId ||
                snapshot.id !== target.entityId ||
                snapshot.venueId !== target.venueId
              )
                invalidSnapshot()
              if (current) {
                const updated = await tx.venueKnowledgeEntry.updateMany({
                  where: { id: target.entityId, tenantId },
                  data: isDirectProvenanceSnapshot
                    ? knowledgeMutableDataV2(snapshot as z.infer<typeof knowledgeSnapshotV2Schema>)
                    : knowledgeMutableData(snapshot),
                })
                if (updated.count !== 1)
                  throw new TRPCError({
                    code: 'CONFLICT',
                    message: 'Knowledge entry changed during revert',
                  })
              } else {
                await tx.venueKnowledgeEntry.create({
                  data: isDirectProvenanceSnapshot
                    ? knowledgeDataV2(snapshot as z.infer<typeof knowledgeSnapshotV2Schema>)
                    : knowledgeData(snapshot),
                })
              }
            }
          } else {
            const current = await tx.operationalUpdate.findFirst({
              where: { id: target.entityId, tenantId },
              select: { id: true },
            })
            if (targetState === null) {
              if (!current)
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message: 'Operational update is already deleted',
                })
              const removed = await tx.operationalUpdate.deleteMany({
                where: { id: target.entityId, tenantId },
              })
              if (removed.count !== 1)
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'Operational update changed during revert',
                })
            } else {
              const snapshot = parseSnapshot(operationalUpdateSnapshotSchema, targetState)
              if (snapshot.tenantId !== tenantId || snapshot.id !== target.entityId) {
                invalidSnapshot()
              }
              const parentVenue = await tx.venue.findFirst({
                where: { id: snapshot.venueId, tenantId },
                select: { id: true },
              })
              if (!parentVenue) invalidSnapshot()
              if (snapshot.placeId !== null) {
                const parentPlace = await tx.place.findFirst({
                  where: {
                    id: snapshot.placeId,
                    tenantId,
                    venueId: snapshot.venueId,
                  },
                  select: { id: true },
                })
                if (!parentPlace) invalidSnapshot()
              }
              if (snapshot.status === 'PUBLISHED' && snapshot.isActive) {
                await lockOperationalUpdateCapacity(tx, {
                  tenantId,
                  venueId: snapshot.venueId,
                })
                const overlapping = await tx.operationalUpdate.count({
                  where: {
                    tenantId,
                    venueId: snapshot.venueId,
                    status: 'PUBLISHED',
                    isActive: true,
                    startsAt: { lt: snapshot.expiresAt },
                    expiresAt: { gt: snapshot.startsAt },
                    id: { not: target.entityId },
                  },
                })
                if (overlapping >= MAX_GUEST_OPERATIONAL_UPDATES) {
                  throw new TRPCError({
                    code: 'CONFLICT',
                    message: `A venue can have at most ${MAX_GUEST_OPERATIONAL_UPDATES} overlapping published updates`,
                  })
                }
              }
              if (current) {
                const updated = await tx.operationalUpdate.updateMany({
                  where: { id: target.entityId, tenantId },
                  data: operationalUpdateMutableData(snapshot),
                })
                if (updated.count !== 1)
                  throw new TRPCError({
                    code: 'CONFLICT',
                    message: 'Operational update changed during revert',
                  })
              } else {
                await tx.operationalUpdate.create({ data: operationalUpdateData(snapshot) })
              }
            }
          }

          const appliedVersion = await tx.contentVersion.findFirst({
            where: {
              tenantId,
              entityType: target.entityType,
              entityId: target.entityId,
            },
            select: versionSelect,
            orderBy: { sequence: 'desc' },
          })
          if (!appliedVersion || appliedVersion.id === latest.id) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'The selected version already matches current content',
            })
          }
          return appliedVersion
        })
      } catch (error) {
        mapRevertError(error)
      }
    }),
})
