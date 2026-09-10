import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { SupportCompletionOutcome, deriveSupportCompletionOutcome } from '@pathfinder/contracts'

import {
  completeSupportRequestAction,
  readSupportPackageFulfillment,
  SupportPackageFulfillmentError,
  requestSupportInformationAction,
  SUPPORT_TRIAGE_MISSING_INFORMATION_ITEM_MAX,
  SUPPORT_TRIAGE_MISSING_INFORMATION_MAX,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  adminSupportScope,
  serializeSupportMessage,
  supportActionError,
} from './support-operations-shared'

const operatorMessageInput = adminSupportScope.extend({
  operationId: z.string().uuid(),
  requestId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  body: z.string().trim().min(1).max(20_000),
})

function operatorActor(userId: string) {
  return {
    actorType: 'HUMAN' as const,
    participantKind: 'OPERATOR' as const,
    actorId: userId,
    auditRole: 'PLATFORM_ADMIN' as const,
  }
}

export const adminSupportManualLoopRouter = router({
  getSupportCompletionPreview: adminProcedure
    .input(
      adminSupportScope.extend({
        requestId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) => {
          const fulfillment = await readSupportPackageFulfillment(tx, {
            tenantId: input.tenantId,
            venueId: input.venueId,
            supportRequestId: input.requestId,
          })
          const request = await tx.supportRequest.findFirst({
            where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
            select: { version: true, status: true, missingInformation: true },
          })
          if (!request)
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request not found.' })
          if (
            request.version !== input.expectedVersion ||
            !['OPEN', 'IN_REVIEW'].includes(request.status) ||
            request.missingInformation.length > 0
          )
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Refresh this request before preparing completion.',
            })
          return {
            outcome: deriveSupportCompletionOutcome(fulfillment),
            fulfillmentDigest: fulfillment.digest,
            expectedVersion: request.version,
          }
        })
      } catch (error) {
        if (error instanceof SupportPackageFulfillmentError)
          throw new TRPCError({ code: 'CONFLICT', message: error.message })
        return supportActionError(error)
      }
    }),
  requestSupportInformation: adminProcedure
    .input(
      operatorMessageInput.extend({
        missingInformation: z
          .array(z.string().trim().min(1).max(SUPPORT_TRIAGE_MISSING_INFORMATION_ITEM_MAX))
          .min(1)
          .max(SUPPORT_TRIAGE_MISSING_INFORMATION_MAX)
          .refine((items) => new Set(items).size === items.length, 'Items must be unique'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await requestSupportInformationAction(
          { ...input, actor: operatorActor(ctx.session.userId) },
          ctx.db,
        )
        return { ...result, message: serializeSupportMessage(result.message) }
      } catch (error) {
        return supportActionError(error)
      }
    }),

  completeSupportRequest: adminProcedure
    .input(
      operatorMessageInput.extend({
        expectedCompletionOutcome: z.enum(SupportCompletionOutcome),
        expectedFulfillmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await completeSupportRequestAction(
          { ...input, actor: operatorActor(ctx.session.userId) },
          ctx.db,
        )
        return { ...result, message: serializeSupportMessage(result.message) }
      } catch (error) {
        return supportActionError(error)
      }
    }),
})
