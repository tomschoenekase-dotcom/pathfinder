import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db } from '@pathfinder/db'

import { CreateVenueInput, UpdateVenueInput } from '../schemas/venue'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { publicProcedure, tenantProcedure } from '../trpc'

type Db = typeof db

// ---------------------------------------------------------------------------
// Slug utility
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

async function uniqueSlug(
  db: Db,
  tenantId: string,
  base: string,
  excludeId?: string,
): Promise<string> {
  let candidate = base
  let suffix = 2

  while (true) {
    const existing = await db.venue.findFirst({
      where: {
        tenantId,
        slug: candidate,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    })

    if (!existing) return candidate

    candidate = `${base}-${suffix}`
    suffix++
  }
}

// ---------------------------------------------------------------------------
// Input schemas — defined in ../schemas/venue (client-safe, re-exported here)
// ---------------------------------------------------------------------------

export { CreateVenueInput, UpdateVenueInput } from '../schemas/venue'

// ---------------------------------------------------------------------------
// Select shapes
// ---------------------------------------------------------------------------

const venueListSelect = {
  id: true,
  tenantId: true,
  name: true,
  slug: true,
  description: true,
  guideNotes: true,
  category: true,
  defaultCenterLat: true,
  defaultCenterLng: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  // geoBoundary intentionally excluded from list views
} as const

const venueDetailSelect = {
  ...venueListSelect,
  _count: { select: { places: true } },
} as const

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const venueRouter = router({
  getBySlug: publicProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      // $queryRaw used here because this is a public cross-tenant lookup — the caller
      // only knows the slug, not the tenantId. No tenant_id bind needed in the
      // WHERE because we are resolving the venue for display, not filtering by tenant.
      const [venue] = await ctx.db.$queryRaw<{
        id: string
        name: string
        description: string | null
        category: string | null
        defaultCenterLat: number | null
        defaultCenterLng: number | null
      }[]>`
        SELECT id, name, description, category,
               default_center_lat AS "defaultCenterLat",
               default_center_lng AS "defaultCenterLng"
        FROM venues WHERE slug = ${input.slug} AND is_active = true LIMIT 1
      `

      if (!venue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      return venue
    }),

  list: tenantProcedure.query(async ({ ctx }) => {
    return ctx.db.venue.findMany({
      where: { tenantId: ctx.session.activeTenantId },
      select: venueListSelect,
      orderBy: { createdAt: 'asc' },
    })
  }),

  getById: tenantProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.id, tenantId: ctx.session.activeTenantId },
        select: venueDetailSelect,
      })

      if (!venue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      return venue
    }),

  create: tenantProcedure
    .use(requireRole('OWNER'))
    .input(CreateVenueInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const baseSlug = input.slug ? slugify(input.slug) : slugify(input.name)
      const slug = await uniqueSlug(ctx.db, tenantId, baseSlug)

      try {
        return await ctx.db.venue.create({
          data: {
            tenantId,
            name: input.name,
            slug,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.category !== undefined ? { category: input.category } : {}),
            ...(input.defaultCenterLat !== undefined
              ? { defaultCenterLat: input.defaultCenterLat }
              : {}),
            ...(input.defaultCenterLng !== undefined
              ? { defaultCenterLng: input.defaultCenterLng }
              : {}),
          },
          select: venueListSelect,
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.includes('venues_tenant_id_slug_key')) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'A venue with this slug already exists',
          })
        }
        throw err
      }
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateVenueInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const existing = await ctx.db.venue.findFirst({
        where: { id: input.id, tenantId },
        select: { id: true },
      })

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      const { id, ...raw } = input
      // Strip undefined — exactOptionalPropertyTypes requires no undefined values in Prisma data
      const data = Object.fromEntries(
        Object.entries(raw).filter(([, v]) => v !== undefined),
      )

      // updateMany accepts tenantId in where; update does not (Prisma unique-key constraint)
      await ctx.db.venue.updateMany({ where: { id, tenantId }, data })

      const updated = await ctx.db.venue.findFirst({
        where: { id, tenantId },
        select: venueListSelect,
      })

      return updated!
    }),

  delete: tenantProcedure
    .use(requireRole('OWNER'))
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const venue = await ctx.db.venue.findFirst({
        where: { id: input.id, tenantId },
        select: { id: true, _count: { select: { places: true } } },
      })

      if (!venue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      if (venue._count.places > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Remove all POIs before deleting a venue',
        })
      }

      // deleteMany accepts tenantId in where; delete does not (Prisma unique-key constraint)
      await ctx.db.venue.deleteMany({ where: { id: input.id, tenantId } })

      return { id: input.id }
    }),
})
