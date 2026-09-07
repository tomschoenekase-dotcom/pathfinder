import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { AgentWorkflowCanaryPolicySchema } from '@pathfinder/contracts/agent-workflow-activation'
import {
  activateAgentWorkflowVersion,
  AgentWorkflowActivationError,
  isVenueUnavailableError,
  assertVenueAvailable,
  db,
  requestAgentWorkflowActivationApproval,
  requestAgentWorkflowTransitionApproval,
  transitionAgentWorkflowActivation,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { router } from '../../core'
import { createSafeOperationalMcpRegistry } from '../../mcp/composition'
import { adminProcedure } from '../../trpc'

const scope = z
  .object({ tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) })
  .strict()
const common = {
  operationId: z.string().uuid(),
  registryKey: z.string().min(1).max(191),
  expectedHeadRevision: z.number().int().min(0),
  reason: z.string().trim().min(1).max(2000),
}
const capabilities = () =>
  new Set(
    createSafeOperationalMcpRegistry()
      .listTools()
      .map((t) => t._meta['com.pathfinder/security'].capability),
  )
const mapped = (error: unknown): never => {
  if (error instanceof TRPCError) throw error
  if (error instanceof AgentWorkflowActivationError) {
    throw new TRPCError({
      code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
      message: error.message,
    })
  }
  if (error instanceof z.ZodError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid workflow transition input' })
  if (isVenueUnavailableError(error))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue is unavailable' })
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Workflow activation could not be completed',
  })
}
const authorized = async <T>(
  input: { tenantId: string; venueId: string },
  fn: () => Promise<T>,
) => {
  try {
    await assertVenueAvailable(db, input)
    return await withTenantIsolationBypass(() => fn())
  } catch (error) {
    return mapped(error)
  }
}

export const adminAgentWorkflowActivationsRouter = router({
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
  listAgentWorkflowActivations: adminProcedure
    .input(
      scope
        .extend({
          registryKey: z.string().min(1).max(191).optional(),
          limit: z.number().int().min(1).max(50).default(20),
          headAfterRegistryKey: z.string().min(1).max(191).optional(),
          eventBefore: z
            .object({ id: z.string().uuid(), createdAt: z.string().datetime({ offset: true }) })
            .strict()
            .optional(),
        })
        .strict(),
    )
    .query(({ input }) =>
      authorized(input, async () => {
        const heads = await db.agentWorkflowActivationHead.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(input.registryKey ? { registryKey: input.registryKey } : {}),
            ...(input.headAfterRegistryKey
              ? { AND: [{ registryKey: { gt: input.headAfterRegistryKey } }] }
              : {}),
          },
          select: {
            registryKey: true,
            revision: true,
            selectedRunCount: true,
            activeVersion: {
              select: {
                id: true,
                version: true,
                contentHash: true,
                requiredToolCapabilities: true,
              },
            },
            activationEvent: {
              select: {
                id: true,
                kind: true,
                eventHash: true,
                reason: true,
                createdBy: true,
                createdAt: true,
                approvalDecisionId: true,
                promotionAssessmentId: true,
              },
            },
          },
          orderBy: { registryKey: 'asc' },
          take: input.limit + 1,
        })
        const events = await db.agentWorkflowActivationEvent.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(input.registryKey ? { registryKey: input.registryKey } : {}),
            ...(input.eventBefore
              ? {
                  OR: [
                    { createdAt: { lt: new Date(input.eventBefore.createdAt) } },
                    {
                      createdAt: new Date(input.eventBefore.createdAt),
                      id: { lt: input.eventBefore.id },
                    },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            registryKey: true,
            kind: true,
            priorVersionId: true,
            resultingVersionId: true,
            priorRevision: true,
            resultingRevision: true,
            eventHash: true,
            reason: true,
            createdBy: true,
            createdAt: true,
            approvalDecisionId: true,
            promotionAssessmentId: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
        })
        const headPage = heads.slice(0, input.limit)
        const eventPage = events.slice(0, input.limit)
        const lastHead = headPage.at(-1)
        const lastEvent = eventPage.at(-1)
        return {
          heads: headPage,
          events: eventPage,
          nextHeadAfterRegistryKey:
            heads.length > input.limit && lastHead ? lastHead.registryKey : null,
          nextEventBefore:
            events.length > input.limit && lastEvent
              ? { id: lastEvent.id, createdAt: lastEvent.createdAt.toISOString() }
              : null,
        }
      }),
    ),
})
