import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type AgentTaskClient = Pick<typeof db, '$transaction'>

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    agentIdentityId: z.string().trim().min(1).max(191),
    prompt: z.string().trim().min(1).max(10_000),
    actor: z
      .object({
        actorType: z.literal('HUMAN'),
        actorId: z.string().trim().min(1).max(191),
        auditRole: z.literal('PLATFORM_ADMIN'),
      })
      .strict(),
  })
  .strict()

export type CreateAgentTaskInput = z.input<typeof inputSchema>

export class AgentTaskActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'BAD_REQUEST',
    message: string,
  ) {
    super(message)
    this.name = 'AgentTaskActionError'
  }
}

/** Queues durable operator intent. It never calls a model, tool, queue, or provider. */
export async function createAgentTaskAction(
  rawInput: CreateAgentTaskInput,
  client: AgentTaskClient = db,
) {
  const input = inputSchema.parse(rawInput)
  return client.$transaction(async (transaction) => {
    const replay = await transaction.agentRun.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
      select: {
        id: true,
        venueId: true,
        agentIdentityId: true,
        requestPrompt: true,
        status: true,
        createdAt: true,
      },
    })
    if (replay) {
      if (
        replay.venueId !== input.venueId ||
        replay.agentIdentityId !== input.agentIdentityId ||
        replay.requestPrompt !== input.prompt
      ) {
        throw new AgentTaskActionError(
          'CONFLICT',
          'Task operation was already used for different work',
        )
      }
      return { run: replay, replayed: true, executionTriggered: false as const }
    }

    const identity = await transaction.agentIdentity.findFirst({
      where: {
        id: input.agentIdentityId,
        tenantId: input.tenantId,
        enabled: true,
        OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
      },
      select: {
        id: true,
        agentType: true,
        accessScope: true,
        accessCapabilities: true,
        autonomyLevel: true,
        autonomousActions: true,
        defaultProvider: true,
        defaultModel: true,
      },
    })
    if (!identity) {
      throw new AgentTaskActionError('FORBIDDEN', 'Enabled agent identity is not in scope')
    }

    const run = await transaction.agentRun.create({
      data: {
        operationId: input.operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentIdentityId: identity.id,
        runType: identity.agentType,
        requestedOperation: 'operator_task',
        requestPrompt: input.prompt,
        scopeSnapshot: {
          accessScope: identity.accessScope,
          accessCapabilities: identity.accessCapabilities,
          autonomyLevel: identity.autonomyLevel,
          autonomousActions: identity.autonomousActions,
        },
        status: 'QUEUED',
        modelProvider: identity.defaultProvider,
        modelName: identity.defaultModel,
        initiatedByType: input.actor.actorType,
        initiatedById: input.actor.actorId,
      },
      select: {
        id: true,
        venueId: true,
        agentIdentityId: true,
        requestPrompt: true,
        status: true,
        createdAt: true,
      },
    })
    await transaction.agentTimelineEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: run.id,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        eventType: 'TASK_QUEUED',
        message: 'Operator queued a task for this agent.',
        data: {},
      },
    })
    await transaction.agentMessage.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: run.id,
        agentIdentityId: identity.id,
        role: 'OPERATOR',
        messageType: 'PROMPT',
        content: input.prompt,
        actorId: input.actor.actorId,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.actorId,
        actorRole: input.actor.auditRole,
        action: 'agent-task.queued',
        targetType: 'AgentRun',
        targetId: run.id,
        afterState: {
          venueId: input.venueId,
          agentIdentityId: identity.id,
          status: 'QUEUED',
          executionTriggered: false,
        },
      },
      transaction,
    )
    return { run, replayed: false, executionTriggered: false as const }
  })
}
