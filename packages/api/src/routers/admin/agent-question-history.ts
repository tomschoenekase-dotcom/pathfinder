import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  AgentQuestionDiscussionActionError,
  appendAgentQuestionDiscussionAction,
  db,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { createdBefore, pageInput, pageResult, tenantScopeInput } from './agent-operations-shared'

export const adminAgentQuestionHistoryRouter = router({
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
})
