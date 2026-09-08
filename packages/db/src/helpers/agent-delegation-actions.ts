import { z } from 'zod'

import { db } from '../client'
import {
  bindAgentWorkflowVersions,
  lockAgentWorkflowActivationHeads,
  resolveActiveAgentWorkflowRegistryKeys,
} from './agent-workflow-run-binding'
import { assertEligibleWorkflowRunLease } from './agent-workflow-run-lease'

const MAX_DELEGATION_ANCESTRY = 8

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
    executionLeaseToken: z.string().uuid().optional(),
    waitForResult: z.boolean().default(false),
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
    const operationLockKey = JSON.stringify([
      'pathfinder:agent-delegation',
      input.tenantId,
      input.operationId,
    ])
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operationLockKey}, 0))`
    const replay = await transaction.agentRun.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
      select: {
        id: true,
        venueId: true,
        parentAgentRunId: true,
        agentIdentityId: true,
        initiatedByType: true,
        initiatedById: true,
        requestPrompt: true,
        status: true,
        createdAt: true,
      },
    })
    if (replay) {
      if (
        replay.venueId !== input.venueId ||
        replay.parentAgentRunId !== input.parentAgentRunId ||
        replay.agentIdentityId !== input.specialistAgentIdentityId ||
        replay.initiatedByType !== 'AGENT' ||
        replay.initiatedById !== input.requestingAgentIdentityId ||
        replay.requestPrompt !== input.instructions
      ) {
        throw new AgentDelegationError(
          'CONFLICT',
          'Delegation operation was already used for different work',
        )
      }
      const dependencyWait = await transaction.agentTimelineEvent.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: input.parentAgentRunId,
          eventType: 'DELEGATED_DEPENDENCY_WAITING',
          data: { path: ['childAgentRunId'], equals: replay.id },
        },
        select: { id: true },
      })
      if (Boolean(dependencyWait) !== input.waitForResult)
        throw new AgentDelegationError(
          'CONFLICT',
          'Delegation operation was already used with different dependency semantics',
        )
      const [parent, dependencyReady] = input.waitForResult
        ? await Promise.all([
            transaction.agentRun.findFirst({
              where: {
                id: input.parentAgentRunId,
                tenantId: input.tenantId,
                venueId: input.venueId,
              },
              select: { status: true, cancelRequestedAt: true },
            }),
            transaction.agentTimelineEvent.findFirst({
              where: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentRunId: input.parentAgentRunId,
                eventType: 'DELEGATED_DEPENDENCY_READY',
                data: { path: ['childAgentRunId'], equals: replay.id },
              },
              select: { id: true },
            }),
          ])
        : [null, null]
      return {
        run: replay,
        replayed: true,
        parentWaitingForResult: Boolean(
          dependencyWait &&
          !dependencyReady &&
          parent?.status === 'AWAITING_INPUT' &&
          !parent.cancelRequestedAt,
        ),
      }
    }
    const childRegistryKeys = await resolveActiveAgentWorkflowRegistryKeys(transaction, input)
    const parentBindings = await transaction.agentWorkflowRunBinding.findMany({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: input.parentAgentRunId,
      },
      select: { registryKey: true, outcome: true },
      orderBy: { registryKey: 'asc' },
      take: 51,
    })
    if (parentBindings.length > 50)
      throw new AgentDelegationError('FORBIDDEN', 'Parent workflow binding limit exceeded')
    const unionKeys = [
      ...parentBindings.map((binding) => binding.registryKey),
      ...childRegistryKeys,
    ]
    await lockAgentWorkflowActivationHeads(transaction, {
      tenantId: input.tenantId,
      venueId: input.venueId,
      registryKeys: unionKeys,
      maxKeys: 100,
    })
    const workflowBound = parentBindings.some(
      ({ outcome }) => outcome === 'SELECTED' || outcome === 'CANARY_SKIPPED_PRIOR_VERSION',
    )
    if (workflowBound) {
      if (!input.executionLeaseToken)
        throw new AgentDelegationError(
          'FORBIDDEN',
          'Workflow-bound delegation requires the exact execution lease token',
        )
      await assertEligibleWorkflowRunLease(transaction, {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: input.parentAgentRunId,
        executionLeaseToken: input.executionLeaseToken,
        actionClass: 'AGENT_DELEGATION',
      })
    }
    // Serialize cancellation admission with the parent row. A concurrent
    // cancellation update either commits before this lock and is observed
    // below, or waits until this delegation transaction has committed.
    await transaction.$queryRaw`
      SELECT id
      FROM agent_runs
      WHERE id = ${input.parentAgentRunId}
        AND tenant_id = ${input.tenantId}
        AND venue_id = ${input.venueId}
      FOR UPDATE
    `
    const parent = await transaction.agentRun.findFirst({
      where: {
        id: input.parentAgentRunId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentIdentityId: input.requestingAgentIdentityId,
        status: { in: ['RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL'] },
        cancelRequestedAt: null,
      },
      select: {
        id: true,
        parentAgentRunId: true,
        agentIdentityId: true,
        cancelRequestedAt: true,
      },
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
    const seenRunIds = new Set([parent.id])
    let ancestorId = parent.parentAgentRunId
    let ancestryDepth = 1
    while (ancestorId) {
      if (ancestryDepth >= MAX_DELEGATION_ANCESTRY) {
        throw new AgentDelegationError('FORBIDDEN', 'Delegation ancestry limit exceeded')
      }
      if (seenRunIds.has(ancestorId)) {
        throw new AgentDelegationError('FORBIDDEN', 'Delegation ancestry contains a cycle')
      }
      await transaction.$queryRaw`
        SELECT id
        FROM agent_runs
        WHERE id = ${ancestorId}
          AND tenant_id = ${input.tenantId}
          AND venue_id = ${input.venueId}
        FOR UPDATE
      `
      const ancestor = await transaction.agentRun.findFirst({
        where: {
          id: ancestorId,
          tenantId: input.tenantId,
          venueId: input.venueId,
        },
        select: {
          id: true,
          parentAgentRunId: true,
          agentIdentityId: true,
          status: true,
          cancelRequestedAt: true,
        },
      })
      if (!ancestor) {
        throw new AgentDelegationError(
          'FORBIDDEN',
          'Delegation ancestor is not in the requested scope',
        )
      }
      if (ancestor.cancelRequestedAt || ancestor.status === 'CANCELLED') {
        throw new AgentDelegationError('FORBIDDEN', 'Delegation ancestor has been cancelled')
      }
      if (ancestor.agentIdentityId === input.specialistAgentIdentityId) {
        throw new AgentDelegationError('FORBIDDEN', 'Delegation cannot repeat an ancestor identity')
      }
      seenRunIds.add(ancestor.id)
      ancestorId = ancestor.parentAgentRunId
      ancestryDepth += 1
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
    await bindAgentWorkflowVersions(transaction, {
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentRunId: child.id,
      runType: specialist.agentType,
      operation: 'specialist_delegation',
      registryKeys: childRegistryKeys,
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
    if (input.waitForResult) {
      if (!input.executionLeaseToken)
        throw new AgentDelegationError(
          'FORBIDDEN',
          'A blocking specialist dependency requires the exact parent execution lease token',
        )
      await assertEligibleWorkflowRunLease(transaction, {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: parent.id,
        executionLeaseToken: input.executionLeaseToken,
        actionClass: 'AGENT_DELEGATION',
      })
      const suspended = await transaction.agentRun.updateMany({
        where: {
          id: parent.id,
          tenantId: input.tenantId,
          venueId: input.venueId,
          status: 'RUNNING',
          cancelRequestedAt: null,
          executionLeaseToken: input.executionLeaseToken,
        },
        data: {
          status: 'AWAITING_INPUT',
        },
      })
      if (suspended.count !== 1)
        throw new AgentDelegationError('FORBIDDEN', 'Parent execution lease was lost')
      await transaction.agentTimelineEvent.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId: parent.id,
          actorType: 'AGENT',
          actorId: parent.agentIdentityId,
          eventType: 'DELEGATED_DEPENDENCY_WAITING',
          message: 'The parent task is waiting for one delegated specialist result.',
          data: { childAgentRunId: child.id },
        },
      })
    }
    return { run: child, replayed: false, parentWaitingForResult: input.waitForResult }
  })
}
