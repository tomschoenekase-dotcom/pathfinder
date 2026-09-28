import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const id = z.string().min(1).max(191)

export const adminProspectCrmIntelligenceRouter = router({
  getProspectIntelligence: adminProcedure
    .input(z.object({ organizationId: id }).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const prospect = await db.prospectOrganization.findUnique({
          where: { id: input.organizationId },
          select: {
            id: true,
            canonicalName: true,
            relationshipTier: true,
            description: true,
            researchProvenance: true,
            tags: true,
            customerRelationships: {
              where: { status: 'ACTIVE' },
              take: 10,
              orderBy: { startedAt: 'desc' },
              select: {
                tenantId: true,
                startedAt: true,
                locationConversions: {
                  where: { status: 'ACTIVE' },
                  take: 50,
                  orderBy: { convertedAt: 'desc' },
                  select: { venueId: true, convertedAt: true },
                },
              },
            },
          },
        })
        if (!prospect) throw new TRPCError({ code: 'NOT_FOUND', message: 'Prospect not found' })
        const links = prospect.customerRelationships.flatMap((relationship) =>
          relationship.locationConversions.map((location) => ({
            tenantId: relationship.tenantId,
            venueId: location.venueId,
            convertedAt: location.convertedAt,
          })),
        )
        const customerTenantId = prospect.customerRelationships[0]?.tenantId
        const billing = customerTenantId
          ? await db.billingAccount.findFirst({
              where: { tenantId: customerTenantId },
              select: {
                tenantId: true,
                billingMode: true,
                status: true,
                paidThroughAt: true,
                gracePeriodEndsAt: true,
                reconciliationHealth: true,
                commercialAgreements: {
                  orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
                  take: 10,
                  select: {
                    id: true,
                    isBase: true,
                    agreedAmountMinor: true,
                    currency: true,
                    billingInterval: true,
                    status: true,
                  },
                },
              },
            })
          : null
        if (!links.length) return { prospect, liveVenue: null, liveVenues: [], billing }
        const primary = links[0]!
        const [venue, places, knowledge] = await Promise.all([
          db.venue.findFirst({
            where: { id: primary.venueId, tenantId: primary.tenantId },
            select: {
              id: true,
              tenantId: true,
              name: true,
              slug: true,
              category: true,
              isActive: true,
              updatedAt: true,
            },
          }),
          db.place.findMany({
            where: { venueId: primary.venueId, tenantId: primary.tenantId, isActive: true },
            orderBy: [{ importanceScore: 'desc' }, { name: 'asc' }],
            take: 100,
            select: {
              id: true,
              name: true,
              type: true,
              itemType: true,
              shortDescription: true,
              areaName: true,
              tags: true,
              updatedAt: true,
            },
          }),
          db.venueKnowledgeEntry.findMany({
            where: { venueId: primary.venueId, tenantId: primary.tenantId, isEnabled: true },
            orderBy: { updatedAt: 'desc' },
            take: 100,
            select: {
              id: true,
              title: true,
              category: true,
              content: true,
              sourceType: true,
              humanConfirmedAt: true,
              updatedAt: true,
            },
          }),
        ])
        const liveVenues = await db.venue.findMany({
          where: { OR: links.map((link) => ({ id: link.venueId, tenantId: link.tenantId })) },
          select: {
            id: true,
            tenantId: true,
            name: true,
            slug: true,
            category: true,
            isActive: true,
          },
        })
        return {
          prospect,
          liveVenue: venue ? { ...venue, places, knowledge } : null,
          liveVenues,
          billing,
        }
      }),
    ),
})
