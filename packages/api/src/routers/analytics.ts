import { z } from 'zod'

import { ANALYTICS_EVENT_TYPES, type AnalyticsEventType } from '@pathfinder/analytics'

import { router } from '../core'
import { publicProcedure } from '../trpc'

const analyticsTrackEventInput = z
  .object({
    sessionId: z.string().uuid(),
    venueId: z.string().cuid(),
    eventType: z.enum(ANALYTICS_EVENT_TYPES),
    placeId: z.string().cuid().optional(),
    metadata: z.record(z.unknown()).optional(),
    occurredAt: z.coerce.date().optional(),
  })
  .strict()

async function resolveVenueTenant(
  db: Parameters<Parameters<typeof publicProcedure.mutation>[0]>[0]['ctx']['db'],
  venueId: string,
) {
  // Guest sessions have no auth context by design, so this is the one allowed
  // publicProcedure write path: we resolve tenant ownership from the venue row.
  const [venue] = await db.$queryRaw<{ id: string; tenantId: string }[]>`
    SELECT id, tenant_id AS "tenantId" FROM venues WHERE id = ${venueId} AND is_active = true LIMIT 1
  `

  return venue ?? null
}

async function syncGuestSession(
  db: Parameters<Parameters<typeof publicProcedure.mutation>[0]>[0]['ctx']['db'],
  params: {
    eventType: AnalyticsEventType
    sessionId: string
    tenantId: string
    venueId: string
  },
) {
  if (params.eventType === 'session.started') {
    await db.guestSession.upsert({
      where: { id: params.sessionId },
      create: {
        id: params.sessionId,
        tenantId: params.tenantId,
        venueId: params.venueId,
      },
      update: {
        lastSeenAt: new Date(),
      },
    })

    return
  }

  if (params.eventType === 'session.ended') {
    await db.guestSession.updateMany({
      where: { id: params.sessionId, tenantId: params.tenantId },
      data: { lastSeenAt: new Date() },
    })

    return
  }

  if (params.eventType === 'message.sent') {
    await db.guestSession.upsert({
      where: { id: params.sessionId },
      create: {
        id: params.sessionId,
        tenantId: params.tenantId,
        venueId: params.venueId,
        messageCount: 1,
      },
      update: {
        lastSeenAt: new Date(),
        messageCount: {
          increment: 1,
        },
      },
    })

    return
  }

  await db.guestSession.updateMany({
    where: { id: params.sessionId, tenantId: params.tenantId },
    data: { lastSeenAt: new Date() },
  })
}

export const analyticsRouter = router({
  trackEvent: publicProcedure.input(analyticsTrackEventInput).mutation(async ({ ctx, input }) => {
    const venue = await resolveVenueTenant(ctx.db, input.venueId)

    if (!venue) {
      return { ok: false as const }
    }

    await ctx.db.analyticsEvent.create({
      data: {
        tenantId: venue.tenantId,
        venueId: input.venueId,
        sessionId: input.sessionId,
        eventType: input.eventType,
        occurredAt: input.occurredAt ?? new Date(),
        ...(input.placeId !== undefined ? { placeId: input.placeId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    })

    await syncGuestSession(ctx.db, {
      eventType: input.eventType,
      sessionId: input.sessionId,
      tenantId: venue.tenantId,
      venueId: input.venueId,
    })

    return { ok: true as const }
  }),
})
