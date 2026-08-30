import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { prospectStage } from './prospect-crm-common'
import {
  decodeProspectCursor,
  encodeProspectCursor,
  prospectCursorWhere,
} from './prospect-crm-pagination'
export const adminProspectCrmCoreRouter = router({
  getProspect: adminProcedure
    .input(z.object({ organizationId: z.string().min(1).max(191) }).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const prospect = await db.prospectOrganization.findUnique({
          where: { id: input.organizationId },
          include: {
            territory: true,
            opportunity: {
              include: { stageHistory: { orderBy: { createdAt: 'desc' }, take: 100 } },
            },
            venues: { orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }] },
            contacts: { orderBy: [{ archivedAt: 'asc' }, { fullName: 'asc' }] },
            sources: { orderBy: { createdAt: 'desc' }, take: 200 },
            activities: { orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 100 },
            summaries: {
              where: { status: { in: ['CURRENT', 'STALE'] } },
              orderBy: { version: 'desc' },
              take: 1,
            },
            relationshipNotes: {
              where: { promotionStatus: 'PROMOTED', archivedAt: null },
              orderBy: [{ lastConfirmedAt: 'desc' }, { updatedAt: 'desc' }],
              take: 20,
            },
            openLoops: {
              where: { status: { in: ['OPEN', 'BLOCKED'] } },
              orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
              take: 20,
            },
            commitments: {
              where: { status: 'OPEN' },
              orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
              take: 20,
            },
            companyMeetings: {
              orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
              take: 20,
              include: {
                participants: {
                  orderBy: { createdAt: 'asc' },
                  take: 20,
                  select: { id: true, displayName: true, role: true, isTorchiko: true },
                },
                extractions: {
                  where: { promotionStatus: { in: ['CANDIDATE', 'PROMOTED'] } },
                  orderBy: { createdAt: 'asc' },
                  take: 30,
                  select: { id: true, type: true, content: true, promotionStatus: true },
                },
                transcriptArtifacts: {
                  orderBy: { acquiredAt: 'desc' },
                  take: 1,
                  select: {
                    id: true,
                    sourceReference: true,
                    acquiredAt: true,
                    expiresAt: true,
                  },
                },
              },
            },
            companyKnowledgeItems: {
              where: { promotionStatus: 'PROMOTED', archivedAt: null },
              orderBy: [{ effectiveAt: 'desc' }, { updatedAt: 'desc' }],
              take: 20,
              select: {
                id: true,
                type: true,
                title: true,
                summary: true,
                authority: true,
                effectiveAt: true,
                lastConfirmedAt: true,
              },
            },
            emailThreads: {
              orderBy: { lastMessageAt: 'desc' },
              take: 50,
              include: {
                messages: {
                  orderBy: { occurredAt: 'desc' },
                  take: 100,
                  select: {
                    id: true,
                    direction: true,
                    status: true,
                    fromAddress: true,
                    toAddresses: true,
                    subject: true,
                    bodyPreview: true,
                    bodyRetentionState: true,
                    sourceReference: true,
                    attachmentMetadata: true,
                    attachmentRetentionRequests: {
                      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                      take: 50,
                      select: {
                        id: true,
                        providerAttachmentId: true,
                        filename: true,
                        mimeType: true,
                        sizeBytes: true,
                        category: true,
                        purpose: true,
                        sourceReference: true,
                        status: true,
                        requestedById: true,
                        reviewedById: true,
                        reviewReason: true,
                        reviewedAt: true,
                        createdAt: true,
                      },
                    },
                    occurredAt: true,
                  },
                },
              },
            },
            followups: { orderBy: { dueAt: 'asc' }, take: 100 },
            campaignMembers: {
              orderBy: { updatedAt: 'desc' },
              take: 50,
              include: { campaign: { select: { id: true, name: true, status: true } } },
            },
            conversion: {
              include: {
                tenant: { select: { id: true, name: true, slug: true } },
                venue: { select: { id: true, name: true, slug: true } },
              },
            },
            customerRelationships: {
              orderBy: [{ status: 'asc' }, { startedAt: 'desc' }],
              include: {
                tenant: { select: { id: true, name: true, slug: true } },
                locationConversions: {
                  orderBy: { convertedAt: 'desc' },
                  include: { venue: { select: { id: true, name: true, slug: true } } },
                },
              },
            },
          },
        })
        if (!prospect) throw new TRPCError({ code: 'NOT_FOUND', message: 'Prospect not found' })
        const currentRelationship = prospect.customerRelationships.find(
          (relationship) => relationship.status === 'ACTIVE',
        )
        const currentLocation = currentRelationship?.locationConversions.find(
          (location) => location.status === 'ACTIVE',
        )
        return {
          ...prospect,
          // Temporary read-only compatibility projection for the pre-correction dashboard.
          conversion: currentRelationship
            ? {
                id: currentRelationship.id,
                tenantId: currentRelationship.tenantId,
                venueId: currentLocation?.venueId ?? null,
                convertedAt: currentLocation?.convertedAt ?? currentRelationship.startedAt,
                tenant: currentRelationship.tenant,
                venue: currentLocation?.venue ?? null,
              }
            : prospect.conversion,
        }
      }),
    ),
  getProspectPipeline: adminProcedure
    .input(
      z
        .object({
          stage: prospectStage.optional(),
          limit: z.number().int().min(1).max(200).default(100),
          cursor: z.string().min(1).max(1000).optional(),
        })
        .strict()
        .default({ limit: 100 }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        let cursorWhere: ReturnType<typeof prospectCursorWhere> | undefined
        if (input.cursor) {
          try {
            cursorWhere = prospectCursorWhere(decodeProspectCursor(input.cursor))
          } catch {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid pagination cursor' })
          }
        }
        const rows = await db.prospectOpportunity.findMany({
          where: {
            organization: { archivedAt: null },
            ...(input.stage ? { stage: input.stage } : {}),
            ...(cursorWhere ? { AND: [cursorWhere] } : {}),
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            updatedAt: true,
            stage: true,
            priority: true,
            ownerId: true,
            nextAction: true,
            nextActionAt: true,
            lastActivityAt: true,
            organization: {
              select: {
                id: true,
                canonicalName: true,
                territory: { select: { name: true } },
                venues: {
                  where: { archivedAt: null },
                  take: 1,
                  select: { city: true, region: true },
                },
              },
            },
          },
        })
        const totals = await db.prospectOpportunity.groupBy({
          by: ['stage'],
          where: { organization: { archivedAt: null } },
          _count: { _all: true },
        })
        return {
          items: rows.slice(0, input.limit),
          nextCursor:
            rows.length > input.limit && rows[input.limit - 1]
              ? encodeProspectCursor(rows[input.limit - 1]!)
              : null,
          totals: Object.fromEntries(totals.map((item) => [item.stage, item._count._all])),
          // Compatibility for the current board while it adopts cursor navigation.
          truncated: rows.length > input.limit,
        }
      }),
    ),

  listProspectActivities: adminProcedure
    .input(
      z
        .object({
          organizationId: z.string().min(1).max(191),
          limit: z.number().int().min(1).max(200).default(100),
          beforeOccurredAt: z.string().datetime().optional(),
          beforeId: z.string().min(1).max(191).optional(),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        if (Boolean(input.beforeOccurredAt) !== Boolean(input.beforeId)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Both activity cursor fields are required',
          })
        }
        const occurredAt = input.beforeOccurredAt ? new Date(input.beforeOccurredAt) : null
        const rows = await db.prospectActivity.findMany({
          where: {
            organizationId: input.organizationId,
            ...(occurredAt && input.beforeId
              ? {
                  OR: [
                    { occurredAt: { lt: occurredAt } },
                    { occurredAt, id: { lt: input.beforeId } },
                  ],
                }
              : {}),
          },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
        })
        const last = rows[input.limit - 1]
        return {
          items: rows.slice(0, input.limit),
          nextCursor:
            rows.length > input.limit && last
              ? { beforeOccurredAt: last.occurredAt.toISOString(), beforeId: last.id }
              : null,
        }
      }),
    ),

  listProspectThreads: adminProcedure
    .input(
      z
        .object({
          organizationId: z.string().min(1).max(191),
          limit: z.number().int().min(1).max(100).default(50),
          beforeUpdatedAt: z.string().datetime().optional(),
          beforeId: z.string().min(1).max(191).optional(),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        if (Boolean(input.beforeUpdatedAt) !== Boolean(input.beforeId)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Both thread cursor fields are required',
          })
        }
        const updatedAt = input.beforeUpdatedAt ? new Date(input.beforeUpdatedAt) : null
        const rows = await db.prospectEmailThread.findMany({
          where: {
            organizationId: input.organizationId,
            ...(updatedAt && input.beforeId
              ? {
                  OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: input.beforeId } }],
                }
              : {}),
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          include: { _count: { select: { messages: true } } },
        })
        const last = rows[input.limit - 1]
        return {
          items: rows.slice(0, input.limit),
          nextCursor:
            rows.length > input.limit && last
              ? { beforeUpdatedAt: last.updatedAt.toISOString(), beforeId: last.id }
              : null,
        }
      }),
    ),

  listProspectThreadMessages: adminProcedure
    .input(
      z
        .object({
          threadId: z.string().min(1).max(191),
          limit: z.number().int().min(1).max(200).default(100),
          beforeOccurredAt: z.string().datetime().optional(),
          beforeId: z.string().min(1).max(191).optional(),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        if (Boolean(input.beforeOccurredAt) !== Boolean(input.beforeId)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Both message cursor fields are required',
          })
        }
        const occurredAt = input.beforeOccurredAt ? new Date(input.beforeOccurredAt) : null
        const rows = await db.prospectEmailMessage.findMany({
          where: {
            threadId: input.threadId,
            ...(occurredAt && input.beforeId
              ? {
                  OR: [
                    { occurredAt: { lt: occurredAt } },
                    { occurredAt, id: { lt: input.beforeId } },
                  ],
                }
              : {}),
          },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
        })
        const last = rows[input.limit - 1]
        return {
          items: rows.slice(0, input.limit),
          nextCursor:
            rows.length > input.limit && last
              ? { beforeOccurredAt: last.occurredAt.toISOString(), beforeId: last.id }
              : null,
        }
      }),
    ),
})
