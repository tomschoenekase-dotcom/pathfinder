import { writeAuditLogStrict } from '@pathfinder/db'
import { TRPCError } from '@trpc/server'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import {
  ArchiveCatalogItemInput,
  RecommendationMeasurementInput,
  SetCatalogItemPriorityInput,
  UpsertCatalogItemInput,
  UpsertRecommendationPolicyInput,
  VenueRecommendationVenueInput,
} from '../schemas/venue-recommendation'
import { tenantProcedure } from '../trpc'

const MEASUREMENT_EVENT_LIMIT = 50_000
const CLICK_EVENT_TYPES = ['place_card.clicked', 'directions.opened', 'visitor.action.clicked']

const SALES_ATTRIBUTION_NOTE =
  'Sales attribution is unavailable: PathFinder has no point-of-sale link, so no revenue, ' +
  'conversion, or ROI is reported. Counts are raw guest-chat exposures and in-app clicks only, ' +
  'and the comparison below is not a controlled experiment.'

function isUniqueViolation(error: unknown): boolean {
  return (
    Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002'
  )
}

const itemSelect = {
  id: true,
  venueId: true,
  stableKey: true,
  version: true,
  category: true,
  name: true,
  description: true,
  placeId: true,
  routeNote: true,
  priceMinor: true,
  currency: true,
  sizeLabel: true,
  priceObservedAt: true,
  effectiveFrom: true,
  effectiveUntil: true,
  availability: true,
  availabilityObservedAt: true,
  hours: true,
  seasonalWindows: true,
  ingredients: true,
  allergens: true,
  dietary: true,
  sources: true,
  lastVerifiedAt: true,
  allowedClaims: true,
  archivedAt: true,
  updatedAt: true,
} as const

const policySelect = {
  id: true,
  venueId: true,
  version: true,
  enabled: true,
  maxBoost: true,
  maxUnsolicitedPerSession: true,
  factMaxAgeDays: true,
  availabilityMaxAgeHours: true,
  expiresAt: true,
  ownerUserId: true,
  ownerLabel: true,
  updatedAt: true,
} as const

function actor(session: { userId: string | null; role: string | null }) {
  return {
    actorId: session.userId ?? 'unknown',
    actorRole: session.role ?? 'MANAGER',
    actorType: 'HUMAN' as const,
  }
}

function itemWriteData(fields: ReturnType<typeof UpsertCatalogItemInput.parse>['fields']) {
  return {
    category: fields.category,
    name: fields.name,
    description: fields.description,
    placeId: fields.placeId,
    routeNote: fields.routeNote,
    priceMinor: fields.priceMinor,
    currency: fields.currency,
    sizeLabel: fields.sizeLabel,
    priceObservedAt: fields.priceObservedAt,
    effectiveFrom: fields.effectiveFrom,
    effectiveUntil: fields.effectiveUntil,
    availability: fields.availability,
    availabilityObservedAt: fields.availabilityObservedAt,
    hours: fields.hours ?? {},
    seasonalWindows: fields.seasonalWindows,
    ingredients: fields.ingredients,
    allergens: fields.allergens,
    dietary: fields.dietary,
    sources: fields.sources,
    lastVerifiedAt: fields.lastVerifiedAt,
    allowedClaims: fields.allowedClaims,
  }
}

export const venueRecommendationRouter = router({
  /** Manager view: guest-visible facts plus the OPERATOR-only commercial priority and policy. */
  getOverview: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VenueRecommendationVenueInput)
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true, name: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      const [policy, items, priorities] = await Promise.all([
        ctx.db.venueRecommendationPolicy.findFirst({
          where: { tenantId, venueId: venue.id },
          select: policySelect,
        }),
        ctx.db.venueCatalogItem.findMany({
          where: { tenantId, venueId: venue.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 100,
          select: itemSelect,
        }),
        ctx.db.venueCatalogItemPriority.findMany({
          where: { tenantId, venueId: venue.id },
          select: { itemId: true, priority: true },
        }),
      ])
      const priorityByItem = new Map(priorities.map((row) => [row.itemId, row.priority]))
      return {
        venue,
        // Absent policy means the capability is off.
        policy,
        items: items.map((item) => ({
          ...item,
          commercialPriority: priorityByItem.get(item.id) ?? ('NORMAL' as const),
        })),
      }
    }),

  upsertItem: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpsertCatalogItemInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      if (input.fields.placeId) {
        const place = await ctx.db.place.findFirst({
          where: { id: input.fields.placeId, tenantId, venueId: venue.id },
          select: { id: true },
        })
        if (!place) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Route place not found' })
      }
      const userId = ctx.session.userId ?? 'unknown'
      const data = itemWriteData(input.fields)
      try {
        return await ctx.db.$transaction(async (tx) => {
          if (input.itemId === undefined) {
            const created = await tx.venueCatalogItem.create({
              data: {
                ...data,
                tenantId,
                venueId: venue.id,
                stableKey: input.stableKey!,
                createdBy: userId,
                updatedBy: userId,
              },
              select: itemSelect,
            })
            await writeAuditLogStrict(
              {
                ...actor(ctx.session),
                tenantId,
                action: 'venue-catalog-item.created',
                targetType: 'VenueCatalogItem',
                targetId: created.id,
                afterState: { venueId: venue.id, stableKey: created.stableKey, version: 1 },
              },
              tx,
            )
            return created
          }
          const updated = await tx.venueCatalogItem.updateMany({
            where: {
              id: input.itemId,
              tenantId,
              venueId: venue.id,
              version: input.expectedVersion!,
              archivedAt: null,
            },
            data: { ...data, updatedBy: userId, version: { increment: 1 } },
          })
          if (updated.count === 0) {
            const existing = await tx.venueCatalogItem.findFirst({
              where: { id: input.itemId, tenantId, venueId: venue.id },
              select: { id: true, archivedAt: true },
            })
            if (!existing || existing.archivedAt)
              throw new TRPCError({ code: 'NOT_FOUND', message: 'Catalog item not found' })
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'This item changed in another session. Refresh and try again.',
            })
          }
          const row = await tx.venueCatalogItem.findFirstOrThrow({
            where: { id: input.itemId, tenantId, venueId: venue.id },
            select: itemSelect,
          })
          await writeAuditLogStrict(
            {
              ...actor(ctx.session),
              tenantId,
              action: 'venue-catalog-item.updated',
              targetType: 'VenueCatalogItem',
              targetId: row.id,
              beforeState: { version: input.expectedVersion },
              afterState: { venueId: venue.id, version: row.version },
            },
            tx,
          )
          return row
        })
      } catch (error) {
        if (isUniqueViolation(error))
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'An item with this stable key already exists for the venue.',
          })
        throw error
      }
    }),

  archiveItem: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(ArchiveCatalogItemInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      return ctx.db.$transaction(async (tx) => {
        const result = await tx.venueCatalogItem.updateMany({
          where: {
            id: input.itemId,
            tenantId,
            venueId: venue.id,
            version: input.expectedVersion,
            archivedAt: null,
          },
          data: {
            archivedAt: new Date(),
            updatedBy: ctx.session.userId ?? 'unknown',
            version: { increment: 1 },
          },
        })
        if (result.count === 0)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'The item was changed or is already archived.',
          })
        await writeAuditLogStrict(
          {
            ...actor(ctx.session),
            tenantId,
            action: 'venue-catalog-item.archived',
            targetType: 'VenueCatalogItem',
            targetId: input.itemId,
            afterState: { venueId: venue.id },
          },
          tx,
        )
        return { archived: true as const }
      })
    }),

  /** OPERATOR-only commercial priority; never part of any guest-visible context. */
  setItemPriority: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(SetCatalogItemPriorityInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      const userId = ctx.session.userId ?? 'unknown'
      return ctx.db.$transaction(async (tx) => {
        const item = await tx.venueCatalogItem.findFirst({
          where: { id: input.itemId, tenantId, venueId: venue.id, archivedAt: null },
          select: { id: true },
        })
        if (!item) throw new TRPCError({ code: 'NOT_FOUND', message: 'Catalog item not found' })
        const before = await tx.venueCatalogItemPriority.findFirst({
          where: { tenantId, venueId: venue.id, itemId: item.id },
          select: { priority: true },
        })
        await tx.venueCatalogItemPriority.upsert({
          where: {
            tenantId_venueId_itemId: { tenantId, venueId: venue.id, itemId: item.id },
          },
          create: {
            tenantId,
            venueId: venue.id,
            itemId: item.id,
            audience: 'OPERATOR',
            priority: input.priority,
            updatedBy: userId,
          },
          update: { priority: input.priority, updatedBy: userId },
        })
        await writeAuditLogStrict(
          {
            ...actor(ctx.session),
            tenantId,
            action: 'venue-catalog-item.priority-changed',
            targetType: 'VenueCatalogItem',
            targetId: item.id,
            beforeState: { priority: before?.priority ?? 'NORMAL' },
            afterState: { priority: input.priority, audience: 'OPERATOR' },
          },
          tx,
        )
        return { itemId: item.id, commercialPriority: input.priority }
      })
    }),

  upsertPolicy: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpsertRecommendationPolicyInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      const userId = ctx.session.userId ?? 'unknown'
      const values = {
        enabled: input.enabled,
        maxBoost: input.maxBoost,
        maxUnsolicitedPerSession: input.maxUnsolicitedPerSession,
        factMaxAgeDays: input.factMaxAgeDays,
        availabilityMaxAgeHours: input.availabilityMaxAgeHours,
        expiresAt: input.expiresAt,
        ownerLabel: input.ownerLabel,
      }
      try {
        return await ctx.db.$transaction(async (tx) => {
          const existing = await tx.venueRecommendationPolicy.findFirst({
            where: { tenantId, venueId: venue.id },
            select: policySelect,
          })
          if (!existing) {
            if (input.expectedVersion !== undefined)
              throw new TRPCError({ code: 'CONFLICT', message: 'The policy no longer exists.' })
            const created = await tx.venueRecommendationPolicy.create({
              data: {
                ...values,
                tenantId,
                venueId: venue.id,
                version: 1,
                ownerUserId: userId,
                createdBy: userId,
                updatedBy: userId,
              },
              select: policySelect,
            })
            await writeAuditLogStrict(
              {
                ...actor(ctx.session),
                tenantId,
                action: 'venue-recommendation-policy.created',
                targetType: 'VenueRecommendationPolicy',
                targetId: created.id,
                afterState: { venueId: venue.id, version: 1, ...values },
              },
              tx,
            )
            return created
          }
          if (input.expectedVersion !== existing.version)
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'The policy changed in another session. Refresh and try again.',
            })
          const result = await tx.venueRecommendationPolicy.updateMany({
            where: { id: existing.id, tenantId, venueId: venue.id, version: existing.version },
            data: { ...values, updatedBy: userId, version: { increment: 1 } },
          })
          if (result.count === 0)
            throw new TRPCError({ code: 'CONFLICT', message: 'The policy changed concurrently.' })
          const row = await tx.venueRecommendationPolicy.findFirstOrThrow({
            where: { id: existing.id, tenantId, venueId: venue.id },
            select: policySelect,
          })
          await writeAuditLogStrict(
            {
              ...actor(ctx.session),
              tenantId,
              action: 'venue-recommendation-policy.updated',
              targetType: 'VenueRecommendationPolicy',
              targetId: row.id,
              beforeState: {
                version: existing.version,
                enabled: existing.enabled,
                maxBoost: existing.maxBoost,
                maxUnsolicitedPerSession: existing.maxUnsolicitedPerSession,
                expiresAt: existing.expiresAt?.toISOString() ?? null,
              },
              afterState: { version: row.version, ...values },
            },
            tx,
          )
          return row
        })
      } catch (error) {
        if (isUniqueViolation(error))
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A policy already exists for this venue.',
          })
        throw error
      }
    }),

  /**
   * Raw counts only. Eligible sessions, exposures and in-app clicks on the item's linked place.
   * There is deliberately no revenue, conversion, lift, or ROI figure.
   */
  getMeasurement: tenantProcedure
    .input(RecommendationMeasurementInput)
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000)
      const [items, events] = await Promise.all([
        ctx.db.venueCatalogItem.findMany({
          where: { tenantId, venueId: venue.id },
          take: 100,
          select: { id: true, name: true, placeId: true },
        }),
        ctx.db.analyticsEvent.findMany({
          where: {
            tenantId,
            venueId: venue.id,
            occurredAt: { gte: since },
            eventType: {
              in: [
                'recommendation.candidate',
                'recommendation.shown',
                'recommendation.declined',
                ...CLICK_EVENT_TYPES,
              ],
            },
          },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          take: MEASUREMENT_EVENT_LIMIT,
          select: {
            eventType: true,
            sessionId: true,
            placeId: true,
            metadata: true,
            occurredAt: true,
          },
        }),
      ])

      const placeByItem = new Map(items.map((item) => [item.id, item.placeId]))
      const routePlaceIds = new Set(items.flatMap((item) => (item.placeId ? [item.placeId] : [])))
      const metaOf = (value: unknown): Record<string, unknown> =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {}
      const clickPlace = (event: (typeof events)[number]): string | null => {
        if (event.placeId) return event.placeId
        const meta = metaOf(event.metadata)
        return meta.targetKind === 'PLACE_ID' && typeof meta.targetId === 'string'
          ? meta.targetId
          : null
      }

      const candidateAt = new Map<string, number>()
      const shownAt = new Map<string, Array<{ itemId: string; at: number }>>()
      const declinedSessions = new Set<string>()
      const perItem = new Map<string, { shownEvents: number; clickEvents: number }>()
      let shownEvents = 0
      for (const event of events) {
        if (!event.sessionId) continue
        const at = event.occurredAt.getTime()
        if (event.eventType === 'recommendation.candidate') {
          if (!candidateAt.has(event.sessionId)) candidateAt.set(event.sessionId, at)
        } else if (event.eventType === 'recommendation.declined') {
          declinedSessions.add(event.sessionId)
        } else if (event.eventType === 'recommendation.shown') {
          const itemId = metaOf(event.metadata).itemId
          if (typeof itemId !== 'string') continue
          shownEvents += 1
          const list = shownAt.get(event.sessionId) ?? []
          list.push({ itemId, at })
          shownAt.set(event.sessionId, list)
          const stats = perItem.get(itemId) ?? { shownEvents: 0, clickEvents: 0 }
          stats.shownEvents += 1
          perItem.set(itemId, stats)
        }
      }

      let shownClickEvents = 0
      const shownSessionsWithClick = new Set<string>()
      const comparisonSessionsWithClick = new Set<string>()
      for (const event of events) {
        if (!event.sessionId || !CLICK_EVENT_TYPES.includes(event.eventType)) continue
        const place = clickPlace(event)
        if (!place || !routePlaceIds.has(place)) continue
        const at = event.occurredAt.getTime()
        const exposures = (shownAt.get(event.sessionId) ?? []).filter(
          (exposure) => exposure.at <= at && placeByItem.get(exposure.itemId) === place,
        )
        if (exposures.length > 0) {
          shownClickEvents += 1
          shownSessionsWithClick.add(event.sessionId)
          const stats = perItem.get(exposures[0]!.itemId)
          if (stats) stats.clickEvents += 1
        } else if (
          !shownAt.has(event.sessionId) &&
          (candidateAt.get(event.sessionId) ?? Infinity) <= at
        ) {
          comparisonSessionsWithClick.add(event.sessionId)
        }
      }

      const candidateNotShownSessions = [...candidateAt.keys()].filter(
        (sessionId) => !shownAt.has(sessionId),
      )
      return {
        windowDays: input.days,
        since,
        truncated: events.length >= MEASUREMENT_EVENT_LIMIT,
        counts: {
          eligibleSessions: candidateAt.size,
          shownEvents,
          shownSessions: shownAt.size,
          declinedSessions: declinedSessions.size,
          candidateNotShownSessions: candidateNotShownSessions.length,
          shownSessionsWithClick: shownSessionsWithClick.size,
          shownClickEvents,
          candidateNotShownSessionsWithClick: comparisonSessionsWithClick.size,
        },
        perItem: items.map((item) => ({
          itemId: item.id,
          name: item.name,
          hasRoutePlace: item.placeId !== null,
          shownEvents: perItem.get(item.id)?.shownEvents ?? 0,
          clickEvents: perItem.get(item.id)?.clickEvents ?? 0,
        })),
        clickDefinition:
          'A click is an existing public place-card click, directions-open, or place-targeted action click on the item route place after exposure in the same session.',
        salesAttribution: 'unavailable' as const,
        note: SALES_ATTRIBUTION_NOTE,
      }
    }),
})
