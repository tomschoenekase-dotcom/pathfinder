import { randomUUID } from 'node:crypto'

import type { InputJsonValue } from '@prisma/client/runtime/library'
import { z } from 'zod'

import { db } from '../client'

export type AgentRunExecutionClient = Pick<typeof db, '$transaction'>

export class AgentRunExecutionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'NOT_CLAIMABLE' | 'LEASE_LOST',
    message: string,
  ) {
    super(message)
    this.name = 'AgentRunExecutionError'
  }
}

const scopeSchema = z.object({
  tenantId: z.string().trim().min(1).max(191),
  runId: z.string().trim().min(1).max(191),
})
const leaseSchema = scopeSchema.extend({
  leaseToken: z.string().uuid(),
  leaseDurationMs: z
    .number()
    .int()
    .min(5_000)
    .max(15 * 60_000)
    .default(60_000),
})
const terminalStatuses = ['COMPLETED', 'FAILED', 'CANCELLED'] as const

/** Atomically claims a queued run or takes over a running run whose lease expired. */
export async function claimAgentRunExecution(
  rawInput: z.input<typeof scopeSchema> & { leaseDurationMs?: number; bridgeSessionId?: string },
  client: AgentRunExecutionClient = db,
) {
  const input = scopeSchema
    .extend({
      leaseDurationMs: z
        .number()
        .int()
        .min(5_000)
        .max(15 * 60_000)
        .default(60_000),
      bridgeSessionId: z.string().uuid().optional(),
    })
    .parse(rawInput)
  return client.$transaction(async (rawTransaction) => {
    const transaction = rawTransaction as unknown as typeof db
    const now = new Date()
    const leaseToken = randomUUID()
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs)
    const run = await transaction.agentRun.findFirst({
      where: { id: input.runId, tenantId: input.tenantId },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        agentIdentityId: true,
        runType: true,
        requestedOperation: true,
        requestPrompt: true,
        scopeSnapshot: true,
        status: true,
        modelProvider: true,
        modelName: true,
        cancelRequestedAt: true,
        executionLeaseExpiresAt: true,
        attemptNumber: true,
        maxAttempts: true,
        startedAt: true,
        agentIdentity: {
          select: {
            identityKey: true,
            name: true,
            description: true,
            accessCapabilities: true,
            autonomyLevel: true,
            autonomousActions: true,
            enabled: true,
          },
        },
      },
    })
    if (!run) throw new AgentRunExecutionError('NOT_FOUND', 'Agent run not found')
    if (run.cancelRequestedAt) {
      if (!(terminalStatuses as readonly string[]).includes(run.status)) {
        await transaction.agentRun.updateMany({
          where: { id: run.id, tenantId: run.tenantId, status: run.status },
          data: { status: 'CANCELLED', startedAt: run.startedAt ?? now, completedAt: now },
        })
      }
      throw new AgentRunExecutionError('NOT_CLAIMABLE', 'Agent run was cancelled')
    }
    if (!run.agentIdentity.enabled) {
      throw new AgentRunExecutionError('NOT_CLAIMABLE', 'Agent identity is disabled')
    }
    if (run.attemptNumber >= run.maxAttempts) {
      throw new AgentRunExecutionError('NOT_CLAIMABLE', 'Agent run exhausted its attempts')
    }
    const changed = await transaction.agentRun.updateMany({
      where: {
        id: run.id,
        tenantId: run.tenantId,
        attemptNumber: run.attemptNumber,
        OR: [{ status: 'QUEUED' }, { status: 'RUNNING', executionLeaseExpiresAt: { lt: now } }],
      },
      data: {
        status: 'RUNNING',
        executionLeaseToken: leaseToken,
        executionLeaseExpiresAt: leaseExpiresAt,
        ...(input.bridgeSessionId ? { executionBridgeSessionId: input.bridgeSessionId } : {}),
        lastHeartbeatAt: now,
        attemptNumber: { increment: 1 },
        startedAt: run.startedAt ?? now,
        errorCode: null,
        errorMessage: null,
      },
    })
    if (changed.count !== 1) {
      throw new AgentRunExecutionError('NOT_CLAIMABLE', 'Agent run is already claimed')
    }
    await transaction.agentTimelineEvent.create({
      data: {
        tenantId: run.tenantId,
        venueId: run.venueId,
        agentRunId: run.id,
        actorType: 'SYSTEM',
        actorId: 'agent-runtime',
        eventType: 'EXECUTION_CLAIMED',
        message: 'The agent runtime claimed this task.',
        data: {
          attemptNumber: run.attemptNumber + 1,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
        },
      },
    })
    return {
      ...run,
      status: 'RUNNING' as const,
      attemptNumber: run.attemptNumber + 1,
      leaseToken,
      leaseExpiresAt,
    }
  })
}

/** Extends a live lease and reports cancellation without racing completion. */
export async function heartbeatAgentRunExecution(
  rawInput: z.input<typeof leaseSchema>,
  client: AgentRunExecutionClient = db,
) {
  const input = leaseSchema.parse(rawInput)
  return client.$transaction(async (rawTransaction) => {
    const transaction = rawTransaction as unknown as typeof db
    const now = new Date()
    const run = await transaction.agentRun.findFirst({
      where: { id: input.runId, tenantId: input.tenantId },
      select: { cancelRequestedAt: true },
    })
    if (!run) throw new AgentRunExecutionError('NOT_FOUND', 'Agent run not found')
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs)
    const changed = await transaction.agentRun.updateMany({
      where: {
        id: input.runId,
        tenantId: input.tenantId,
        status: 'RUNNING',
        executionLeaseToken: input.leaseToken,
      },
      data: { lastHeartbeatAt: now, executionLeaseExpiresAt: leaseExpiresAt },
    })
    if (changed.count !== 1)
      throw new AgentRunExecutionError('LEASE_LOST', 'Execution lease was lost')
    return { cancelRequested: run.cancelRequestedAt !== null, leaseExpiresAt }
  })
}

export async function completeAgentRunExecution(
  rawInput: z.input<typeof scopeSchema> & {
    leaseToken: string
    summary: string
    artifacts?: InputJsonValue[]
    modelProvider?: string
    modelName?: string
    costE8Usd?: bigint
  },
  client: AgentRunExecutionClient = db,
) {
  const input = scopeSchema
    .extend({
      leaseToken: z.string().uuid(),
      summary: z.string().trim().min(1).max(5_000),
      artifacts: z.array(z.unknown()).default([]),
      modelProvider: z.string().trim().min(1).max(100).optional(),
      modelName: z.string().trim().min(1).max(191).optional(),
      costE8Usd: z.bigint().nonnegative().default(0n),
    })
    .parse(rawInput)
  return client.$transaction(async (rawTransaction) => {
    const transaction = rawTransaction as unknown as typeof db
    const now = new Date()
    const changed = await transaction.agentRun.updateMany({
      where: {
        id: input.runId,
        tenantId: input.tenantId,
        status: 'RUNNING',
        executionLeaseToken: input.leaseToken,
        cancelRequestedAt: null,
      },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
        artifacts: input.artifacts as InputJsonValue,
        ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
        ...(input.modelName ? { modelName: input.modelName } : {}),
        costE8Usd: input.costE8Usd,
      },
    })
    if (changed.count !== 1)
      throw new AgentRunExecutionError('LEASE_LOST', 'Execution lease was lost')
    const run = await transaction.agentRun.findFirstOrThrow({
      where: { id: input.runId, tenantId: input.tenantId },
      select: { venueId: true, agentIdentityId: true },
    })
    await transaction.agentTimelineEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: run.venueId,
        agentRunId: input.runId,
        actorType: 'AGENT',
        actorId: run.agentIdentityId,
        eventType: 'EXECUTION_COMPLETED',
        message: input.summary,
        data: { artifactCount: input.artifacts.length },
      },
    })
    await transaction.agentMessage.create({
      data: {
        tenantId: input.tenantId,
        venueId: run.venueId!,
        agentRunId: input.runId,
        agentIdentityId: run.agentIdentityId,
        role: 'AGENT',
        messageType: 'RESULT',
        content: input.summary,
        actorId: run.agentIdentityId,
      },
    })
    return { status: 'COMPLETED' as const, completedAt: now }
  })
}

export async function failAgentRunExecution(
  rawInput: z.input<typeof scopeSchema> & {
    leaseToken: string
    errorCode: string
    errorMessage: string
    retryable: boolean
  },
  client: AgentRunExecutionClient = db,
) {
  const input = scopeSchema
    .extend({
      leaseToken: z.string().uuid(),
      errorCode: z.string().trim().min(1).max(100),
      errorMessage: z.string().trim().min(1).max(5_000),
      retryable: z.boolean(),
    })
    .parse(rawInput)
  return client.$transaction(async (rawTransaction) => {
    const transaction = rawTransaction as unknown as typeof db
    const run = await transaction.agentRun.findFirst({
      where: {
        id: input.runId,
        tenantId: input.tenantId,
        status: 'RUNNING',
        executionLeaseToken: input.leaseToken,
      },
      select: { venueId: true, attemptNumber: true, maxAttempts: true, cancelRequestedAt: true },
    })
    if (!run) throw new AgentRunExecutionError('LEASE_LOST', 'Execution lease was lost')
    const status = run.cancelRequestedAt
      ? 'CANCELLED'
      : input.retryable && run.attemptNumber < run.maxAttempts
        ? 'QUEUED'
        : 'FAILED'
    const now = new Date()
    const changed = await transaction.agentRun.updateMany({
      where: {
        id: input.runId,
        tenantId: input.tenantId,
        status: 'RUNNING',
        executionLeaseToken: input.leaseToken,
      },
      data: {
        status,
        errorCode: status === 'FAILED' ? input.errorCode : null,
        errorMessage: status === 'FAILED' ? input.errorMessage : null,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
        completedAt: status === 'QUEUED' ? null : now,
      },
    })
    if (changed.count !== 1)
      throw new AgentRunExecutionError('LEASE_LOST', 'Execution lease was lost')
    await transaction.agentTimelineEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: run.venueId,
        agentRunId: input.runId,
        actorType: 'SYSTEM',
        actorId: 'agent-runtime',
        eventType: status === 'QUEUED' ? 'EXECUTION_RETRY_SCHEDULED' : `EXECUTION_${status}`,
        message: status === 'QUEUED' ? 'The task will be retried.' : input.errorMessage,
        data: { errorCode: input.errorCode, retryable: input.retryable },
      },
    })
    return { status, completedAt: status === 'QUEUED' ? null : now }
  })
}
