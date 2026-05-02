import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db } from '@pathfinder/db'
import { emitEvent } from '@pathfinder/analytics'

import { CreateVenueInput, UpdateVenueInput } from '../schemas/venue'

import { router } from '../core'
import { embedPlace } from '../lib/embeddings'
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
  guideMode: true,
  defaultCenterLat: true,
  defaultCenterLng: true,
  aiGuideName: true,
  chatTheme: true,
  chatAccentColor: true,
  chatLogoUrl: true,
  chatBannerUrl: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { places: true } },
  // geoBoundary intentionally excluded from list views
} as const

const venueDetailSelect = {
  ...venueListSelect,
  _count: { select: { places: true } },
} as const

const venueAiConfigSelect = {
  aiGuideNotes: true,
  aiFeaturedPlaceId: true,
  aiTone: true,
  aiGuideName: true,
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
      const [venue] = await ctx.db.$queryRaw<
        {
          id: string
          name: string
          description: string | null
          category: string | null
          guideMode: string
          defaultCenterLat: number | null
          defaultCenterLng: number | null
          aiGuideName: string | null
          chatTheme: string | null
          chatAccentColor: string | null
          chatLogoUrl: string | null
          chatBannerUrl: string | null
        }[]
      >`
        SELECT id, name, description, category,
               guide_mode            AS "guideMode",
               default_center_lat    AS "defaultCenterLat",
               default_center_lng    AS "defaultCenterLng",
               ai_guide_name         AS "aiGuideName",
               chat_theme            AS "chatTheme",
               chat_accent_color     AS "chatAccentColor",
               chat_logo_url         AS "chatLogoUrl",
               chat_banner_url       AS "chatBannerUrl"
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

  getAiConfig: tenantProcedure
    .input(
      z
        .object({
          venueId: z.string().cuid(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId: ctx.session.activeTenantId },
        select: venueAiConfigSelect,
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
            guideMode: input.guideMode ?? 'location_aware',
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
      const data = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined))

      // updateMany accepts tenantId in where; update does not (Prisma unique-key constraint)
      await ctx.db.venue.updateMany({ where: { id, tenantId }, data })

      const updated = await ctx.db.venue.findFirst({
        where: { id, tenantId },
        select: venueListSelect,
      })

      return updated!
    }),

  updateAiConfig: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          venueId: z.string().cuid(),
          aiGuideNotes: z.string().max(2000).nullable().optional(),
          aiFeaturedPlaceId: z.string().cuid().nullable().optional(),
          aiTone: z.enum(['FRIENDLY', 'PROFESSIONAL', 'PLAYFUL']).optional(),
          aiGuideName: z.string().max(80).nullable().optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true, tenantId: true },
      })

      if (!venue || venue.tenantId !== tenantId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      if (input.aiFeaturedPlaceId) {
        const place = await ctx.db.place.findFirst({
          where: {
            id: input.aiFeaturedPlaceId,
            venueId: input.venueId,
            tenantId,
          },
          select: { id: true },
        })

        if (!place) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Place not found' })
        }
      }

      const { venueId: _venueId, ...raw } = input
      const data = Object.fromEntries(
        Object.entries(raw).filter(([, value]) => value !== undefined),
      )

      await ctx.db.venue.updateMany({
        where: { id: input.venueId, tenantId },
        data,
      })

      const updated = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: venueAiConfigSelect,
      })

      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      // Re-embed any places that didn't get embeddings at creation time (e.g. OpenAI was
      // unavailable). Failures are swallowed inside embedPlace — they won't block the save.
      const unembedded = await ctx.db.$queryRaw<
        {
          id: string
          name: string
          type: string
          short_description: string | null
          long_description: string | null
          tags: string[]
          area_name: string | null
          hours: string | null
        }[]
      >`
        SELECT id, name, type, short_description, long_description, tags, area_name, hours
        FROM places
        WHERE venue_id  = ${input.venueId}
          AND tenant_id = ${tenantId}
          AND is_active = true
          AND embedding IS NULL
      `

      if (unembedded.length > 0) {
        await Promise.all(
          unembedded.map((r) =>
            embedPlace({
              id: r.id,
              name: r.name,
              type: r.type,
              shortDescription: r.short_description,
              longDescription: r.long_description,
              tags: r.tags ?? [],
              areaName: r.area_name,
              hours: r.hours,
            }),
          ),
        )
      }

      try {
        await emitEvent({
          tenantId,
          venueId: input.venueId,
          sessionId: '',
          eventType: 'venue.updated',
        })
      } catch {}

      return updated
    }),

  updateChatDesign: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          venueId: z.string().cuid(),
          chatTheme: z.enum(['default', 'forest', 'sunset', 'midnight', 'rose']).optional(),
          chatAccentColor: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex colour e.g. #3A7BD5')
            .nullable()
            .optional(),
          chatLogoUrl: z.string().url().max(500).nullable().optional(),
          chatBannerUrl: z.string().url().max(500).nullable().optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true },
      })

      if (!venue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      const { venueId: _venueId, ...raw } = input
      const data = Object.fromEntries(
        Object.entries(raw).filter(([, value]) => value !== undefined),
      )

      await ctx.db.venue.updateMany({
        where: { id: input.venueId, tenantId },
        data,
      })

      const updated = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: {
          chatTheme: true,
          chatAccentColor: true,
          chatLogoUrl: true,
          chatBannerUrl: true,
        },
      })

      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      try {
        await emitEvent({
          tenantId,
          venueId: input.venueId,
          sessionId: '',
          eventType: 'venue.updated',
        })
      } catch {}

      return updated
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
