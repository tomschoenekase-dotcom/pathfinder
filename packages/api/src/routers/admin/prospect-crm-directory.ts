import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  defaultProspectGoodFitRules,
  explainProspectSize,
  prospectGoodFitRulesSchema,
} from '@pathfinder/contracts/prospect-size'
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { prospectPriority, prospectStage } from './prospect-crm-common'
import {
  describeProspectGoodFitVenue,
  prospectGoodFitOrganizationWhere,
  prospectGoodFitVenueWhere,
} from './prospect-crm-good-fit'
import {
  decodeProspectCursor,
  encodeProspectCursor,
  prospectCursorWhere,
} from './prospect-crm-pagination'
export const adminProspectCrmDirectoryRouter = router({
  listProspects: adminProcedure
    .input(
      z
        .object({
          search: z.string().trim().max(200).optional(),
          stage: prospectStage.optional(),
          territoryId: z.string().min(1).max(191).optional(),
          category: z.string().trim().max(200).optional(),
          priority: prospectPriority.optional(),
          relationshipTier: z.enum(['STANDARD', 'HIGH_VALUE', 'STRATEGIC']).optional(),
          goodFit: z.boolean().default(false),
          goodFitRules: prospectGoodFitRulesSchema.optional(),
          emailReadiness: z.enum(['READY', 'MISSING', 'SUPPRESSED']).optional(),
          outreachState: z
            .enum(['NOT_CONTACTED', 'DRAFTED', 'QUEUED', 'SENT', 'REPLIED', 'FAILED'])
            .optional(),
          conversionState: z.enum(['PROSPECT', 'CUSTOMER']).optional(),
          ownerId: z.string().trim().max(191).optional(),
          nextAction: z.enum(['OVERDUE', 'UPCOMING', 'NONE']).optional(),
          includeArchived: z.boolean().default(false),
          limit: z.number().int().min(1).max(100).default(50),
          cursor: z.string().min(1).max(1000).optional(),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const now = new Date()
        let cursorWhere: ReturnType<typeof prospectCursorWhere> | undefined
        if (input.cursor) {
          try {
            cursorWhere = prospectCursorWhere(decodeProspectCursor(input.cursor))
          } catch {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid pagination cursor' })
          }
        }
        const scanLimit = input.goodFit ? input.limit * 4 : input.limit
        const rows = await db.prospectOrganization.findMany({
          where: {
            ...(cursorWhere ? { AND: [cursorWhere] } : {}),
            ...(input.includeArchived ? {} : { archivedAt: null }),
            ...(input.goodFit
              ? prospectGoodFitOrganizationWhere(input.territoryId, input.goodFitRules)
              : {}),
            ...(input.territoryId && !input.goodFit ? { territoryId: input.territoryId } : {}),
            ...(input.relationshipTier ? { relationshipTier: input.relationshipTier } : {}),
            ...(input.emailReadiness === 'READY'
              ? {
                  contacts: {
                    some: {
                      archivedAt: null,
                      doNotContact: false,
                      normalizedEmail: { not: null },
                      emailReadiness: 'VALID',
                      permissionState: { notIn: ['OPTED_OUT', 'PROHIBITED'] },
                      suppressedAt: null,
                      unsubscribedAt: null,
                    },
                  },
                }
              : {}),
            ...(input.emailReadiness === 'MISSING'
              ? { contacts: { none: { archivedAt: null, normalizedEmail: { not: null } } } }
              : {}),
            ...(input.emailReadiness === 'SUPPRESSED'
              ? { contacts: { some: { archivedAt: null, doNotContact: true } } }
              : {}),
            ...(input.category ? { organizationType: input.category } : {}),
            ...(input.conversionState === 'CUSTOMER'
              ? { customerRelationships: { some: { status: 'ACTIVE' } } }
              : {}),
            ...(input.conversionState === 'PROSPECT'
              ? { customerRelationships: { none: { status: 'ACTIVE' } } }
              : {}),
            ...(input.outreachState === 'NOT_CONTACTED'
              ? { campaignMembers: { none: { status: { in: ['SENT', 'REPLIED'] } } } }
              : {}),
            ...(input.outreachState === 'DRAFTED'
              ? {
                  campaignMembers: {
                    some: { status: { in: ['DRAFTED', 'NEEDS_REVIEW', 'APPROVED'] } },
                  },
                }
              : {}),
            ...(input.outreachState === 'QUEUED'
              ? { campaignMembers: { some: { status: 'QUEUED' } } }
              : {}),
            ...(input.outreachState === 'SENT'
              ? { campaignMembers: { some: { status: 'SENT' } } }
              : {}),
            ...(input.outreachState === 'REPLIED'
              ? { campaignMembers: { some: { status: 'REPLIED' } } }
              : {}),
            ...(input.outreachState === 'FAILED'
              ? { campaignMembers: { some: { status: { in: ['FAILED', 'BOUNCED'] } } } }
              : {}),
            ...(input.search
              ? {
                  OR: [
                    { canonicalName: { contains: input.search, mode: 'insensitive' as const } },
                    { normalizedDomain: { contains: input.search.toLowerCase() } },
                    {
                      venues: {
                        some: { name: { contains: input.search, mode: 'insensitive' as const } },
                      },
                    },
                    {
                      contacts: {
                        some: { email: { contains: input.search, mode: 'insensitive' as const } },
                      },
                    },
                  ],
                }
              : {}),
            opportunity: {
              ...(input.stage ? { stage: input.stage } : {}),
              ...(input.priority ? { priority: input.priority } : {}),
              ...(input.ownerId ? { ownerId: input.ownerId } : {}),
              ...(input.nextAction === 'OVERDUE' ? { nextActionAt: { lt: now } } : {}),
              ...(input.nextAction === 'UPCOMING' ? { nextActionAt: { gte: now } } : {}),
              ...(input.nextAction === 'NONE' ? { nextActionAt: null } : {}),
            },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: scanLimit + 1,
          select: {
            id: true,
            canonicalName: true,
            website: true,
            normalizedDomain: true,
            organizationType: true,
            priority: true,
            relationshipTier: true,
            ownerId: true,
            archivedAt: true,
            updatedAt: true,
            territory: { select: { id: true, name: true, code: true } },
            opportunity: {
              select: {
                stage: true,
                priority: true,
                ownerId: true,
                nextAction: true,
                nextActionAt: true,
                lastActivityAt: true,
              },
            },
            venues: {
              where: input.goodFit
                ? prospectGoodFitVenueWhere(input.territoryId, input.goodFitRules)
                : { archivedAt: null },
              orderBy: { createdAt: 'asc' },
              take: input.goodFit ? 25 : 3,
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
                    canonicalName: true,
                    organizationType: true,
                    territoryId: true,
                    tags: true,
                  },
                },
              },
            },
            contacts: {
              where: { archivedAt: null },
              orderBy: { createdAt: 'asc' },
              take: 3,
              select: { id: true, fullName: true, email: true, doNotContact: true },
            },
            _count: { select: { venues: true, contacts: true, activities: true } },
          },
        })
        const prepared = rows
          .slice(0, scanLimit)
          .map((row) => ({
            ...row,
            venues: row.venues
              .map((venue) => ({
                ...venue,
                goodFit: input.goodFit
                  ? describeProspectGoodFitVenue(venue, input.territoryId, input.goodFitRules)
                  : null,
              }))
              .filter((venue) => !input.goodFit || venue.goodFit?.qualifies)
              .slice(0, 3),
            priority: row.opportunity?.priority ?? row.priority,
            ownerId: row.opportunity?.ownerId ?? row.ownerId,
          }))
          .filter((row) => !input.goodFit || row.venues.length > 0)
        const page = prepared.slice(0, input.limit)
        const rules = input.goodFitRules ?? defaultProspectGoodFitRules
        const classOrder = [
          rules.preferredSizeClass,
          ...rules.sizeClasses.filter((sizeClass) => sizeClass !== rules.preferredSizeClass),
        ]
        const items = input.goodFit
          ? [...page].sort(
              (left, right) =>
                classOrder.indexOf(explainProspectSize(left.venues[0]?.fitAttributes).sizeClass) -
                classOrder.indexOf(explainProspectSize(right.venues[0]?.fitAttributes).sizeClass),
            )
          : page
        const cursorRow =
          prepared.length > input.limit
            ? page[page.length - 1]
            : rows.length > scanLimit
              ? rows[scanLimit - 1]
              : null
        return {
          items,
          nextCursor: cursorRow ? encodeProspectCursor(cursorRow) : null,
        }
      }),
    ),
})
