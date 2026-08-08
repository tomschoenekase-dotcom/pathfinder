import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminClientReadsRouter = router({
  /**
   * Full detail for a single client (tenant): identity, active members, every
   * venue with its POI count, and a thin 7-day engagement summary. Cross-tenant,
   * so it runs under the isolation bypass.
   *
   * NOTE: engagement here is intentionally minimal (raw counts). The analytics
   * model is expected to be reworked soon — keep this block small and isolated
   * so it can be swapped without touching the rest of the procedure.
   */
  getClient: adminProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .query(async ({ input }) => {
      return withTenantIsolationBypass(async () => {
        const tenant = await db.tenant.findUnique({
          where: { id: input.tenantId },
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            planTier: true,
            createdAt: true,
            memberships: {
              where: { status: 'ACTIVE' },
              select: {
                id: true,
                role: true,
                user: { select: { email: true, fullName: true } },
              },
            },
          },
        })

        if (!tenant) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })
        }

        const venues = await db.venue.findMany({
          where: { tenantId: input.tenantId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            slug: true,
            category: true,
            guideMode: true,
            isActive: true,
            createdAt: true,
            _count: { select: { places: true } },
          },
        })

        const last7 = new Date()
        last7.setUTCDate(last7.getUTCDate() - 7)

        const [sessions7d, messages7d] = await Promise.all([
          db.visitorSession.count({
            where: { tenantId: input.tenantId, startedAt: { gte: last7 } },
          }),
          db.message.count({
            where: { tenantId: input.tenantId, createdAt: { gte: last7 } },
          }),
        ])

        return {
          tenant,
          venues,
          engagement7d: { sessions: sessions7d, messages: messages7d },
        }
      })
    }),

  /**
   * One venue within a client, with its POIs and a thin engagement summary.
   * Cross-tenant (bypass). Same analytics caveat as getClient — keep it minimal.
   */

  getClientVenue: adminProcedure
    .input(z.object({ tenantId: z.string().min(1), venueId: z.string().min(1) }))
    .query(async ({ input }) => {
      return withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            category: true,
            guideMode: true,
            isActive: true,
            defaultCenterLat: true,
            defaultCenterLng: true,
            aiGuideName: true,
            aiTone: true,
            createdAt: true,
            _count: { select: { places: true } },
          },
        })

        if (!venue) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        }

        const places = await db.place.findMany({
          where: { venueId: input.venueId, tenantId: input.tenantId },
          orderBy: [{ importanceScore: 'desc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            type: true,
            itemType: true,
            areaName: true,
            isActive: true,
            lat: true,
            lng: true,
            importanceScore: true,
          },
        })

        const last7 = new Date()
        last7.setUTCDate(last7.getUTCDate() - 7)

        const [sessions7d, messages7d] = await Promise.all([
          db.visitorSession.count({
            where: { tenantId: input.tenantId, venueId: input.venueId, startedAt: { gte: last7 } },
          }),
          db.message.count({
            where: {
              tenantId: input.tenantId,
              createdAt: { gte: last7 },
              session: { venueId: input.venueId },
            },
          }),
        ])

        return {
          venue,
          places,
          engagement7d: { sessions: sessions7d, messages: messages7d },
        }
      })
    }),
})
