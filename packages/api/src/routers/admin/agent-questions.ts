import { createHash } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { env } from '@pathfinder/config'
import { logger } from '@pathfinder/config/logger'

import {
  AgentQuestionActionError,
  AgentQuestionDiscussionActionError,
  FounderDecisionPacketActionError,
  applyFounderDecisionPacketAction,
  answerAgentQuestionAction,
  appendAgentQuestionDiscussionAction,
  createCompanyKnowledgeCandidateAction,
  db,
  promoteCompanyKnowledgeAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { enqueueAgentRun } from '@pathfinder/jobs'

import { mergeRouters, router } from '../../core'
import { adminProcedure } from '../../trpc'
import { createdBefore, pageInput, pageResult, tenantScopeInput } from './agent-operations-shared'
import { adminAgentQuestionClientRoutingRouter } from './agent-question-client-routing'

const adminAgentQuestionCoreRouter = router({
  listAgentQuestionDiscussion: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        questionId: z.string().min(1),
        cursor: pageInput.shape.cursor,
        limit: z.number().int().min(1).max(50).default(20),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const question = await db.agentQuestion.findFirst({
          where: { id: input.questionId, tenantId: input.tenantId, venueId: input.venueId },
          select: { id: true },
        })
        if (!question)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent question not found' })
        const rows = await db.agentQuestionDiscussionMessage.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            questionId: input.questionId,
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: { id: true, authorId: true, body: true, createdAt: true },
        })
        return pageResult(rows, input.limit)
      }),
    ),

  appendAgentQuestionDiscussion: adminProcedure
    .input(
      z.object({
        operationId: z.string().uuid(),
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        questionId: z.string().min(1),
        body: z.string().trim().min(1).max(5000),
      }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          const result = await appendAgentQuestionDiscussionAction(
            {
              ...input,
              actor: {
                actorType: 'HUMAN',
                actorId: ctx.session.userId,
                auditRole: 'PLATFORM_ADMIN',
              },
            },
            db,
          )
          return {
            message: {
              id: result.message.id,
              authorId: result.message.authorId,
              body: result.message.body,
              createdAt: result.message.createdAt,
            },
            replayed: result.replayed,
          }
        } catch (error) {
          if (error instanceof AgentQuestionDiscussionActionError) {
            throw new TRPCError({
              code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
              message: error.message,
            })
          }
          throw error
        }
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
            expiresAt: true,
            expiredAt: true,
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
          let dispatchStatus: 'NOT_NEEDED' | 'DISABLED' | 'ENQUEUED' | 'UNCONFIRMED' = 'NOT_NEEDED'
          if (response.runEligibleToResume && response.agentRunId) {
            dispatchStatus = 'DISABLED'
            if (env.AGENT_RUNNER_ENABLED) {
              try {
                const dispatch = await enqueueAgentRun(
                  { tenantId: input.tenantId, runId: response.agentRunId },
                  { enabled: true, dispatchKey: `answer-${response.questionId}` },
                )
                dispatchStatus = dispatch.enqueued ? 'ENQUEUED' : 'UNCONFIRMED'
              } catch {
                // The answer transaction has already committed. A lost queue acknowledgement
                // must not turn that durable response into an apparent persistence failure.
                // Exact answer replay rechecks run eligibility and uses the same queue job ID.
                dispatchStatus = 'UNCONFIRMED'
                logger.warn({
                  action: 'admin.agent-question.resume-dispatch.unconfirmed',
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  questionId: response.questionId,
                  agentRunId: response.agentRunId,
                })
              }
            }
          }
          return { ...response, executionTriggered: dispatchStatus === 'ENQUEUED', dispatchStatus }
        } catch (error) {
          if (error instanceof AgentQuestionActionError) {
            throw new TRPCError({
              code:
                error.code === 'EXPIRED'
                  ? 'PRECONDITION_FAILED'
                  : error.code === 'INVALID_INPUT'
                    ? 'BAD_REQUEST'
                    : error.code,
              message: error.message,
            })
          }
          throw error
        }
      }),
    ),

  promoteAgentAnswer: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          questionId: z.string().min(1),
          classification: z.enum([
            'ACCOUNT_CONTEXT',
            'DURABLE_PREFERENCE',
            'REUSABLE_POLICY',
            'STRATEGIC_DECISION',
          ]),
          organizationId: z.string().min(1).optional(),
          title: z.string().trim().min(1).max(500),
          summary: z.string().trim().min(1).max(4000),
          rationale: z.string().trim().min(1).max(10_000).optional(),
          affectedSystems: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
        })
        .superRefine((value, refinement) => {
          if (
            ['ACCOUNT_CONTEXT', 'DURABLE_PREFERENCE'].includes(value.classification) &&
            !value.organizationId
          ) {
            refinement.addIssue({
              code: 'custom',
              path: ['organizationId'],
              message: 'Account and preference promotion requires an organization.',
            })
          }
          if (
            ['REUSABLE_POLICY', 'STRATEGIC_DECISION'].includes(value.classification) &&
            !value.rationale
          ) {
            refinement.addIssue({
              code: 'custom',
              path: ['rationale'],
              message: 'Policy and decision promotion requires rationale.',
            })
          }
        }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const question = await db.agentQuestion.findFirst({
          where: {
            id: input.questionId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: 'ANSWERED',
          },
          select: { id: true, question: true, answer: true, agentRunId: true },
        })
        if (!question?.answer) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Only a durable answered question may be promoted.',
          })
        }
        const actor = {
          type: 'HUMAN' as const,
          actorId: ctx.session.userId,
          role: 'PLATFORM_ADMIN',
        }
        const authoritative = ['REUSABLE_POLICY', 'STRATEGIC_DECISION'].includes(
          input.classification,
        )
        const accountScoped = ['ACCOUNT_CONTEXT', 'DURABLE_PREFERENCE'].includes(
          input.classification,
        )
        const type =
          input.classification === 'STRATEGIC_DECISION'
            ? ('DECISION' as const)
            : input.classification === 'REUSABLE_POLICY'
              ? ('POLICY_CONTEXT' as const)
              : ('CLIENT_INSIGHT' as const)
        const candidate = await createCompanyKnowledgeCandidateAction(
          {
            tenantId: input.tenantId,
            ...(accountScoped ? { venueId: input.venueId } : {}),
            ...(input.organizationId ? { organizationId: input.organizationId } : {}),
            type,
            title: input.title,
            summary: input.summary,
            body: question.answer,
            structuredData: {
              classification: input.classification,
              question: question.question,
              answer: question.answer,
            },
            accessScope: accountScoped ? 'ORGANIZATION' : 'TENANT',
            authority: authoritative ? 'AUTHORITATIVE_CURRENT' : 'DURABLE_CONTEXT',
            sourceType: 'AGENT_RUN',
            sourceId: question.agentRunId ?? question.id,
            sourceRef: `agent-question:${question.id}`,
            idempotencyKey: `agent-answer:${question.id}:${input.classification}`,
            ...(input.classification === 'STRATEGIC_DECISION'
              ? {
                  decision: {
                    status: 'ACTIVE' as const,
                    decision: question.answer,
                    rationale: input.rationale!,
                    scope: { tenantId: input.tenantId },
                    affectedSystems: input.affectedSystems,
                    effectiveAt: new Date(),
                  },
                }
              : {}),
            actor,
          },
          db,
        )
        const promoted = await promoteCompanyKnowledgeAction(
          {
            knowledgeItemId: candidate.id,
            tenantId: input.tenantId,
            promotionReason: `Human classified answered agent question as ${input.classification}.`,
            actor,
          },
          db,
        )
        return {
          schemaVersion: 'agent-answer-promotion.v1',
          classification: input.classification,
          knowledgeItemId: promoted.id,
          replayed: candidate.replayed && promoted.replayed,
        }
      }),
    ),

  promoteAgentAnswerToFounderDecision: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          questionId: z.string().min(1),
          decisionKey: z
            .string()
            .trim()
            .min(1)
            .max(100)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
          title: z.string().trim().min(1).max(500),
          summary: z.string().trim().min(1).max(4000),
          rationale: z.string().trim().min(1).max(10_000),
          affectedSystems: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
          scope: z.record(
            z.string().trim().min(1).max(100),
            z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]),
          ),
        })
        .strict()
        .superRefine((value, refinement) => {
          if (Object.keys(value.scope).length === 0) {
            refinement.addIssue({
              code: 'custom',
              path: ['scope'],
              message: 'Founder decision promotion requires an explicit policy scope.',
            })
          }
        }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const question = await db.agentQuestion.findFirst({
          where: {
            id: input.questionId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: 'ANSWERED',
          },
          select: {
            id: true,
            question: true,
            answer: true,
            answeredAt: true,
            answeredById: true,
            agentRunId: true,
          },
        })
        if (!question?.answer || !question.answeredAt || !question.answeredById) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Only a durable human-answered question may become founder policy.',
          })
        }
        if (question.answeredById !== ctx.session.userId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Founder policy promotion requires the administrator who supplied the answer.',
          })
        }
        const packetId = `agent-question-${createHash('sha256')
          .update(question.id)
          .digest('hex')
          .slice(0, 32)}`
        try {
          const result = await applyFounderDecisionPacketAction(
            {
              packet: {
                schemaVersion: 'founder-decision-packet.v1',
                packetId,
                title: `Founder answer: ${input.title}`,
                effectiveAt: question.answeredAt.toISOString(),
                sourceRef: `agent-question:${question.id}`,
                decisions: [
                  {
                    key: input.decisionKey,
                    title: input.title,
                    summary: input.summary,
                    decision: question.answer,
                    rationale: input.rationale,
                    affectedSystems: input.affectedSystems,
                    scope: input.scope,
                  },
                ],
              },
              actor: {
                type: 'HUMAN',
                actorId: ctx.session.userId,
                role: 'PLATFORM_ADMIN',
              },
            },
            db,
          )
          const promoted = result.results[0]!
          return {
            schemaVersion: 'agent-answer-founder-decision-promotion.v1' as const,
            decisionKey: promoted.key,
            knowledgeItemId: promoted.knowledgeItemId,
            state: promoted.state,
            supersededKnowledgeItemId: promoted.supersededKnowledgeItemId,
            source: {
              questionId: question.id,
              agentRunId: question.agentRunId,
              answeredById: question.answeredById,
              answeredAt: question.answeredAt.toISOString(),
            },
          }
        } catch (error) {
          if (error instanceof FounderDecisionPacketActionError) {
            throw new TRPCError({
              code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
              message: error.message,
            })
          }
          throw error
        }
      }),
    ),
})

export const adminAgentQuestionsRouter = mergeRouters(
  adminAgentQuestionCoreRouter,
  adminAgentQuestionClientRoutingRouter,
)
