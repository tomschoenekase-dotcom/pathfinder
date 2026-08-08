import * as prismaClient from '@prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { lockContentVersionEntity, setContentVersionContext } from '@pathfinder/db'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

const EntityType = z.enum(['VENUE', 'PLACE', 'KNOWLEDGE_ENTRY'])

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

function placeData(snapshot: z.infer<typeof placeSnapshotSchema>) {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    ...placeMutableData(snapshot),
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

function knowledgeData(snapshot: z.infer<typeof knowledgeSnapshotSchema>) {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    venueId: snapshot.venueId,
    ...knowledgeMutableData(snapshot),
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
          if (target.snapshotSchemaVersion !== 1) invalidSnapshot()
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
              const snapshot = parseSnapshot(placeSnapshotSchema, targetState)
              if (
                snapshot.tenantId !== tenantId ||
                snapshot.id !== target.entityId ||
                snapshot.venueId !== target.venueId
              )
                invalidSnapshot()
              const data = placeData(snapshot)
              if (current) {
                const updated = await tx.place.updateMany({
                  where: { id: target.entityId, tenantId },
                  data: placeMutableData(snapshot),
                })
                if (updated.count !== 1)
                  throw new TRPCError({ code: 'CONFLICT', message: 'Place changed during revert' })
              } else {
                await tx.place.create({ data })
              }
            }
          } else {
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
              const snapshot = parseSnapshot(knowledgeSnapshotSchema, targetState)
              if (
                snapshot.tenantId !== tenantId ||
                snapshot.id !== target.entityId ||
                snapshot.venueId !== target.venueId
              )
                invalidSnapshot()
              const data = knowledgeData(snapshot)
              if (current) {
                const updated = await tx.venueKnowledgeEntry.updateMany({
                  where: { id: target.entityId, tenantId },
                  data: knowledgeMutableData(snapshot),
                })
                if (updated.count !== 1)
                  throw new TRPCError({
                    code: 'CONFLICT',
                    message: 'Knowledge entry changed during revert',
                  })
              } else {
                await tx.venueKnowledgeEntry.create({ data })
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
