import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db } from '@pathfinder/db'

import {
  BulkCreateKnowledgeEntriesInput,
  CreateKnowledgeEntryInput,
  UpdateKnowledgeEntryInput,
} from '../schemas/knowledge'
import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

export { BulkCreateKnowledgeEntriesInput, CreateKnowledgeEntryInput, UpdateKnowledgeEntryInput }

type Db = typeof db

const BULK_CREATE_LIMIT = 500

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

      return entry
    }),

  bulkCreate: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(BulkCreateKnowledgeEntriesInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      if (input.entries.length > BULK_CREATE_LIMIT) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Bulk create limit is ${BULK_CREATE_LIMIT} knowledge entries`,
        })
      }

      await assertVenueBelongsToTenant(ctx.db, input.venueId, tenantId)

      const entries = await ctx.db.$transaction(
        input.entries.map((entry) =>
          ctx.db.venueKnowledgeEntry.create({
            data: {
              tenantId,
              venueId: input.venueId,
              title: entry.title,
              category: entry.category,
              content: entry.content,
              isEnabled: entry.isEnabled,
            },
            select: knowledgeEntrySelect,
          }),
        ),
      )

      return { count: entries.length, entries }
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
