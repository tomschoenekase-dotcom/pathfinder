import { z } from 'zod'

import { db } from '../client'

export type AgentDelegationClient = Pick<typeof db, '$transaction'>

export class AgentDelegationError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'AgentDelegationError'
  }
}

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    parentAgentRunId: z.string().trim().min(1).max(191),
    requestingAgentIdentityId: z.string().trim().min(1).max(191),
    specialistAgentIdentityId: z.string().trim().min(1).max(191),
    instructions: z.string().trim().min(1).max(10_000),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict()

/** Creates a durable specialist child run. The parent run is the authority;
 * callers cannot widen its tenant, venue, identity, or specialist scope. */
export async function delegateAgentTaskAction(
  rawInput: z.input<typeof inputSchema>,
  client: AgentDelegationClient = db,
) {
  const input = inputSchema.parse(rawInput)
  return client.$transaction(async (rawTransaction) => {
    const transaction = rawTransaction as unknown as typeof db
    const replay = await transaction.agentRun.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
      select: {
        id: true,
        parentAgentRunId: true,
        agentIdentityId: true,
        requestPrompt: true,
        status: true,
        createdAt: true,
      },
    })
    if (replay) {
      if (
        replay.parentAgentRunId !== input.parentAgentRunId ||
        replay.agentIdentityId !== input.specialistAgentIdentityId ||
        replay.requestPrompt !== input.instructions
      ) {
        throw new AgentDelegationError(
          'CONFLICT',
          'Delegation operation was already used for different work',
        )
      }
      return { run: replay, replayed: true }
    }
    const parent = await transaction.agentRun.findFirst({
      where: {
        id: input.parentAgentRunId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentIdentityId: input.requestingAgentIdentityId,
        status: { in: ['RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL'] },
      },
      select: { id: true, agentIdentityId: true },
    })
    if (!parent) {
      throw new AgentDelegationError(
        'FORBIDDEN',
        'Active parent agent run is not in the requested scope',
      )
    }
    if (parent.agentIdentityId === input.specialistAgentIdentityId) {
      throw new AgentDelegationError('FORBIDDEN', 'A run cannot delegate to its own identity')
    }
    const specialist = await transaction.agentIdentity.findFirst({
      where: {
        id: input.specialistAgentIdentityId,
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
    if (!specialist)
      throw new AgentDelegationError('NOT_FOUND', 'Enabled specialist was not found in scope')
    const child = await transaction.agentRun.create({
      data: {
        operationId: input.operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentIdentityId: specialist.id,
        parentAgentRunId: parent.id,
        delegationReason: input.reason,
        runType: specialist.agentType,
        requestedOperation: 'specialist_delegation',
        requestPrompt: input.instructions,
        scopeSnapshot: {
          accessScope: specialist.accessScope,
          accessCapabilities: specialist.accessCapabilities,
          autonomyLevel: specialist.autonomyLevel,
          autonomousActions: specialist.autonomousActions,
          parentAgentRunId: parent.id,
        },
        status: 'QUEUED',
        modelProvider: specialist.defaultProvider,
        modelName: specialist.defaultModel,
        initiatedByType: 'AGENT',
        initiatedById: parent.agentIdentityId,
      },
      select: {
        id: true,
        parentAgentRunId: true,
        agentIdentityId: true,
        requestPrompt: true,
        status: true,
        createdAt: true,
      },
    })
    await transaction.agentTimelineEvent.createMany({
      data: [
        {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: parent.id,
          actorType: 'AGENT',
          actorId: parent.agentIdentityId,
          eventType: 'SPECIALIST_DELEGATED',
          message: 'The primary agent assigned a specialist.',
          data: {
            childAgentRunId: child.id,
            specialistAgentIdentityId: specialist.id,
            reason: input.reason,
          },
        },
        {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: child.id,
          actorType: 'AGENT',
          actorId: parent.agentIdentityId,
          eventType: 'DELEGATED_TASK_QUEUED',
          message: 'A parent agent queued this specialist task.',
          data: { parentAgentRunId: parent.id, reason: input.reason },
        },
      ],
    })
    await transaction.agentMessage.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: child.id,
        agentIdentityId: specialist.id,
        role: 'AGENT',
        messageType: 'PROMPT',
        content: input.instructions,
        actorId: parent.agentIdentityId,
      },
    })
    return { run: child, replayed: false }
  })
}
