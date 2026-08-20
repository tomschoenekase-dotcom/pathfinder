import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { env } from '@pathfinder/config'

import {
  AgentQuestionActionError,
  OnboardingQuestionActionError,
  answerAgentQuestionAction,
  createClientOnboardingQuestionAction,
  db,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { enqueueAgentRun } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { createdBefore, pageInput, pageResult, tenantScopeInput } from './agent-operations-shared'

export const adminAgentQuestionsRouter = router({
  listOnboardingQuestionRecipients: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        return db.tenantMembership.findMany({
          where: { tenantId: input.tenantId, status: 'ACTIVE' },
          orderBy: [{ role: 'desc' }, { userId: 'asc' }],
          select: {
            userId: true,
            role: true,
            user: { select: { fullName: true, email: true } },
          },
        })
      }),
    ),

  listAgentQuestions: adminProcedure
    .input(
      tenantScopeInput.merge(pageInput).extend({
        status: z
          .enum(['PENDING', 'ANSWERED', 'DISMISSED', 'EXPIRED', 'CANCELLED', 'ALL'])
          .default('PENDING'),
        agentIdentityId: z.string().min(1).optional(),
        agentRunId: z.string().min(1).optional(),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const rows = await db.agentQuestion.findMany({
          where: {
            tenantId: input.tenantId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
            ...(input.status === 'ALL' ? {} : { status: input.status }),
            ...(input.agentIdentityId ? { agentIdentityId: input.agentIdentityId } : {}),
            ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            agentIdentityId: true,
            agentRunId: true,
            question: true,
            context: true,
            questionType: true,
            category: true,
            urgency: true,
            choices: true,
            dueAt: true,
            evidence: true,
            proposedAnswer: true,
            callbackMetadata: true,
            blocking: true,
            status: true,
            answer: true,
            answeredAt: true,
            createdAt: true,
            updatedAt: true,
            agentIdentity: { select: { id: true, name: true } },
          },
        })
        return pageResult(rows, input.limit)
      }),
    ),

  answerAgentQuestion: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        questionId: z.string().min(1),
        expectedUpdatedAt: z.string().datetime(),
        outcome: z.enum(['ANSWERED', 'DISMISSED']),
        answer: z.string().trim().min(1).max(5000),
      }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          const response = await answerAgentQuestionAction(
            {
              tenantId: input.tenantId,
              venueId: input.venueId,
              questionId: input.questionId,
              expectedUpdatedAt: new Date(input.expectedUpdatedAt),
              outcome: input.outcome,
              answer: input.answer,
              actor: {
                actorType: 'HUMAN',
                actorId: ctx.session.userId,
                auditRole: 'PLATFORM_ADMIN',
              },
            },
            db,
          )
          const dispatch =
            response.runEligibleToResume && response.agentRunId
              ? await enqueueAgentRun(
                  { tenantId: input.tenantId, runId: response.agentRunId },
                  {
                    enabled: env.AGENT_RUNNER_ENABLED,
                    dispatchKey: `answer-${response.questionId}`,
                  },
                )
              : { enqueued: false }
          return { ...response, executionTriggered: dispatch.enqueued }
        } catch (error) {
          if (error instanceof AgentQuestionActionError) {
            throw new TRPCError({
              code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
              message: error.message,
            })
          }
          throw error
        }
      }),
    ),

  routeAgentQuestionToClient: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          questionId: z.string().min(1),
          expectedUpdatedAt: z.string().datetime(),
          recipientUserId: z.string().min(1),
          category: z
            .enum([
              'CONTENT_CORRECTION',
              'OPERATIONAL_UPDATE',
              'BRANDING',
              'EXPERIENCE_BEHAVIOR',
              'ACCESSIBILITY',
              'GENERAL',
            ])
            .default('GENERAL'),
          subject: z.string().trim().min(1).max(200),
          why: z.string().trim().min(1).max(2000),
          whatWasFound: z.string().trim().min(1).max(2000).optional(),
          effect: z.string().trim().min(1).max(1000),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await createClientOnboardingQuestionAction(
            {
              operationId: input.operationId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              agentQuestionId: input.questionId,
              expectedQuestionUpdatedAt: new Date(input.expectedUpdatedAt),
              recipientUserId: input.recipientUserId,
              category: input.category,
              subject: input.subject,
              why: input.why,
              ...(input.whatWasFound ? { whatWasFound: input.whatWasFound } : {}),
              effect: input.effect,
              actor: { actorId: ctx.session.userId, auditRole: 'PLATFORM_ADMIN' },
            },
            db,
          )
        } catch (error) {
          if (error instanceof OnboardingQuestionActionError)
            throw new TRPCError({
              code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
              message: error.message,
            })
          throw error
        }
      }),
    ),
})
