import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  AgentWorkflowPromotionAssessmentError,
  createAgentWorkflowPromotionAssessment,
  db,
  readAgentWorkflowPromotionAssessments,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'

function mapped(error: unknown): never {
  if (error instanceof AgentWorkflowPromotionAssessmentError)
    throw new TRPCError({
      code:
        error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'CONFLICT',
      message: error.message,
    })
  throw error
}

export const adminAgentWorkflowPromotionAssessmentsRouter = router({
  createAgentWorkflowPromotionAssessment: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1).max(191),
          venueId: z.string().min(1).max(191),
          workflowVersionId: z.string().uuid(),
          proposalId: z.string().min(1).max(191),
          developmentValidationId: z.string().min(1).max(191),
          heldoutValidationId: z.string().min(1).max(191),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await createAgentWorkflowPromotionAssessment(
            { ...input, actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' } },
            db,
          )
        } catch (error) {
          mapped(error)
        }
      }),
    ),
  listAgentWorkflowPromotionAssessments: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1).max(191),
          venueId: z.string().min(1).max(191),
          workflowVersionId: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(() =>
        readAgentWorkflowPromotionAssessments(
          {
            tenantId: input.tenantId,
            venueId: input.venueId,
            limit: input.limit,
            ...(input.workflowVersionId ? { workflowVersionId: input.workflowVersionId } : {}),
          },
          db,
        ),
      ),
    ),
})
