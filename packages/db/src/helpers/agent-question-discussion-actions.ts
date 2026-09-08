import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type AgentQuestionDiscussionClient = Pick<typeof db, '$transaction'>

const scopedId = z.string().trim().min(1).max(191)
const appendInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: scopedId,
    venueId: scopedId,
    questionId: scopedId,
    body: z.string().trim().min(1).max(5000),
    actor: z
      .object({
        actorType: z.literal('HUMAN'),
        actorId: scopedId,
        auditRole: z.literal('PLATFORM_ADMIN'),
      })
      .strict(),
  })
  .strict()

export type AppendAgentQuestionDiscussionInput = z.input<typeof appendInput>

export class AgentQuestionDiscussionActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'AgentQuestionDiscussionActionError'
  }
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

async function appendOnce(
  input: z.output<typeof appendInput>,
  client: AgentQuestionDiscussionClient,
) {
  return client.$transaction(async (transaction) => {
    const question = await transaction.agentQuestion.findFirst({
      where: {
        id: input.questionId,
        tenantId: input.tenantId,
        venueId: input.venueId,
      },
      select: { id: true },
    })
    if (!question) {
      throw new AgentQuestionDiscussionActionError('NOT_FOUND', 'Agent question not found')
    }

    const existing = await transaction.agentQuestionDiscussionMessage.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        questionId: true,
        authorId: true,
        body: true,
        createdAt: true,
      },
    })
    if (existing) {
      if (
        existing.venueId !== input.venueId ||
        existing.questionId !== input.questionId ||
        existing.authorId !== input.actor.actorId ||
        existing.body !== input.body
      ) {
        throw new AgentQuestionDiscussionActionError(
          'CONFLICT',
          'Discussion operation was already used for different content',
        )
      }
      return { message: existing, replayed: true as const }
    }

    const message = await transaction.agentQuestionDiscussionMessage.create({
      data: {
        operationId: input.operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        questionId: input.questionId,
        authorId: input.actor.actorId,
        body: input.body,
      },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        questionId: true,
        authorId: true,
        body: true,
        createdAt: true,
      },
    })

    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.actorId,
        actorRole: input.actor.auditRole,
        action: 'agent-question.discussion-message-added',
        targetType: 'AgentQuestion',
        targetId: input.questionId,
        afterState: {
          venueId: input.venueId,
          discussionMessageId: message.id,
        },
      },
      transaction,
    )

    return { message, replayed: false as const }
  })
}

/** Appends or exactly replays human context. It never answers or resumes a question. */
export async function appendAgentQuestionDiscussionAction(
  rawInput: AppendAgentQuestionDiscussionInput,
  client: AgentQuestionDiscussionClient = db,
) {
  const parsed = appendInput.safeParse(rawInput)
  if (!parsed.success) {
    throw new AgentQuestionDiscussionActionError('INVALID_INPUT', parsed.error.message)
  }
  try {
    return await appendOnce(parsed.data, client)
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    try {
      return await appendOnce(parsed.data, client)
    } catch (replayError) {
      if (isUniqueConflict(replayError)) {
        throw new AgentQuestionDiscussionActionError(
          'CONFLICT',
          'Discussion operation could not be reconciled',
        )
      }
      throw replayError
    }
  }
}
