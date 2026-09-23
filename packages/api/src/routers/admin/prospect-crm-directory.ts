import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass, SALES_PREPARATION_SOURCE } from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  researchDirectoryFields,
  researchDirectoryWhere,
  encodeResearchNameCursor,
  researchNameCursorWhere,
} from './prospect-research-filters'
import { prospectPriority, prospectStage } from './prospect-crm-common'
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
          ...researchDirectoryFields,
          search: z.string().trim().max(200).optional(),
          stage: prospectStage.optional(),
          territoryId: z.string().min(1).max(191).optional(),
          category: z.string().trim().max(200).optional(),
          priority: prospectPriority.optional(),
          relationshipTier: z.enum(['STANDARD', 'HIGH_VALUE', 'STRATEGIC']).optional(),
          emailReadiness: z.enum(['READY', 'MISSING', 'SUPPRESSED']).optional(),
          outreachState: z
            .enum(['NOT_CONTACTED', 'NO_RECORDED_SEND', 'DRAFTED', 'QUEUED', 'SENT', 'REPLIED', 'FAILED'])
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
        let cursorWhere:
          | ReturnType<typeof prospectCursorWhere>
          | ReturnType<typeof researchNameCursorWhere>
          | undefined
        if (input.cursor) {
          try {
            cursorWhere =
              input.sort === 'UPDATED'
                ? prospectCursorWhere(decodeProspectCursor(input.cursor))
                : researchNameCursorWhere(input.cursor, input.sort)
          } catch {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid pagination cursor' })
          }
        }
        const where = {
          AND: [...researchDirectoryWhere(input),...(input.territoryId?[{OR:[{territoryId:input.territoryId},{venues:{some:{geography:{status:'ASSIGNED',territoryId:input.territoryId}}}}]}]:[])],
          ...(input.includeArchived ? {} : { archivedAt: null }),
          ...(input.relationshipTier ? { relationshipTier: input.relationshipTier } : {}),
          ...(input.emailReadiness === 'READY'
            ? {
                contacts: {
                  some: {
                    archivedAt: null,
                    doNotContact: false,
                    normalizedEmail: { not: null },
                    emailReadiness: 'VALID' as const,
                    permissionState: {
                      notIn: ['UNKNOWN' as const, 'OPTED_OUT' as const, 'PROHIBITED' as const],
                    },
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
            ? { customerRelationships: { some: { status: 'ACTIVE' as const } } }
            : {}),
          ...(input.conversionState === 'PROSPECT'
            ? { customerRelationships: { none: { status: 'ACTIVE' as const } } }
            : {}),
          ...(['NOT_CONTACTED', 'NO_RECORDED_SEND'].includes(input.outreachState ?? '')
            ? {
                campaignMembers: {
                  none: { status: { in: ['SENT' as const, 'REPLIED' as const] } },
                },
              }
            : {}),
          ...(input.outreachState === 'DRAFTED'
            ? {
                outreachDrafts: {
                  some: { status: { in: ['NEEDS_REVIEW' as const, 'APPROVED' as const] } },
                },
              }
            : {}),
          ...(input.outreachState === 'QUEUED'
            ? { campaignMembers: { some: { status: 'QUEUED' as const } } }
            : {}),
          ...(input.outreachState === 'SENT'
            ? { campaignMembers: { some: { status: 'SENT' as const } } }
            : {}),
          ...(input.outreachState === 'REPLIED'
            ? { campaignMembers: { some: { status: 'REPLIED' as const } } }
            : {}),
          ...(input.outreachState === 'FAILED'
            ? {
                campaignMembers: {
                  some: { status: { in: ['FAILED' as const, 'BOUNCED' as const] } },
                },
              }
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
          ...(input.stage || input.priority || input.ownerId || input.nextAction
            ? {
                opportunity: {
                  ...(input.stage ? { stage: input.stage } : {}),
                  ...(input.priority ? { priority: input.priority } : {}),
                  ...(input.ownerId ? { ownerId: input.ownerId } : {}),
                  ...(input.nextAction === 'OVERDUE' ? { nextActionAt: { lt: now } } : {}),
                  ...(input.nextAction === 'UPCOMING' ? { nextActionAt: { gte: now } } : {}),
                  ...(input.nextAction === 'NONE' ? { nextActionAt: null } : {}),
                },
              }
            : {}),
        }
        const totalCount = await db.prospectOrganization.count({ where })
        const rows = await db.prospectOrganization.findMany({
          where: { ...where, AND: [...where.AND, ...(cursorWhere ? [cursorWhere] : [])] },
          orderBy:
            input.sort === 'UPDATED'
              ? [{ updatedAt: 'desc' }, { id: 'desc' }]
              : [
                  { canonicalName: input.sort === 'NAME_ASC' ? 'asc' : 'desc' },
                  { id: input.sort === 'NAME_ASC' ? 'asc' : 'desc' },
                ],
          take: input.limit + 1,
          select: {
            id: true,
            canonicalName: true,
            source: true,
            createdAt: true,
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
              where: { archivedAt: null },
              orderBy: { createdAt: 'asc' },
              take: 3,
              select: {
                id: true,
                name: true,
                city: true,
                region: true,
                venueType: true,
                website: true,
                geography: { select: { status:true, countyGeoid:true, territoryId:true, modelVersion:true, reason:true } },
              },
            },
            contacts: {
              where: { archivedAt: null },
              orderBy: { createdAt: 'asc' },
              take: 3,
              select: {
                id: true,
                fullName: true,
                email: true,
                phone: true,
                doNotContact: true,
                emailReadiness: true,
                permissionState: true,
                suppressedAt: true,
                unsubscribedAt: true,
              },
            },
            _count: { select: { venues: true, contacts: { where: { archivedAt: null } }, outreachDrafts: true, activities: true,
              sources: { where: { sourceType: { not: SALES_PREPARATION_SOURCE } } } } },
          },
        })
        return {
          totalCount,
          items: rows.slice(0, input.limit).map((row) => ({
            ...row,
            priority: row.opportunity?.priority ?? row.priority,
            ownerId: row.opportunity?.ownerId ?? row.ownerId,
          })),
          nextCursor:
            rows.length > input.limit && rows[input.limit - 1]
              ? input.sort === 'UPDATED'
                ? encodeProspectCursor(rows[input.limit - 1]!)
                : encodeResearchNameCursor(rows[input.limit - 1]!, input.sort)
              : null,
        }
      }),
    ),
})
