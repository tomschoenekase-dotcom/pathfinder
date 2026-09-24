import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminProspectCrmThreadReadRouter = router({
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
