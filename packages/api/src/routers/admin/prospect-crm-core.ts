import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  addProspectNoteAction,
  archiveProspectAction,
  createProspectAction,
  db,
  linkProspectConversionAction,
  updateProspectPipelineAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  mapProspectActionError,
  prospectActor,
  prospectBoundedText,
  prospectPriority,
  prospectStage,
} from './prospect-crm-common'

export const adminProspectCrmCoreRouter = router({
  listProspectTerritories: adminProcedure.query(() =>
    withTenantIsolationBypass(() =>
      db.prospectTerritory.findMany({
        where: { archivedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, code: true, name: true, region: true },
      }),
    ),
  ),

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
          emailReadiness: z.enum(['READY', 'MISSING', 'SUPPRESSED']).optional(),
          ownerId: z.string().trim().max(191).optional(),
          nextAction: z.enum(['OVERDUE', 'UPCOMING', 'NONE']).optional(),
          includeArchived: z.boolean().default(false),
          limit: z.number().int().min(1).max(100).default(50),
          cursor: z.string().min(1).max(191).optional(),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const now = new Date()
        const rows = await db.prospectOrganization.findMany({
          where: {
            ...(input.includeArchived ? {} : { archivedAt: null }),
            ...(input.territoryId ? { territoryId: input.territoryId } : {}),
            ...(input.priority ? { priority: input.priority } : {}),
            ...(input.relationshipTier ? { relationshipTier: input.relationshipTier } : {}),
            ...(input.emailReadiness === 'READY'
              ? {
                  contacts: {
                    some: { archivedAt: null, doNotContact: false, normalizedEmail: { not: null } },
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
              ...(input.ownerId ? { ownerId: input.ownerId } : {}),
              ...(input.nextAction === 'OVERDUE' ? { nextActionAt: { lt: now } } : {}),
              ...(input.nextAction === 'UPCOMING' ? { nextActionAt: { gte: now } } : {}),
              ...(input.nextAction === 'NONE' ? { nextActionAt: null } : {}),
            },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
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
              where: { archivedAt: null },
              orderBy: { createdAt: 'asc' },
              take: 3,
              select: { id: true, name: true, city: true, region: true, venueType: true },
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
        return {
          items: rows.slice(0, input.limit),
          nextCursor: rows.length > input.limit ? (rows[input.limit - 1]?.id ?? null) : null,
        }
      }),
    ),

  getProspect: adminProcedure
    .input(z.object({ organizationId: z.string().min(1).max(191) }).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const prospect = await db.prospectOrganization.findUnique({
          where: { id: input.organizationId },
          include: {
            territory: true,
            opportunity: { include: { stageHistory: { orderBy: { createdAt: 'desc' } } } },
            venues: { orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }] },
            contacts: { orderBy: [{ archivedAt: 'asc' }, { fullName: 'asc' }] },
            sources: { orderBy: { createdAt: 'desc' }, take: 200 },
            activities: { orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] },
            emailThreads: {
              orderBy: { lastMessageAt: 'desc' },
              include: { messages: { orderBy: { occurredAt: 'desc' }, take: 100 } },
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
          },
        })
        if (!prospect) throw new TRPCError({ code: 'NOT_FOUND', message: 'Prospect not found' })
        return prospect
      }),
    ),

  getProspectPipeline: adminProcedure.query(() =>
    withTenantIsolationBypass(async () => {
      const rows = await db.prospectOpportunity.findMany({
        where: { organization: { archivedAt: null } },
        orderBy: [{ priority: 'desc' }, { nextActionAt: 'asc' }, { updatedAt: 'desc' }],
        take: 1000,
        select: {
          id: true,
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
      return { items: rows, truncated: rows.length === 1000 }
    }),
  ),

  createProspect: adminProcedure
    .input(
      z
        .object({
          organization: z
            .object({
              canonicalName: prospectBoundedText(300),
              aliases: z.array(prospectBoundedText(300)).max(20).optional(),
              website: z.string().trim().max(2000).optional(),
              organizationType: z.string().trim().max(200).optional(),
              description: z.string().trim().max(5000).optional(),
              territoryId: z.string().min(1).max(191).optional(),
              source: z.string().trim().max(500).optional(),
              ownerId: z.string().trim().max(191).optional(),
              priority: prospectPriority.optional(),
              notes: z.string().trim().max(10000).optional(),
              tags: z.array(prospectBoundedText(100)).max(30).optional(),
            })
            .strict(),
          venue: z
            .object({
              name: prospectBoundedText(300),
              website: z.string().trim().max(2000).optional(),
              venueType: z.string().trim().max(200).optional(),
              city: z.string().trim().max(200).optional(),
              region: z.string().trim().max(100).optional(),
              country: z.string().trim().max(100).optional(),
              notes: z.string().trim().max(10000).optional(),
            })
            .strict()
            .optional(),
          contact: z
            .object({
              fullName: z.string().trim().max(300).optional(),
              title: z.string().trim().max(300).optional(),
              email: z.string().trim().max(320).optional(),
              phone: z.string().trim().max(200).optional(),
              source: z.string().trim().max(500).optional(),
              doNotContact: z.boolean().optional(),
              notes: z.string().trim().max(5000).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        createProspectAction({ ...input, actor: prospectActor(ctx.session.userId) }).catch(
          mapProspectActionError,
        ),
      ),
    ),

  updateProspectPipeline: adminProcedure
    .input(
      z
        .object({
          organizationId: z.string().min(1).max(191),
          stage: prospectStage,
          priority: prospectPriority.optional(),
          ownerId: z.string().trim().max(191).nullable().optional(),
          nextAction: z.string().trim().max(2000).nullable().optional(),
          nextActionAt: z.string().datetime().nullable().optional(),
          reason: z.string().trim().max(2000).optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        updateProspectPipelineAction({
          ...input,
          nextActionAt:
            input.nextActionAt === undefined
              ? undefined
              : input.nextActionAt === null
                ? null
                : new Date(input.nextActionAt),
          actor: prospectActor(ctx.session.userId),
        }).catch(mapProspectActionError),
      ),
    ),

  addProspectNote: adminProcedure
    .input(
      z
        .object({ organizationId: z.string().min(1).max(191), note: prospectBoundedText(10000) })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        addProspectNoteAction({ ...input, actor: prospectActor(ctx.session.userId) }).catch(
          mapProspectActionError,
        ),
      ),
    ),

  archiveProspect: adminProcedure
    .input(
      z
        .object({
          organizationId: z.string().min(1).max(191),
          archived: z.boolean(),
          reason: prospectBoundedText(2000),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        archiveProspectAction({ ...input, actor: prospectActor(ctx.session.userId) }).catch(
          mapProspectActionError,
        ),
      ),
    ),

  linkProspectConversion: adminProcedure
    .input(
      z
        .object({
          organizationId: z.string().min(1).max(191),
          prospectVenueId: z.string().min(1).max(191).optional(),
          tenantId: z.string().min(1).max(191),
          venueId: z.string().min(1).max(191).optional(),
          evidence: z.record(z.unknown()).optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        linkProspectConversionAction({ ...input, actor: prospectActor(ctx.session.userId) }).catch(
          mapProspectActionError,
        ),
      ),
    ),
})
