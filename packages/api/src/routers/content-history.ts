import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  ContentHistoryActionError,
  contentHistoryVersionSelect,
  revertContentHistoryAction,
} from '@pathfinder/db'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

const EntityType = z.enum(['VENUE', 'PLACE', 'KNOWLEDGE_ENTRY', 'OPERATIONAL_UPDATE'])

function mapActionError(error: unknown): never {
  if (error instanceof ContentHistoryActionError) {
    throw new TRPCError({ code: error.code, message: error.message, cause: error })
  }
  throw error
}

export const contentHistoryRouter = router({
  list: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          entityType: EntityType,
          entityId: z.string().min(1),
          limit: z.number().int().min(1).max(100).default(50),
          beforeSequence: z.bigint().positive().optional(),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      ctx.db.contentVersion.findMany({
        where: {
          tenantId: ctx.session.activeTenantId,
          entityType: input.entityType,
          entityId: input.entityId,
          ...(input.beforeSequence !== undefined ? { sequence: { lt: input.beforeSequence } } : {}),
        },
        select: contentHistoryVersionSelect,
        orderBy: { sequence: 'desc' },
        take: input.limit,
      }),
    ),

  listForVenue: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          venueId: z.string().min(1),
          limit: z.number().int().min(1).max(100).default(50),
          beforeSequence: z.bigint().positive().optional(),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      ctx.db.contentVersion.findMany({
        where: {
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          ...(input.beforeSequence !== undefined ? { sequence: { lt: input.beforeSequence } } : {}),
        },
        select: contentHistoryVersionSelect,
        orderBy: { sequence: 'desc' },
        take: input.limit,
      }),
    ),

  listDeletedVenues: tenantProcedure
    .use(requireRole('OWNER'))
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(50),
          beforeSequence: z.bigint().positive().optional(),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      ctx.db.contentVersion.findMany({
        where: {
          tenantId: ctx.session.activeTenantId,
          entityType: 'VENUE',
          ...(input.beforeSequence !== undefined ? { sequence: { lt: input.beforeSequence } } : {}),
        },
        select: contentHistoryVersionSelect,
        orderBy: { sequence: 'desc' },
        take: input.limit,
      }),
    ),

  revert: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          versionId: z.string().uuid(),
          expectedCurrentVersionId: z.string().uuid(),
          snapshotSide: z.enum(['BEFORE', 'AFTER']).default('AFTER'),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await revertContentHistoryAction(
          {
            tenantId: ctx.session.activeTenantId,
            versionId: input.versionId,
            expectedCurrentVersionId: input.expectedCurrentVersionId,
            snapshotSide: input.snapshotSide,
            actor: {
              type: 'HUMAN',
              id: ctx.session.userId,
              role: ctx.session.role as 'OWNER' | 'MANAGER',
            },
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
    }),
})
