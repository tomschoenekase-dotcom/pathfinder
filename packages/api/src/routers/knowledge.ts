import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { logger } from '@pathfinder/config/logger'
import { db } from '@pathfinder/db'
import { enqueueEmbedKnowledgeEntry } from '@pathfinder/jobs'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

type Db = typeof db

const knowledgeEntrySelect = {
  id: true,
  tenantId: true,
  venueId: true,
  title: true,
  category: true,
  content: true,
  isEnabled: true,
  createdAt: true,
  updatedAt: true,
} as const

async function assertVenueBelongsToTenant(
  db: Db,
  venueId: string,
  tenantId: string,
): Promise<void> {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true },
  })

  if (!venue) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
  }
}

async function enqueueKnowledgeEmbedding(payload: {
  entryId: string
  tenantId: string
}): Promise<void> {
  try {
    await enqueueEmbedKnowledgeEntry(payload)
  } catch (err) {
    logger.warn({
      action: 'knowledge.embed.enqueue.failed',
      tenantId: payload.tenantId,
      entryId: payload.entryId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export const CreateKnowledgeEntryInput = z.object({
  venueId: z.string().cuid(),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  content: z.string().min(1).max(5000),
  isEnabled: z.boolean().default(true),
})

export const UpdateKnowledgeEntryInput = z.object({
  id: z.string().cuid(),
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  content: z.string().min(1).max(5000).optional(),
  isEnabled: z.boolean().optional(),
})

export const knowledgeRouter = router({
  list: tenantProcedure
    .input(z.object({ venueId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      await assertVenueBelongsToTenant(ctx.db, input.venueId, tenantId)

      return ctx.db.venueKnowledgeEntry.findMany({
        where: { venueId: input.venueId, tenantId },
        select: knowledgeEntrySelect,
        orderBy: { createdAt: 'asc' },
      })
    }),

  create: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(CreateKnowledgeEntryInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      await assertVenueBelongsToTenant(ctx.db, input.venueId, tenantId)

      const entry = await ctx.db.venueKnowledgeEntry.create({
        data: {
          tenantId,
          venueId: input.venueId,
          title: input.title,
          category: input.category,
          content: input.content,
          isEnabled: input.isEnabled,
        },
        select: knowledgeEntrySelect,
      })

      await enqueueKnowledgeEmbedding({ entryId: entry.id, tenantId })

      return entry
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateKnowledgeEntryInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const existing = await ctx.db.venueKnowledgeEntry.findFirst({
        where: { id: input.id, tenantId },
        select: { id: true },
      })

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge entry not found' })
      }

      const { id, ...raw } = input
      const data = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined))

      await ctx.db.venueKnowledgeEntry.updateMany({ where: { id, tenantId }, data })

      const entry = await ctx.db.venueKnowledgeEntry.findFirst({
        where: { id, tenantId },
        select: knowledgeEntrySelect,
      })

      if (!entry) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge entry not found' })
      }

      if (
        input.title !== undefined ||
        input.category !== undefined ||
        input.content !== undefined ||
        input.isEnabled === true
      ) {
        await enqueueKnowledgeEmbedding({ entryId: entry.id, tenantId })
      }

      return entry
    }),

  delete: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const existing = await ctx.db.venueKnowledgeEntry.findFirst({
        where: { id: input.id, tenantId },
        select: { id: true },
      })

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge entry not found' })
      }

      await ctx.db.venueKnowledgeEntry.deleteMany({ where: { id: input.id, tenantId } })

      return { id: input.id }
    }),
})
