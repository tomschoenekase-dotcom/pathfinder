import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { describeProspectGoodFitVenue, prospectGoodFitVenueWhere } from './prospect-crm-directory'

const id = z.string().min(1).max(191)

export const adminProspectCrmIntelligenceRouter = router({
  // Assistant discovery uses the same explicit Good fit rule as the directory.
  findProspectsForAssistant: adminProcedure
    .input(
      z
        .object({
          ask: z.string().trim().min(1).max(500),
          territoryId: id.optional(),
          limit: z.number().int().min(1).max(25).default(10),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const ask = input.ask.toLowerCase()
        const asksForLarge = /\b(?:xl|stadiums?|arenas?|enterprise[\s-]+scale|largest)\b/i.test(ask)
        if (asksForLarge) {
          if (/\b(?:good fit|qualif(?:y|ies))\b/.test(ask)) {
            return {
              view: 'Good fit' as const,
              items: [],
              note: 'Stadiums, arenas, and XL venues do not qualify for the Good fit view.',
            }
          }
          const venues = await db.prospectVenue.findMany({
            where: {
              archivedAt: null,
              estimatedSize: 'XL',
              AND: [
                {
                  OR: input.territoryId
                    ? [
                        { territoryId: input.territoryId },
                        { organization: { is: { territoryId: input.territoryId } } },
                      ]
                    : [
                        { territoryId: { not: null } },
                        { organization: { is: { territoryId: { not: null } } } },
                      ],
                },
              ],
              organization: { is: { archivedAt: null } },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: input.limit * 4,
            select: {
              id: true,
              name: true,
              city: true,
              region: true,
              venueType: true,
              territoryId: true,
              estimatedSize: true,
              fitAttributes: true,
              organization: {
                select: {
                  id: true,
                  canonicalName: true,
                  organizationType: true,
                  territoryId: true,
                },
              },
            },
          })
          return {
            view: null,
            items: venues
              .filter((venue) => {
                const size =
                  venue.fitAttributes &&
                  typeof venue.fitAttributes === 'object' &&
                  !Array.isArray(venue.fitAttributes)
                    ? (venue.fitAttributes as Record<string, unknown>).torchikoSizeV1
                    : null
                return (
                  size &&
                  typeof size === 'object' &&
                  (size as Record<string, unknown>).class === 'XL'
                )
              })
              .slice(0, input.limit)
              .map((venue) => ({
                organizationId: venue.organization.id,
                venueId: venue.id,
                organizationName: venue.organization.canonicalName,
                venueName: venue.name,
                city: venue.city,
                region: venue.region,
                sizeClass: venue.estimatedSize,
                ...describeProspectGoodFitVenue(venue, input.territoryId),
              })),
            note: 'Explicit XL search outside the Good fit view. These records are not outreach recommendations; review contact history separately.',
          }
        }
        const wantsUnknown = /\b(?:unknown|uncertain|missing size|size evidence)\b/.test(ask)
        if (wantsUnknown) {
          const venues = await db.prospectVenue.findMany({
            where: {
              archivedAt: null,
              OR: [{ estimatedSize: null }, { estimatedSize: 'UNKNOWN' }],
              AND: [
                {
                  OR: input.territoryId
                    ? [
                        { territoryId: input.territoryId },
                        { organization: { is: { territoryId: input.territoryId } } },
                      ]
                    : [
                        { territoryId: { not: null } },
                        { organization: { is: { territoryId: { not: null } } } },
                      ],
                },
              ],
              organization: { is: { archivedAt: null } },
              campaignMembers: { none: {} },
              outreachDrafts: { none: {} },
              emailMessages: { none: { direction: 'OUTBOUND' } },
              activities: { none: { type: 'OUTREACH_SENT' } },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: input.limit,
            select: {
              id: true,
              name: true,
              city: true,
              region: true,
              venueType: true,
              territoryId: true,
              estimatedSize: true,
              fitAttributes: true,
              organization: {
                select: {
                  id: true,
                  canonicalName: true,
                  organizationType: true,
                  territoryId: true,
                },
              },
            },
          })
          return {
            view: null,
            items: [],
            unknownCandidates: venues.map((venue) => ({
              organizationId: venue.organization.id,
              venueId: venue.id,
              venueName: venue.name,
              unknown: describeProspectGoodFitVenue(venue, input.territoryId).unknown,
            })),
            note: 'These are research candidates, not Good fit results. Size evidence is unknown and must be verified before a size-based recommendation.',
          }
        }
        const categories = [
          ...(ask.includes('museum') ? ['museum'] : []),
          ...(ask.includes('zoo') ? ['zoo'] : []),
          ...(ask.includes('aquarium') ? ['aquarium'] : []),
          ...(/performing arts|theat(?:er|re)/.test(ask) ? ['performing'] : []),
        ]
        const mentionsSmall = /\bsmall\b/.test(ask)
        const mentionsMedium = /\bmedium\b/.test(ask)
        const mentionsLarge = /\blarge\b/.test(ask)
        const requestedSizes =
          mentionsSmall || mentionsMedium || mentionsLarge
            ? new Set(
                mentionsSmall && mentionsLarge
                  ? ['S', 'M', 'L']
                  : [
                      ...(mentionsSmall ? ['S'] : []),
                      ...(mentionsMedium ? ['M'] : []),
                      ...(mentionsLarge ? ['L'] : []),
                    ],
              )
            : null
        const items: Array<{
          organizationId: string
          venueId: string
          organizationName: string
          venueName: string
          city: string | null
          region: string | null
          sizeClass: string | null
          qualifies: boolean
          reason: string
          unknown: string | null
          excludedReason: string | null
        }> = []
        const categoryWhere = categories.length
          ? {
              OR: categories.flatMap((term) => [
                {
                  fitAttributes: {
                    path: ['torchikoTriageV1', 'normalizedType'],
                    string_contains: term,
                    mode: 'insensitive' as const,
                  },
                },
                { venueType: { contains: term, mode: 'insensitive' as const } },
                {
                  organization: {
                    is: { organizationType: { contains: term, mode: 'insensitive' as const } },
                  },
                },
              ]),
            }
          : null
        // Query each band in preference order so M remains first even in a large CRM.
        for (const sizeClass of ['M', 'S', 'L'] as const) {
          if (items.length >= input.limit) break
          if (requestedSizes && !requestedSizes.has(sizeClass)) continue
          const venues = await db.prospectVenue.findMany({
            where: {
              AND: [
                prospectGoodFitVenueWhere(input.territoryId),
                { estimatedSize: sizeClass },
                ...(categoryWhere ? [categoryWhere] : []),
              ],
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: input.limit * 4,
            select: {
              id: true,
              name: true,
              city: true,
              region: true,
              venueType: true,
              territoryId: true,
              estimatedSize: true,
              fitAttributes: true,
              organization: {
                select: {
                  id: true,
                  canonicalName: true,
                  organizationType: true,
                  territoryId: true,
                },
              },
            },
          })
          for (const venue of venues) {
            const explanation = describeProspectGoodFitVenue(venue, input.territoryId)
            if (!explanation.qualifies) continue
            const attributes =
              venue.fitAttributes &&
              typeof venue.fitAttributes === 'object' &&
              !Array.isArray(venue.fitAttributes)
                ? (venue.fitAttributes as Record<string, unknown>)
                : {}
            const triage =
              attributes.torchikoTriageV1 && typeof attributes.torchikoTriageV1 === 'object'
                ? (attributes.torchikoTriageV1 as Record<string, unknown>)
                : {}
            const category =
              `${triage.normalizedType ?? ''} ${venue.venueType ?? ''} ${venue.organization.organizationType ?? ''}`.toLowerCase()
            if (categories.length && !categories.some((term) => category.includes(term))) continue
            items.push({
              organizationId: venue.organization.id,
              venueId: venue.id,
              organizationName: venue.organization.canonicalName,
              venueName: venue.name,
              city: venue.city,
              region: venue.region,
              sizeClass: venue.estimatedSize,
              ...explanation,
            })
            if (items.length >= input.limit) break
          }
        }
        return {
          view: 'Good fit' as const,
          items,
          note: 'Good fit results use the requested category and size where stated. No recorded outbound, draft, campaign, or open/confirmed duplicate matched. Correspondence completeness is not certified by this query.',
        }
      }),
    ),

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
