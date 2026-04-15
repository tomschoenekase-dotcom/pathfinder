import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db } from '@pathfinder/db'

import { CreatePlaceInput, PlaceInput, UpdatePlaceInput } from '../schemas/place'

import { router } from '../core'
import { embedPlace } from '../lib/embeddings'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

type Db = typeof db

const BULK_CREATE_LIMIT = 500

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

  create: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(CreatePlaceInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      await assertVenueBelongsToTenant(ctx.db, input.venueId, tenantId)

      const place = await ctx.db.place.create({
        data: {
          tenantId,
          venueId: input.venueId,
          name: input.name,
          type: input.type,
          lat: input.lat,
          lng: input.lng,
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
        },
        select: placeSelect,
      })

      await embedPlace(place)

      return place
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdatePlaceInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const existing = await ctx.db.place.findFirst({
        where: { id: input.id, tenantId },
        select: { id: true },
      })

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Place not found' })
      }

      const { id, ...raw } = input
      // Strip undefined — exactOptionalPropertyTypes requires no undefined values in Prisma data
      const data = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined))

      // updateMany accepts tenantId in where; update does not (Prisma unique-key constraint)
      await ctx.db.place.updateMany({ where: { id, tenantId }, data })

      const updated = await ctx.db.place.findFirst({
        where: { id, tenantId },
        select: placeSelect,
      })

      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Place not found' })
      }

      await embedPlace(updated)

      return updated
    }),

  delete: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const place = await ctx.db.place.findFirst({
        where: { id: input.id, tenantId },
        select: { id: true },
      })

      if (!place) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Place not found' })
      }

      await ctx.db.place.deleteMany({ where: { id: input.id, tenantId } })

      return { id: input.id }
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

      await assertVenueBelongsToTenant(ctx.db, input.venueId, tenantId)

      const created = await ctx.db.$transaction(
        input.places.map((p) =>
          ctx.db.place.create({
            data: {
              tenantId,
              venueId: input.venueId,
              name: p.name,
              type: p.type,
              lat: p.lat,
              lng: p.lng,
              tags: p.tags,
              importanceScore: p.importanceScore,
              ...(p.shortDescription !== undefined ? { shortDescription: p.shortDescription } : {}),
              ...(p.longDescription !== undefined ? { longDescription: p.longDescription } : {}),
              ...(p.areaName !== undefined ? { areaName: p.areaName } : {}),
              ...(p.hours !== undefined ? { hours: p.hours } : {}),
              ...(p.photoUrl !== undefined ? { photoUrl: p.photoUrl } : {}),
            },
            select: placeSelect,
          }),
        ),
      )

      // Embed all created places concurrently — failures are swallowed inside embedPlace
      await Promise.all(created.map(embedPlace))

      return { count: created.length, places: created }
    }),
})
