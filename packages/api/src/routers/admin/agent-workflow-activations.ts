import { z } from 'zod'
import { AgentWorkflowCanaryPolicySchema } from '@pathfinder/contracts/agent-workflow-activation'
import {
  activateAgentWorkflowVersion,
  requestAgentWorkflowActivationApproval,
  requestAgentWorkflowTransitionApproval,
  transitionAgentWorkflowActivation,
} from '@pathfinder/db'
import { mergeRouters, router } from '../../core'
import { adminProcedure } from '../../trpc'
import { adminAgentWorkflowActivationReadsRouter } from './agent-workflow-activation-reads'
import { authorized, capabilities, common, scope } from './agent-workflow-activation-shared'

const adminAgentWorkflowActivationMutationsRouter = router({
  requestAgentWorkflowActivationApproval: adminProcedure
    .input(
      scope
        .extend({
          ...common,
          agentIdentityId: z.string().min(1).max(191),
          workflowVersionId: z.string().uuid(),
          promotionAssessmentId: z.string().min(1).max(191),
          canaryPolicy: AgentWorkflowCanaryPolicySchema,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) => {
      const { operationId, ...request } = input
      return authorized(input, () =>
        requestAgentWorkflowActivationApproval(
          {
            ...request,
            requestOperationId: operationId,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          },
          capabilities(),
        ),
      )
    }),
  applyAgentWorkflowActivation: adminProcedure
    .input(
      scope
        .extend({
          ...common,
          workflowVersionId: z.string().uuid(),
          promotionAssessmentId: z.string().min(1).max(191),
          approvalDecisionId: z.string().min(1).max(191),
          canaryPolicy: AgentWorkflowCanaryPolicySchema,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      authorized(input, () =>
        activateAgentWorkflowVersion(
          { ...input, actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' } },
          capabilities(),
        ),
      ),
    ),
  requestAgentWorkflowTransitionApproval: adminProcedure
    .input(
      scope
        .extend({
          ...common,
          agentIdentityId: z.string().min(1).max(191),
          kind: z.enum(['ROLLBACK', 'REVOKE']),
          workflowVersionId: z.string().uuid().optional(),
          canaryPolicy: AgentWorkflowCanaryPolicySchema.optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) => {
      const { operationId, ...request } = input
      return authorized(input, () =>
        requestAgentWorkflowTransitionApproval(
          {
            ...request,
            requestOperationId: operationId,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          },
          capabilities(),
        ),
      )
    }),
  applyAgentWorkflowTransition: adminProcedure
    .input(
      scope
        .extend({
          ...common,
          kind: z.enum(['ROLLBACK', 'REVOKE']),
          workflowVersionId: z.string().uuid().optional(),
          canaryPolicy: AgentWorkflowCanaryPolicySchema.optional(),
          approvalDecisionId: z.string().min(1).max(191),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      authorized(input, () =>
        transitionAgentWorkflowActivation(
          { ...input, actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' } },
          capabilities(),
        ),
      ),
    ),
})

export const adminAgentWorkflowActivationsRouter = mergeRouters(
  adminAgentWorkflowActivationMutationsRouter,
  adminAgentWorkflowActivationReadsRouter,
)
