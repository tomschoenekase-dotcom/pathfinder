import { createHash } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, lockVenueContentMutation, setContentVersionContext } from '@pathfinder/db'
import { enqueueEmbedKnowledgeEntry, enqueueEmbedPlace } from '@pathfinder/jobs'
import { emitEvent } from '@pathfinder/analytics'
import { logger } from '@pathfinder/config/logger'

import {
  CreateVenueRequestInput,
  normalizeInitialVenueContent,
  UpdateVenueRequestInput,
} from '../schemas/venue'
import {
  canonicalVenueContentImportPayload,
  ImportVenueContentInput,
} from '../schemas/venue-content'

import { router } from '../core'
import { checkRateLimit } from '../lib/rate-limit'
import { requireRole } from '../middleware/require-role'
import { withContentVersionActor } from '../middleware/content-version-actor'
import { publicProcedure, tenantProcedure } from '../trpc'

type Db = typeof db

const PUBLIC_VENUE_LOOKUP_GLOBAL_LIMIT_PER_MINUTE = 10_000

type VenueContentImportReceiptResult = {
  payloadHash: string
  placeCount: number
  knowledgeEntryCount: number
}

function publicVenueUnavailable(): TRPCError {
  return new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: 'This venue guide is temporarily unavailable.',
  })
}

function venueContentImportPayloadHash(input: ImportVenueContentInput): string {
  return createHash('sha256').update(canonicalVenueContentImportPayload(input)).digest('hex')
}

function replayVenueContentImport(
  receipt: VenueContentImportReceiptResult,
  payloadHash: string,
): { placeCount: number; knowledgeEntryCount: number; replayed: true } {
  if (receipt.payloadHash !== payloadHash) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This import attempt key was already used for different content.',
    })
  }

  return {
    placeCount: receipt.placeCount,
    knowledgeEntryCount: receipt.knowledgeEntryCount,
    replayed: true,
  }
}

async function embedPlace(place: { id: string; tenantId: string; updatedAt: Date }): Promise<void> {
  try {
    await enqueueEmbedPlace({
      placeId: place.id,
      tenantId: place.tenantId,
      contentUpdatedAt: place.updatedAt.toISOString(),
    })
  } catch (err) {
    logger.warn({
      action: 'place.embed.enqueue.failed',
      tenantId: place.tenantId,
      placeId: place.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function embedKnowledgeEntry(entry: {
  id: string
  tenantId: string
  updatedAt: Date
}): Promise<void> {
  try {
    await enqueueEmbedKnowledgeEntry({
      entryId: entry.id,
      tenantId: entry.tenantId,
      contentUpdatedAt: entry.updatedAt.toISOString(),
    })
  } catch (err) {
    logger.warn({
      action: 'knowledge.embed.enqueue.failed',
      tenantId: entry.tenantId,
      entryId: entry.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Slug utility
// ---------------------------------------------------------------------------

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

export async function uniqueSlug(
  db: Pick<Db, 'venue'>,
  tenantId: string,
  base: string,
  excludeId?: string,
): Promise<string> {
  let candidate = base
  let suffix = 2

  for (;;) {
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
  chatFont: true,
  chatLogoUrl: true,
  chatBannerUrl: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { places: true } },
  // geoBoundary intentionally excluded from list views
} as const

const venueCreateSelect = {
  ...venueListSelect,
  places: {
    select: {
      id: true,
      tenantId: true,
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
      updatedAt: true,
    },
    orderBy: { createdAt: 'asc' as const },
    take: 2,
  },
  knowledgeEntries: {
    select: {
      id: true,
      tenantId: true,
      title: true,
      category: true,
      content: true,
      isEnabled: true,
      updatedAt: true,
    },
    orderBy: { createdAt: 'asc' as const },
    take: 2,
  },
} as const

type VenueCreateRequest = z.infer<typeof CreateVenueRequestInput>

function venueCreateMatches(
  existing: {
    name: string
    description: string | null
    guideNotes: string | null
    category: string | null
    guideMode: string
    defaultCenterLat: number | null
    defaultCenterLng: number | null
    places: Array<{
      name: string
      type: string
      itemType: string | null
      shortDescription: string | null
      longDescription: string | null
      lat: number | null
      lng: number | null
      tags: string[]
      importanceScore: number
      areaName: string | null
      hours: string | null
      photoUrl: string | null
    }>
    knowledgeEntries?: Array<{
      title: string
      category: string
      content: string
      isEnabled: boolean
    }>
  },
  input: VenueCreateRequest,
  guideMode: 'location_aware' | 'non_location',
): boolean {
  if (
    existing.name !== input.name ||
    existing.description !== (input.description ?? null) ||
    existing.guideNotes !== (input.guideNotes ?? null) ||
    existing.category !== (input.category ?? null) ||
    existing.guideMode !== guideMode ||
    existing.defaultCenterLat !== (input.defaultCenterLat ?? null) ||
    existing.defaultCenterLng !== (input.defaultCenterLng ?? null)
  ) {
    return false
  }

  const initialContent = normalizeInitialVenueContent(input)
  const storedPlaces = existing.places
  const storedKnowledgeEntries = existing.knowledgeEntries ?? []
  const stored = storedPlaces[0]
  const storedKnowledge = storedKnowledgeEntries[0]
  if (!initialContent) return storedPlaces.length === 0 && storedKnowledgeEntries.length === 0

  if (initialContent.kind === 'knowledge') {
    return (
      storedPlaces.length === 0 &&
      storedKnowledgeEntries.length === 1 &&
      storedKnowledge?.title === initialContent.value.title &&
      storedKnowledge.category === initialContent.value.category &&
      storedKnowledge.content === initialContent.value.content &&
      storedKnowledge.isEnabled === true
    )
  }

  const initial = initialContent.value
  if (storedPlaces.length !== 1 || storedKnowledgeEntries.length !== 0 || !stored) return false

  return (
    stored.name === initial.name &&
    stored.type === initial.type &&
    stored.itemType === null &&
    stored.shortDescription === initial.shortDescription &&
    stored.longDescription === (initial.longDescription ?? null) &&
    stored.lat === (guideMode === 'location_aware' ? input.defaultCenterLat! : null) &&
    stored.lng === (guideMode === 'location_aware' ? input.defaultCenterLng! : null) &&
    JSON.stringify(stored.tags) === JSON.stringify(initial.tags) &&
    stored.importanceScore === initial.importanceScore &&
    stored.areaName === (initial.areaName ?? null) &&
    stored.hours === (initial.hours ?? null) &&
    stored.photoUrl === (initial.photoUrl ?? null)
  )
}

function buildVenueDetailSelect(tenantId: string) {
  return {
    ...venueListSelect,
    _count: {
      select: {
        places: true,
        knowledgeEntries: { where: { tenantId, isEnabled: true } },
      },
    },
  } as const
}

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
    .input(z.object({ slug: z.string().min(1).max(200) }).strict())
    .query(async ({ ctx, input }) => {
      const globallyAllowed = await checkRateLimit(
        'ratelimit:venue-lookup:ingress:global',
        PUBLIC_VENUE_LOOKUP_GLOBAL_LIMIT_PER_MINUTE,
        60,
      )
      if (!globallyAllowed) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many venue lookups. Please try again later.',
        })
      }

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
          chatFont: string | null
          chatLogoUrl: string | null
          chatBannerUrl: string | null
          isActive: boolean
        }[]
      >`
        SELECT id, name, description, category,
               guide_mode            AS "guideMode",
               default_center_lat    AS "defaultCenterLat",
               default_center_lng    AS "defaultCenterLng",
               ai_guide_name         AS "aiGuideName",
               chat_theme            AS "chatTheme",
               chat_accent_color     AS "chatAccentColor",
               chat_font             AS "chatFont",
               chat_logo_url         AS "chatLogoUrl",
               chat_banner_url       AS "chatBannerUrl",
               is_active             AS "isActive"
        FROM venues WHERE slug = ${input.slug} LIMIT 1
      `

      if (!venue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }
      const { isActive, ...publicVenue } = venue
      if (!isActive) throw publicVenueUnavailable()

      return publicVenue
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
        select: buildVenueDetailSelect(ctx.session.activeTenantId),
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
    .input(CreateVenueRequestInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const baseSlug = input.slug ? slugify(input.slug) : slugify(input.name)
      const initialContent = normalizeInitialVenueContent(input)
      const guideMode = input.guideMode ?? 'location_aware'

      try {
        const created = await ctx.db.$transaction(async (tx) => {
          await setContentVersionContext(tx, { actorId: ctx.session.userId })
          if (input.slug) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(
              hashtextextended(${`pathfinder:venue-create:${tenantId}:${baseSlug}`}, 0)
            )`
            const existing = await tx.venue.findFirst({
              where: { tenantId, slug: baseSlug },
              select: venueCreateSelect,
            })
            if (existing) {
              if (!venueCreateMatches(existing, input, guideMode)) {
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'This venue slug is already used for different setup content.',
                })
              }
              return { record: existing, shouldEnqueue: false }
            }
          }

          const slug = input.slug ? baseSlug : await uniqueSlug(tx, tenantId, baseSlug)

          const record = await tx.venue.create({
            data: {
              tenantId,
              name: input.name,
              slug,
              ...(input.description !== undefined ? { description: input.description } : {}),
              ...(input.guideNotes !== undefined ? { guideNotes: input.guideNotes } : {}),
              ...(input.category !== undefined ? { category: input.category } : {}),
              guideMode,
              ...(input.defaultCenterLat !== undefined
                ? { defaultCenterLat: input.defaultCenterLat }
                : {}),
              ...(input.defaultCenterLng !== undefined
                ? { defaultCenterLng: input.defaultCenterLng }
                : {}),
              ...(initialContent?.kind === 'place'
                ? {
                    places: {
                      create: {
                        tenantId,
                        name: initialContent.value.name,
                        type: initialContent.value.type,
                        shortDescription: initialContent.value.shortDescription,
                        ...(initialContent.value.longDescription !== undefined
                          ? { longDescription: initialContent.value.longDescription }
                          : {}),
                        ...(initialContent.value.areaName !== undefined
                          ? { areaName: initialContent.value.areaName }
                          : {}),
                        ...(initialContent.value.hours !== undefined
                          ? { hours: initialContent.value.hours }
                          : {}),
                        ...(initialContent.value.photoUrl !== undefined
                          ? { photoUrl: initialContent.value.photoUrl }
                          : {}),
                        tags: initialContent.value.tags,
                        importanceScore: initialContent.value.importanceScore,
                        ...(guideMode === 'location_aware'
                          ? {
                              lat: input.defaultCenterLat!,
                              lng: input.defaultCenterLng!,
                            }
                          : {}),
                      },
                    },
                  }
                : {}),
              ...(initialContent?.kind === 'knowledge'
                ? {
                    knowledgeEntries: {
                      create: {
                        tenantId,
                        title: initialContent.value.title,
                        category: initialContent.value.category,
                        content: initialContent.value.content,
                        isEnabled: true,
                      },
                    },
                  }
                : {}),
            },
            select: venueCreateSelect,
          })

          const placeCount = record.places?.length ?? 0
          const knowledgeCount = record.knowledgeEntries?.length ?? 0
          if (
            (initialContent?.kind === 'place' && (placeCount !== 1 || knowledgeCount !== 0)) ||
            (initialContent?.kind === 'knowledge' && (knowledgeCount !== 1 || placeCount !== 0)) ||
            (!initialContent && (placeCount !== 0 || knowledgeCount !== 0))
          ) {
            throw new Error('Initial content was not returned from the atomic venue create')
          }

          return { record, shouldEnqueue: true }
        })

        const { places = [], knowledgeEntries = [], ...venue } = created.record
        const initialPlace = places[0]
        const initialKnowledgeEntry = knowledgeEntries[0]
        if (created.shouldEnqueue && initialPlace) await embedPlace(initialPlace)
        if (created.shouldEnqueue && initialKnowledgeEntry) {
          await embedKnowledgeEntry(initialKnowledgeEntry)
        }
        return venue
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
    .use(withContentVersionActor)
    .input(UpdateVenueRequestInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      await lockVenueContentMutation(ctx.db, { tenantId, venueId: input.id })

      const existing = await ctx.db.venue.findFirst({
        where: { id: input.id, tenantId },
        select: { id: true, guideMode: true, updatedAt: true },
      })

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }
      if (existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Venue changed in another session. Refresh and try again.',
        })
      }

      const { id, expectedUpdatedAt, ...raw } = input
      // Strip undefined — exactOptionalPropertyTypes requires no undefined values in Prisma data
      const effectiveGuideMode = input.guideMode ?? existing.guideMode ?? 'location_aware'
      if (
        effectiveGuideMode === 'non_location' &&
        (input.defaultCenterLat !== undefined || input.defaultCenterLng !== undefined)
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Non-location venues cannot define a default center.',
        })
      }

      const data: Record<string, unknown> = Object.fromEntries(
        Object.entries(raw).filter(([, v]) => v !== undefined),
      )
      if (effectiveGuideMode === 'non_location') {
        data.defaultCenterLat = null
        data.defaultCenterLng = null
      }
      data.updatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1))

      // updateMany accepts tenantId in where; update does not (Prisma unique-key constraint)
      const changed = await ctx.db.venue.updateMany({
        where: { id, tenantId, updatedAt: expectedUpdatedAt },
        data,
      })
      if (changed.count !== 1) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Venue changed in another session. Refresh and try again.',
        })
      }

      const updated = await ctx.db.venue.findFirst({
        where: { id, tenantId },
        select: venueListSelect,
      })

      return updated!
    }),

  setAvailability: tenantProcedure
    .use(requireRole('MANAGER'))
    .use(withContentVersionActor)
    .input(
      z
        .object({
          venueId: z.string().cuid(),
          enabled: z.boolean(),
          expectedUpdatedAt: z.coerce.date(),
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      await lockVenueContentMutation(ctx.db, { tenantId, venueId: input.venueId })

      const before = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true, isActive: true, updatedAt: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Venue availability changed; refresh and try again.',
        })
      }
      if (before.isActive === input.enabled) return { ...before, replayed: true }

      const updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
      const changed = await ctx.db.venue.updateMany({
        where: {
          id: input.venueId,
          tenantId,
          isActive: before.isActive,
          updatedAt: before.updatedAt,
        },
        data: { isActive: input.enabled, updatedAt },
      })
      if (changed.count !== 1) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Venue availability changed; refresh and try again.',
        })
      }

      await ctx.db.auditLog.create({
        data: {
          tenantId,
          actorId: ctx.session.userId,
          actorRole: ctx.session.role,
          action: input.enabled ? 'venue.availability.enabled' : 'venue.availability.disabled',
          targetType: 'Venue',
          targetId: input.venueId,
          beforeState: { enabled: before.isActive },
          afterState: { enabled: input.enabled, reason: input.reason },
        },
      })

      return {
        id: before.id,
        isActive: input.enabled,
        updatedAt,
        replayed: false,
      }
    }),

  importContent: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(ImportVenueContentInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true, guideMode: true },
      })

      if (!venue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      const receiptWhere = {
        tenantId,
        venueId: input.venueId,
        idempotencyKey: input.idempotencyKey,
      }
      const receiptSelect = {
        payloadHash: true,
        placeCount: true,
        knowledgeEntryCount: true,
      } as const
      const payloadHash = venueContentImportPayloadHash(input)
      const existingReceipt = await ctx.db.venueContentImportReceipt.findFirst({
        where: receiptWhere,
        select: receiptSelect,
      })
      if (existingReceipt) return replayVenueContentImport(existingReceipt, payloadHash)

      if (
        venue.guideMode === 'location_aware' &&
        input.places.some((place) => place.lat === undefined || place.lng === undefined)
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Latitude and longitude are required for every guide item at this venue',
        })
      }

      return ctx.db.$transaction(async (tx) => {
        await setContentVersionContext(tx, { actorId: ctx.session.userId })
        await lockVenueContentMutation(tx, { tenantId, venueId: input.venueId })
        const claimed = await tx.venueContentImportReceipt.createMany({
          data: [
            {
              tenantId,
              venueId: input.venueId,
              idempotencyKey: input.idempotencyKey,
              payloadHash,
              placeCount: input.places.length,
              knowledgeEntryCount: input.knowledgeEntries.length,
            },
          ],
          skipDuplicates: true,
        })

        if (claimed.count === 0) {
          const concurrentReceipt = await tx.venueContentImportReceipt.findFirst({
            where: receiptWhere,
            select: receiptSelect,
          })
          if (!concurrentReceipt) {
            throw new Error('Venue content import receipt claim was lost')
          }
          return replayVenueContentImport(concurrentReceipt, payloadHash)
        }

        if (input.places.length > 0) {
          await tx.place.createMany({
            data: input.places.map((place) => ({
              tenantId,
              venueId: input.venueId,
              name: place.name,
              type: place.type,
              ...(place.itemType !== undefined ? { itemType: place.itemType } : {}),
              ...(place.lat !== undefined ? { lat: place.lat } : {}),
              ...(place.lng !== undefined ? { lng: place.lng } : {}),
              tags: place.tags,
              importanceScore: place.importanceScore,
              ...(place.shortDescription !== undefined
                ? { shortDescription: place.shortDescription }
                : {}),
              ...(place.longDescription !== undefined
                ? { longDescription: place.longDescription }
                : {}),
              ...(place.areaName !== undefined ? { areaName: place.areaName } : {}),
              ...(place.hours !== undefined ? { hours: place.hours } : {}),
              ...(place.photoUrl !== undefined ? { photoUrl: place.photoUrl } : {}),
            })),
          })
        }
        if (input.knowledgeEntries.length > 0) {
          await tx.venueKnowledgeEntry.createMany({
            data: input.knowledgeEntries.map((entry) => ({
              tenantId,
              venueId: input.venueId,
              title: entry.title,
              category: entry.category,
              content: entry.content,
              isEnabled: entry.isEnabled,
            })),
          })
        }

        return {
          placeCount: input.places.length,
          knowledgeEntryCount: input.knowledgeEntries.length,
          replayed: false as const,
        }
      })
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
      const updated = await ctx.db.$transaction(async (tx) => {
        await setContentVersionContext(tx, { actorId: ctx.session.userId })
        await lockVenueContentMutation(tx, { tenantId, venueId: input.venueId })
        const venue = await tx.venue.findFirst({
          where: { id: input.venueId, tenantId },
          select: { id: true, tenantId: true },
        })

        if (!venue || venue.tenantId !== tenantId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        }

        if (input.aiFeaturedPlaceId) {
          const place = await tx.place.findFirst({
            where: { id: input.aiFeaturedPlaceId, venueId: input.venueId, tenantId },
            select: { id: true },
          })
          if (!place) throw new TRPCError({ code: 'NOT_FOUND', message: 'Place not found' })
        }

        const data = Object.fromEntries(
          Object.entries(input).filter(([key, value]) => key !== 'venueId' && value !== undefined),
        )
        const changed = await tx.venue.updateMany({
          where: { id: input.venueId, tenantId },
          data,
        })
        if (changed.count !== 1) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Venue changed during save' })
        }

        const saved = await tx.venue.findFirst({
          where: { id: input.venueId, tenantId },
          select: venueAiConfigSelect,
        })
        if (!saved) throw new TRPCError({ code: 'CONFLICT', message: 'Venue changed during save' })
        return saved
      })

      // Re-embed any places that are missing an embedding. Failures are logged and do not block the save.
      const unembeddedIds = await ctx.db.$queryRaw<{ id: string; updatedAt: Date }[]>`
        SELECT id, updated_at AS "updatedAt" FROM places
        WHERE venue_id  = ${input.venueId}
          AND tenant_id = ${tenantId}
          AND is_active = true
          AND embedding IS NULL
      `

      if (unembeddedIds.length > 0) {
        await Promise.all(
          unembeddedIds.map(({ id, updatedAt }) => embedPlace({ id, tenantId, updatedAt })),
        )
      }

      try {
        await emitEvent({
          tenantId,
          venueId: input.venueId,
          sessionId: '',
          eventType: 'venue.updated',
        })
      } catch {
        // Venue analytics are best-effort and must not break the mutation.
      }

      return updated
    }),

  updateChatDesign: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          venueId: z.string().cuid(),
          chatTheme: z.enum(['default', 'forest', 'sunset', 'midnight', 'rose', 'dark']).optional(),
          chatAccentColor: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex colour e.g. #3A7BD5')
            .nullable()
            .optional(),
          chatFont: z
            .enum(['jakarta', 'inter', 'poppins', 'spaceGrotesk', 'dmSans', 'playfair'])
            .optional(),
          chatLogoUrl: z.string().url().max(500).nullable().optional(),
          chatBannerUrl: z.string().url().max(500).nullable().optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const updated = await ctx.db.$transaction(async (tx) => {
        await setContentVersionContext(tx, { actorId: ctx.session.userId })
        await lockVenueContentMutation(tx, { tenantId, venueId: input.venueId })
        const venue = await tx.venue.findFirst({
          where: { id: input.venueId, tenantId },
          select: { id: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })

        const data = Object.fromEntries(
          Object.entries(input).filter(([key, value]) => key !== 'venueId' && value !== undefined),
        )
        const changed = await tx.venue.updateMany({
          where: { id: input.venueId, tenantId },
          data,
        })
        if (changed.count !== 1) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Venue changed during save' })
        }

        const saved = await tx.venue.findFirst({
          where: { id: input.venueId, tenantId },
          select: {
            chatTheme: true,
            chatAccentColor: true,
            chatFont: true,
            chatLogoUrl: true,
            chatBannerUrl: true,
          },
        })
        if (!saved) throw new TRPCError({ code: 'CONFLICT', message: 'Venue changed during save' })
        return saved
      })

      try {
        await emitEvent({
          tenantId,
          venueId: input.venueId,
          sessionId: '',
          eventType: 'venue.updated',
        })
      } catch {
        // Venue analytics are best-effort and must not break the mutation.
      }

      return updated
    }),

  delete: tenantProcedure
    .use(requireRole('OWNER'))
    .use(withContentVersionActor)
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      await lockVenueContentMutation(ctx.db, { tenantId, venueId: input.id })

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
      try {
        const deleted = await ctx.db.venue.deleteMany({ where: { id: input.id, tenantId } })
        if (deleted.count !== 1) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Venue changed during deletion' })
        }
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'P2003'
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Retained package or other dependent history prevents deleting this venue',
            cause: error,
          })
        }
        throw error
      }

      return { id: input.id }
    }),
})
