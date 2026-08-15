import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  bulkCreateLegacyPlacesAction,
  createLegacyPlaceAction,
  db,
  LegacyContentActionError,
  retireLegacyPlaceAction,
  updateLegacyPlaceAction,
  type LegacyContentActor,
} from '@pathfinder/db'

import { CreatePlaceInput, PlaceInput, RetirePlaceInput, UpdatePlaceInput } from '../schemas/place'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

type Db = typeof db

const BULK_CREATE_LIMIT = 500

function actionActor(session: { userId: string | null; role: string | null }): LegacyContentActor {
  return {
    type: 'HUMAN',
    id: session.userId!,
    role: session.role === 'OWNER' ? 'OWNER' : 'MANAGER',
  }
}

function mapActionError(error: unknown): never {
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

// ---------------------------------------------------------------------------
// Input schemas — defined in ../schemas/place (client-safe, re-exported here)
// ---------------------------------------------------------------------------

export { PlaceInput, CreatePlaceInput, UpdatePlaceInput } from '../schemas/place'

// ---------------------------------------------------------------------------
// Select shape
// ---------------------------------------------------------------------------

const placeSelect = {
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
  visibility: true,
  createdAt: true,
  updatedAt: true,
} as const

// ---------------------------------------------------------------------------
// Helper — verify venueId belongs to tenant
// ---------------------------------------------------------------------------

async function assertVenueBelongsToTenant(
  db: Db,
  venueId: string,
  tenantId: string,
): Promise<void> {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true },
  })

  if (!venue) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const placeRouter = router({
  list: tenantProcedure
    .input(z.object({ venueId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      await assertVenueBelongsToTenant(ctx.db, input.venueId, tenantId)

      return ctx.db.place.findMany({
        where: { tenantId, venueId: input.venueId },
        select: placeSelect,
        orderBy: [{ importanceScore: 'desc' }, { name: 'asc' }],
      })
    }),

  getById: tenantProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const place = await ctx.db.place.findFirst({
        where: { id: input.id, tenantId: ctx.session.activeTenantId },
        select: placeSelect,
      })

      if (!place) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Place not found' })
      }

      return place
    }),

  setVisibility: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          id: z.string().cuid(),
          venueId: z.string().cuid(),
          visibility: z.enum(['PUBLIC', 'SECOND_LAYER']),
          expectedUpdatedAt: z.coerce.date(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true, secondLayerEnabled: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      if (input.visibility === 'SECOND_LAYER' && !venue.secondLayerEnabled) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'The premium second layer is disabled.' })
      }
      try {
        return await updateLegacyPlaceAction(
          {
            tenantId,
            venueId: input.venueId,
            id: input.id,
            expectedUpdatedAt: input.expectedUpdatedAt,
            actor: actionActor(ctx.session),
            fields: { visibility: input.visibility },
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
    }),

  create: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(CreatePlaceInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      if (input.visibility === 'SECOND_LAYER') {
        const venue = await ctx.db.venue.findFirst({
          where: { id: input.venueId, tenantId },
          select: { id: true, secondLayerEnabled: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        if (!venue.secondLayerEnabled) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'The employee experience is disabled.',
          })
        }
      }

      try {
        return await createLegacyPlaceAction(
          {
            tenantId,
            venueId: input.venueId,
            actor: actionActor(ctx.session),
            fields: {
              name: input.name,
              type: input.type,
              ...(input.itemType !== undefined ? { itemType: input.itemType } : {}),
              ...(input.lat !== undefined ? { lat: input.lat } : {}),
              ...(input.lng !== undefined ? { lng: input.lng } : {}),
              tags: input.tags,
              importanceScore: input.importanceScore,
              ...(input.shortDescription !== undefined
                ? { shortDescription: input.shortDescription }
                : {}),
              ...(input.longDescription !== undefined
                ? { longDescription: input.longDescription }
                : {}),
              ...(input.areaName !== undefined ? { areaName: input.areaName } : {}),
              ...(input.hours !== undefined ? { hours: input.hours } : {}),
              ...(input.photoUrl !== undefined ? { photoUrl: input.photoUrl } : {}),
              visibility: input.visibility,
            },
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdatePlaceInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const { id, venueId, expectedUpdatedAt, ...raw } = input
      // Strip undefined — exactOptionalPropertyTypes requires no undefined values in Prisma data
      const data = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined))

      if (input.visibility === 'SECOND_LAYER') {
        const venue = await ctx.db.venue.findFirst({
          where: { id: venueId, tenantId },
          select: { id: true, secondLayerEnabled: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        if (!venue.secondLayerEnabled) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'The employee experience is disabled.',
          })
        }
      }

      // updateMany accepts tenantId in where; update does not (Prisma unique-key constraint)
      try {
        return await updateLegacyPlaceAction(
          {
            tenantId,
            venueId,
            id,
            expectedUpdatedAt,
            actor: actionActor(ctx.session),
            fields: data,
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
    }),

  delete: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(RetirePlaceInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      try {
        await retireLegacyPlaceAction(
          { ...input, tenantId, actor: actionActor(ctx.session) },
          ctx.db,
        )
        return { id: input.id }
      } catch (error) {
        mapActionError(error)
      }
    }),

  bulkCreate: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          venueId: z.string().cuid(),
          places: z.array(PlaceInput),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      if (input.places.length > BULK_CREATE_LIMIT) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Bulk create limit is ${BULK_CREATE_LIMIT} places`,
        })
      }

      try {
        const created = await bulkCreateLegacyPlacesAction(
          {
            tenantId,
            venueId: input.venueId,
            actor: actionActor(ctx.session),
            places: input.places.map((p) => ({
              name: p.name,
              type: p.type,
              ...(p.itemType !== undefined ? { itemType: p.itemType } : {}),
              ...(p.lat !== undefined ? { lat: p.lat } : {}),
              ...(p.lng !== undefined ? { lng: p.lng } : {}),
              tags: p.tags,
              importanceScore: p.importanceScore,
              ...(p.shortDescription !== undefined ? { shortDescription: p.shortDescription } : {}),
              ...(p.longDescription !== undefined ? { longDescription: p.longDescription } : {}),
              ...(p.areaName !== undefined ? { areaName: p.areaName } : {}),
              ...(p.hours !== undefined ? { hours: p.hours } : {}),
              ...(p.photoUrl !== undefined ? { photoUrl: p.photoUrl } : {}),
              visibility: 'PUBLIC',
            })),
          },
          ctx.db,
        )
        return { count: created.length, places: created }
      } catch (error) {
        mapActionError(error)
      }
    }),
})
