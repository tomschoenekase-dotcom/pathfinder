import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type AgentQuestionClient = Pick<typeof db, '$transaction'>

const id = z.string().trim().min(1).max(191)
const questionFields = z
  .object({
    operationId: z.string().uuid(),
    tenantId: id,
    venueId: id,
    agentIdentityId: id,
    agentRunId: id.optional(),
    question: z.string().trim().min(1).max(2000),
    context: z.string().trim().min(1).max(2000).optional(),
    choices: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
    blocking: z.boolean().default(true),
  })
  .strict()

const answerFields = z
  .object({
    tenantId: id,
    venueId: id,
    questionId: id,
    expectedUpdatedAt: z.date(),
    outcome: z.enum(['ANSWERED', 'DISMISSED']),
    answer: z.string().trim().min(1).max(5000),
    actor: z
      .object({
        actorType: z.literal('HUMAN'),
        actorId: id,
        auditRole: z.literal('PLATFORM_ADMIN'),
      })
      .strict(),
  })
  .strict()

export type AskAgentQuestionInput = z.input<typeof questionFields>
export type AnswerAgentQuestionInput = z.input<typeof answerFields>

export class AgentQuestionActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'AgentQuestionActionError'
  }
}

function sameQuestion(
  existing: {
    venueId: string
    agentIdentityId: string
    agentRunId: string | null
    question: string
    context: string | null
    choices: string[]
    blocking: boolean
  },
  input: z.output<typeof questionFields>,
) {
  return (
    existing.venueId === input.venueId &&
    existing.agentIdentityId === input.agentIdentityId &&
    existing.agentRunId === (input.agentRunId ?? null) &&
    existing.question === input.question &&
    existing.context === (input.context ?? null) &&
    existing.blocking === input.blocking &&
    JSON.stringify(existing.choices) === JSON.stringify(input.choices)
  )
}

/** Creates or replays one scoped clarification. It grants no approval or action authority. */
export async function askAgentQuestionAction(
  rawInput: AskAgentQuestionInput,
  client: AgentQuestionClient = db,
) {
  const input = questionFields.parse(rawInput)
  return client.$transaction(async (transaction) => {
    const existing = await transaction.agentQuestion.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
      select: {
        id: true,
        venueId: true,
        agentIdentityId: true,
        agentRunId: true,
        question: true,
        context: true,
        choices: true,
        blocking: true,
        status: true,
        answer: true,
        updatedAt: true,
      },
    })
    if (existing) {
      if (!sameQuestion(existing, input)) {
        throw new AgentQuestionActionError(
          'CONFLICT',
          'Question operation was already used for different content',
        )
      }
      return { question: existing, replayed: true }
    }

    const identity = await transaction.agentIdentity.findFirst({
      where: {
        id: input.agentIdentityId,
        tenantId: input.tenantId,
        enabled: true,
        OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
      },
      select: { id: true },
    })
    if (!identity) {
      throw new AgentQuestionActionError('FORBIDDEN', 'Enabled agent identity is not in scope')
    }

    if (input.agentRunId) {
      const run = await transaction.agentRun.findFirst({
        where: {
          id: input.agentRunId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentIdentityId: input.agentIdentityId,
          status: { in: ['QUEUED', 'RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL'] },
        },
        select: { id: true },
      })
      if (!run) throw new AgentQuestionActionError('FORBIDDEN', 'Active agent run is not in scope')
    }

    const created = await transaction.agentQuestion.create({
      data: {
        operationId: input.operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentIdentityId: input.agentIdentityId,
        agentRunId: input.agentRunId ?? null,
        question: input.question,
        context: input.context ?? null,
        choices: input.choices,
        blocking: input.blocking,
      },
      select: {
        id: true,
        venueId: true,
        agentIdentityId: true,
        agentRunId: true,
        question: true,
        context: true,
        choices: true,
        blocking: true,
        status: true,
        answer: true,
        updatedAt: true,
      },
    })

    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.agentIdentityId,
        actorRole: 'AGENT',
        action: 'agent-question.asked',
        targetType: 'AgentQuestion',
        targetId: created.id,
        afterState: {
          venueId: input.venueId,
          agentRunId: input.agentRunId ?? null,
          blocking: input.blocking,
        },
      },
      transaction,
    )

    if (input.agentRunId) {
      await transaction.agentTimelineEvent.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: input.agentRunId,
          actorType: 'AGENT',
          actorId: input.agentIdentityId,
          eventType: 'QUESTION_ASKED',
          message: input.blocking
            ? 'Agent asked a blocking operator question.'
            : 'Agent asked an operator question.',
          data: { questionId: created.id, blocking: input.blocking },
        },
      })
      await transaction.agentMessage.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: input.agentRunId,
          agentIdentityId: input.agentIdentityId,
          role: 'AGENT',
          messageType: 'STATUS',
          content: input.question,
          actorId: input.agentIdentityId,
        },
      })
      if (input.blocking) {
        await transaction.agentRun.updateMany({
          where: {
            id: input.agentRunId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: { in: ['QUEUED', 'RUNNING'] },
          },
          data: { status: 'AWAITING_INPUT' },
        })
      }
    }
    return { question: created, replayed: false }
  })
}

/** Records one human response and makes a blocked run eligible to resume; it executes no tool. */
export async function answerAgentQuestionAction(
  rawInput: AnswerAgentQuestionInput,
  client: AgentQuestionClient = db,
) {
  const input = answerFields.parse(rawInput)
  return client.$transaction(async (transaction) => {
    const existing = await transaction.agentQuestion.findFirst({
      where: { id: input.questionId, tenantId: input.tenantId, venueId: input.venueId },
      select: {
        id: true,
        agentRunId: true,
        agentIdentityId: true,
        blocking: true,
        status: true,
        updatedAt: true,
      },
    })
    if (!existing) throw new AgentQuestionActionError('NOT_FOUND', 'Agent question not found')
    if (
      existing.status !== 'PENDING' ||
      existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
    ) {
      throw new AgentQuestionActionError('CONFLICT', 'Agent question changed; refresh and retry')
    }

    const changed = await transaction.agentQuestion.updateMany({
      where: {
        id: existing.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'PENDING',
        updatedAt: input.expectedUpdatedAt,
      },
      data: {
        status: input.outcome,
        answer: input.answer,
        answeredById: input.actor.actorId,
        answeredAt: new Date(),
      },
    })
    if (changed.count !== 1) {
      throw new AgentQuestionActionError('CONFLICT', 'Agent question changed; refresh and retry')
    }

    if (existing.agentRunId) {
      await transaction.agentTimelineEvent.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: existing.agentRunId,
          actorType: 'HUMAN',
          actorId: input.actor.actorId,
          eventType: input.outcome === 'ANSWERED' ? 'QUESTION_ANSWERED' : 'QUESTION_DISMISSED',
          message: 'Operator responded to an agent question.',
          data: { questionId: existing.id, outcome: input.outcome },
        },
      })
      await transaction.agentMessage.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: existing.agentRunId,
          agentIdentityId: existing.agentIdentityId,
          role: 'OPERATOR',
          messageType: 'ANSWER',
          content: input.answer,
          actorId: input.actor.actorId,
        },
      })
      if (existing.blocking) {
        await transaction.agentRun.updateMany({
          where: {
            id: existing.agentRunId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: 'AWAITING_INPUT',
          },
          data: { status: 'QUEUED' },
        })
      }
    }

    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.actorId,
        actorRole: input.actor.auditRole,
        action: 'agent-question.responded',
        targetType: 'AgentQuestion',
        targetId: existing.id,
        beforeState: { status: existing.status },
        afterState: {
          status: input.outcome,
          runEligibleToResume: Boolean(existing.agentRunId && existing.blocking),
        },
      },
      transaction,
    )
    return {
      questionId: existing.id,
      agentRunId: existing.agentRunId,
      status: input.outcome,
      runEligibleToResume: Boolean(existing.agentRunId && existing.blocking),
    }
  })
}
