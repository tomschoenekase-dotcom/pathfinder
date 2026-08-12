import { z } from 'zod'

import {
  completeSupportRequestAction,
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
    .input(operatorMessageInput)
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
