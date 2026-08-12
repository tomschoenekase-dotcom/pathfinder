import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  bulkCreateLegacyKnowledgeAction,
  createLegacyKnowledgeAction,
  db,
  LegacyContentActionError,
  retireLegacyKnowledgeAction,
  updateLegacyKnowledgeAction,
  type LegacyContentActor,
} from '@pathfinder/db'

import {
  BulkCreateKnowledgeEntriesInput,
  CreateKnowledgeEntryInput,
  UpdateKnowledgeEntryInput,
  RetireKnowledgeEntryInput,
} from '../schemas/knowledge'
import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

export { BulkCreateKnowledgeEntriesInput, CreateKnowledgeEntryInput, UpdateKnowledgeEntryInput }

type Db = typeof db

const BULK_CREATE_LIMIT = 500

function actionActor(session: { userId: string | null; role: string | null }): LegacyContentActor {
  return {
    type: 'HUMAN',
    id: session.userId!,
    role: session.role === 'OWNER' ? 'OWNER' : 'MANAGER',
  }
}
function mapActionError(error: unknown): never {
  if (!(error instanceof LegacyContentActionError)) throw error
  throw new TRPCError({
    code:
      error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.code === 'CONFLICT'
          ? 'CONFLICT'
          : 'BAD_REQUEST',
    message: error.message,
    cause: error,
  })
}

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

      try {
        return await createLegacyKnowledgeAction(
          {
            tenantId,
            venueId: input.venueId,
            actor: actionActor(ctx.session),
            fields: {
              title: input.title,
              category: input.category,
              content: input.content,
              isEnabled: input.isEnabled,
            },
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
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

      try {
        const entries = await bulkCreateLegacyKnowledgeAction(
          {
            tenantId,
            venueId: input.venueId,
            actor: actionActor(ctx.session),
            entries: input.entries.map((entry) => ({
              title: entry.title,
              category: entry.category,
              content: entry.content,
              isEnabled: entry.isEnabled,
            })),
          },
          ctx.db,
        )
        return { count: entries.length, entries }
      } catch (error) {
        mapActionError(error)
      }
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateKnowledgeEntryInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const { id, venueId, expectedUpdatedAt, ...raw } = input
      const data = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined))

      try {
        return await updateLegacyKnowledgeAction(
          {
            tenantId,
            venueId,
            id,
            expectedUpdatedAt,
            actor: actionActor(ctx.session),
            fields: data,
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
    }),

  delete: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(RetireKnowledgeEntryInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      try {
        await retireLegacyKnowledgeAction(
          { ...input, tenantId, actor: actionActor(ctx.session) },
          ctx.db,
        )
        return { id: input.id }
      } catch (error) {
        mapActionError(error)
      }
    }),
})
