import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  AgentOutcomeActionError,
  AgentImprovementProposalActionError,
  AgentImprovementValidationActionError,
  db,
  prepareAgentImprovementProposalAction,
  recordAgentImprovementValidationAction,
  recordAgentOutcomeAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { mergeRouters, router } from '../../core'
import { adminProcedure } from '../../trpc'
import { createdBefore, pageInput, pageResult, tenantScopeInput } from './agent-operations-shared'
import { adminAgentTrustSignalsRouter } from './agent-trust-signals'

const adminAgentOutcomeCoreRouter = router({
  listAgentImprovementProposals: adminProcedure
    .input(
      tenantScopeInput.merge(pageInput).extend({
        agentIdentityId: z.string().min(1).optional(),
        taskClass: z.string().trim().min(1).max(100).optional(),
        targetKind: z
          .enum([
            'INSTRUCTIONS',
            'ROUTING',
            'RETRIEVAL',
            'SKILL',
            'WORKFLOW',
            'TOOLING',
            'MODEL_SELECTION',
          ])
          .optional(),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const rows = await db.agentImprovementProposal.findMany({
          where: {
            tenantId: input.tenantId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
            ...(input.agentIdentityId ? { agentIdentityId: input.agentIdentityId } : {}),
            ...(input.taskClass ? { taskClass: input.taskClass } : {}),
            ...(input.targetKind ? { targetKind: input.targetKind } : {}),
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            venueId: true,
            agentIdentityId: true,
            approvalRequestId: true,
            proposalKey: true,
            revision: true,
            supersedesProposalId: true,
            taskClass: true,
            targetKind: true,
            title: true,
            hypothesis: true,
            proposedChange: true,
            validationPlan: true,
            baselineSnapshot: true,
            createdByType: true,
            createdById: true,
            createdAt: true,
            agentIdentity: { select: { id: true, name: true } },
            approvalRequest: {
              select: {
                riskCategory: true,
                decision: {
                  select: { decision: true, decidedById: true, reason: true, createdAt: true },
                },
              },
            },
            evidence: {
              orderBy: { outcomeObservation: { createdAt: 'desc' } },
              select: {
                outcomeObservation: {
                  select: {
                    id: true,
                    agentRunId: true,
                    signalKind: true,
                    verdict: true,
                    summary: true,
                    evidenceRef: true,
                    modelProvider: true,
                    modelName: true,
                    createdAt: true,
                  },
                },
              },
            },
            validationEvidence: {
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: {
                id: true,
                approvalDecisionId: true,
                baselineEvalRunId: true,
                candidateEvalRunId: true,
                implementationKind: true,
                implementationRef: true,
                implementationVersion: true,
                implementationHash: true,
                changeDimensions: true,
                comparisonSnapshot: true,
                comparisonHash: true,
                recordedByType: true,
                recordedById: true,
                createdAt: true,
              },
            },
          },
        })
        return pageResult(rows, input.limit)
      }),
    ),

  listAgentOutcomeObservations: adminProcedure
    .input(
      tenantScopeInput.merge(pageInput).extend({
        agentRunId: z.string().min(1).optional(),
        agentIdentityId: z.string().min(1).optional(),
        signalKind: z
          .enum([
            'HUMAN_REVIEW',
            'BUSINESS_OUTCOME',
            'QUALITY_EVALUATION',
            'CUSTOMER_SIGNAL',
            'SYSTEM_OBSERVATION',
            'ROLLBACK',
            'POLICY_VIOLATION',
            'CONFIDENCE_CALIBRATION',
          ])
          .optional(),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const rows = await db.agentOutcomeObservation.findMany({
          where: {
            tenantId: input.tenantId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
            ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
            ...(input.agentIdentityId ? { agentIdentityId: input.agentIdentityId } : {}),
            ...(input.signalKind ? { signalKind: input.signalKind } : {}),
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            venueId: true,
            agentRunId: true,
            agentIdentityId: true,
            signalKind: true,
            verdict: true,
            summary: true,
            evidenceRef: true,
            relatedAgentActionId: true,
            policyCode: true,
            severity: true,
            predictionRef: true,
            predictedConfidenceBps: true,
            actualCorrect: true,
            taskClass: true,
            modelProvider: true,
            modelName: true,
            actorType: true,
            actorId: true,
            createdAt: true,
            agentIdentity: { select: { id: true, name: true } },
          },
        })
        return pageResult(rows, input.limit)
      }),
    ),

  recordAgentRunOutcome: adminProcedure
    .input(
      z.object({
        operationId: z.string().uuid(),
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        agentRunId: z.string().min(1),
        verdict: z.enum(['POSITIVE', 'MIXED', 'NEGATIVE', 'INCONCLUSIVE']),
        summary: z.string().trim().min(1).max(2000),
        evidenceRef: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await recordAgentOutcomeAction(
            {
              ...input,
              actor: {
                type: 'HUMAN',
                id: ctx.session.userId,
                role: 'PLATFORM_ADMIN',
              },
            },
            db,
          )
        } catch (error) {
          if (error instanceof AgentOutcomeActionError) {
            throw new TRPCError({
              code:
                error.code === 'INVALID_INPUT'
                  ? 'BAD_REQUEST'
                  : error.code === 'NOT_FOUND'
                    ? 'NOT_FOUND'
                    : 'CONFLICT',
              message: error.message,
            })
          }
          throw error
        }
      }),
    ),

  prepareAgentImprovementProposal: adminProcedure
    .input(
      z.object({
        operationId: z.string().uuid(),
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        agentIdentityId: z.string().min(1),
        outcomeObservationIds: z.array(z.string().min(1)).min(1).max(50),
        proposalKey: z.string().trim().min(1).max(191),
        revision: z.number().int().min(1),
        supersedesProposalId: z.string().min(1).optional(),
        targetKind: z.enum([
          'INSTRUCTIONS',
          'ROUTING',
          'RETRIEVAL',
          'SKILL',
          'WORKFLOW',
          'TOOLING',
          'MODEL_SELECTION',
        ]),
        title: z.string().trim().min(3).max(191),
        hypothesis: z.string().trim().min(10).max(2000),
        proposedChange: z.string().trim().min(10).max(10000),
        validationPlan: z.string().trim().min(10).max(5000),
      }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await prepareAgentImprovementProposalAction(
            {
              ...input,
              actor: {
                type: 'HUMAN',
                id: ctx.session.userId,
                role: 'PLATFORM_ADMIN',
              },
            },
            db,
          )
        } catch (error) {
          if (error instanceof AgentImprovementProposalActionError) {
            throw new TRPCError({
              code:
                error.code === 'INVALID_INPUT'
                  ? 'BAD_REQUEST'
                  : error.code === 'NOT_FOUND'
                    ? 'NOT_FOUND'
                    : 'CONFLICT',
              message: error.message,
            })
          }
          throw error
        }
      }),
    ),

  recordAgentImprovementValidation: adminProcedure
    .input(
      z.object({
        operationId: z.string().uuid(),
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        proposalId: z.string().min(1),
        baselineEvalRunId: z.string().uuid(),
        candidateEvalRunId: z.string().uuid(),
        implementationKind: z.enum([
          'CODE_COMMIT',
          'CONFIG_VERSION',
          'PROMPT_VERSION',
          'SKILL_VERSION',
          'WORKFLOW_VERSION',
          'TOOL_VERSION',
          'MODEL_POLICY_VERSION',
        ]),
        implementationRef: z.string().trim().min(1).max(500),
        implementationVersion: z.string().trim().min(1).max(191).optional(),
        implementationHash: z.string().regex(/^[0-9a-f]{64}$/),
        changeDimensions: z
          .array(z.enum(['CONTENT', 'MODEL', 'CONFIG']))
          .min(1)
          .max(3),
      }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await recordAgentImprovementValidationAction(
            {
              ...input,
              actor: {
                type: 'HUMAN',
                id: ctx.session.userId,
                role: 'PLATFORM_ADMIN',
              },
            },
            db,
          )
        } catch (error) {
          if (error instanceof AgentImprovementValidationActionError) {
            throw new TRPCError({
              code:
                error.code === 'INVALID_INPUT'
                  ? 'BAD_REQUEST'
                  : error.code === 'NOT_FOUND'
                    ? 'NOT_FOUND'
                    : 'CONFLICT',
              message: error.message,
            })
          }
          throw error
        }
      }),
    ),
})

export const adminAgentOutcomesRouter = mergeRouters(
  adminAgentOutcomeCoreRouter,
  adminAgentTrustSignalsRouter,
)
