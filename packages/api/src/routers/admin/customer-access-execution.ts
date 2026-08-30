import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { CustomerAccessExecutionError, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { executeApprovedCustomerInvitation } from '../../lib/customer-access-executor'
import { adminProcedure } from '../../trpc'

function mapExecutionError(error: unknown): never {
  if (error instanceof CustomerAccessExecutionError) {
    const code =
      error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.code === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'BAD_REQUEST'
    throw new TRPCError({ code, message: error.message, cause: error })
  }
  throw error
}

export const adminCustomerAccessExecutionRouter = router({
  executeApprovedCustomerInvitation: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().trim().min(1).max(191),
          venueId: z.string().trim().min(1).max(191),
          requestId: z.string().trim().min(1).max(191),
          expectedUpdatedAt: z.coerce.date(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          executeApprovedCustomerInvitation({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          }),
        )
      } catch (error) {
        mapExecutionError(error)
      }
    }),
})
