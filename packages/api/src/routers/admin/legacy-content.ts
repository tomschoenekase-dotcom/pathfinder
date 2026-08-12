import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  createLegacyKnowledgeAction,
  createLegacyPlaceAction,
  LegacyContentActionError,
  retireLegacyKnowledgeAction,
  retireLegacyPlaceAction,
  updateLegacyKnowledgeAction,
  updateLegacyPlaceAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const scope = z.object({ tenantId: z.string().min(1), venueId: z.string().min(1) }).strict()

const placeFields = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: z.string().trim().min(1).max(100),
    itemType: z.string().trim().min(1).max(100).nullable().optional(),
    shortDescription: z.string().trim().max(500).nullable().optional(),
    longDescription: z.string().trim().max(2_000).nullable().optional(),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(100)).max(100),
    importanceScore: z.number().int().min(0).max(100),
    areaName: z.string().trim().max(200).nullable().optional(),
    hours: z.string().trim().max(200).nullable().optional(),
    photoUrl: z.union([z.string().url().max(2_000), z.null()]).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

const knowledgeFields = z
  .object({
    title: z.string().trim().min(1).max(200),
    category: z.string().trim().min(1).max(100),
    content: z.string().trim().min(1).max(5_000),
    isEnabled: z.boolean(),
  })
  .strict()

const expectedRevision = {
  id: z.string().min(1),
  expectedUpdatedAt: z.coerce.date(),
}

function actor(userId: string) {
  return { type: 'HUMAN' as const, id: userId, role: 'PLATFORM_ADMIN' as const }
}

function actionError(error: unknown): never {
  if (!(error instanceof LegacyContentActionError)) throw error
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

export const adminLegacyContentRouter = router({
  listLegacyContent: adminProcedure.input(scope).query(async ({ ctx, input }) =>
    withTenantIsolationBypass(async () => {
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          tenant: { select: { id: true, name: true } },
        },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      const [places, knowledgeEntries] = await Promise.all([
        ctx.db.place.findMany({
          where: { tenantId: input.tenantId, venueId: input.venueId },
          orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            venueId: true,
            name: true,
            type: true,
            shortDescription: true,
            longDescription: true,
            tags: true,
            importanceScore: true,
            isActive: true,
            updatedAt: true,
          },
        }),
        ctx.db.venueKnowledgeEntry.findMany({
          where: { tenantId: input.tenantId, venueId: input.venueId },
          orderBy: [{ isEnabled: 'desc' }, { title: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            venueId: true,
            title: true,
            category: true,
            content: true,
            isEnabled: true,
            updatedAt: true,
          },
        }),
      ])
      return {
        scope: {
          tenant: venue.tenant,
          venue: { id: venue.id, name: venue.name, slug: venue.slug },
        },
        places,
        knowledgeEntries,
      }
    }),
  ),

  createLegacyPlace: adminProcedure
    .input(scope.extend({ fields: placeFields }))
    .mutation(async ({ ctx, input }) => {
      try {
        const fields = Object.fromEntries(
          Object.entries(input.fields).filter(([, value]) => value !== undefined),
        ) as Parameters<typeof createLegacyPlaceAction>[0]['fields']
        return await withTenantIsolationBypass(() =>
          createLegacyPlaceAction(
            {
              tenantId: input.tenantId,
              venueId: input.venueId,
              actor: actor(ctx.session.userId),
              fields,
            },
            ctx.db,
          ),
        )
      } catch (error) {
        actionError(error)
      }
    }),

  updateLegacyPlace: adminProcedure
    .input(scope.extend(expectedRevision).extend({ fields: placeFields.partial() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const fields = Object.fromEntries(
          Object.entries(input.fields).filter(([, value]) => value !== undefined),
        ) as Parameters<typeof updateLegacyPlaceAction>[0]['fields']
        return await withTenantIsolationBypass(() =>
          updateLegacyPlaceAction(
            {
              tenantId: input.tenantId,
              venueId: input.venueId,
              id: input.id,
              expectedUpdatedAt: input.expectedUpdatedAt,
              actor: actor(ctx.session.userId),
              fields,
            },
            ctx.db,
          ),
        )
      } catch (error) {
        actionError(error)
      }
    }),

  retireLegacyPlace: adminProcedure
    .input(scope.extend(expectedRevision).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        await withTenantIsolationBypass(() =>
          retireLegacyPlaceAction({ ...input, actor: actor(ctx.session.userId) }, ctx.db),
        )
        return { id: input.id }
      } catch (error) {
        actionError(error)
      }
    }),

  createLegacyKnowledge: adminProcedure
    .input(scope.extend({ fields: knowledgeFields }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          createLegacyKnowledgeAction(
            { ...input, actor: actor(ctx.session.userId), fields: input.fields },
            ctx.db,
          ),
        )
      } catch (error) {
        actionError(error)
      }
    }),

  updateLegacyKnowledge: adminProcedure
    .input(scope.extend(expectedRevision).extend({ fields: knowledgeFields.partial() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const fields = Object.fromEntries(
          Object.entries(input.fields).filter(([, value]) => value !== undefined),
        ) as Parameters<typeof updateLegacyKnowledgeAction>[0]['fields']
        return await withTenantIsolationBypass(() =>
          updateLegacyKnowledgeAction(
            {
              tenantId: input.tenantId,
              venueId: input.venueId,
              id: input.id,
              expectedUpdatedAt: input.expectedUpdatedAt,
              actor: actor(ctx.session.userId),
              fields,
            },
            ctx.db,
          ),
        )
      } catch (error) {
        actionError(error)
      }
    }),

  retireLegacyKnowledge: adminProcedure
    .input(scope.extend(expectedRevision).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        await withTenantIsolationBypass(() =>
          retireLegacyKnowledgeAction({ ...input, actor: actor(ctx.session.userId) }, ctx.db),
        )
        return { id: input.id }
      } catch (error) {
        actionError(error)
      }
    }),
})
