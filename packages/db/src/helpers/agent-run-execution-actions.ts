import { randomUUID } from 'node:crypto'

import type { InputJsonValue } from '@prisma/client/runtime/library'
import { z } from 'zod'

import { AgentRunFailureCode } from '@pathfinder/contracts/agent-bridge'

import { db } from '../client'
import { buildBoundedAgentRunExecutionContext } from './agent-run-execution-context'
import { assertEligibleWorkflowRunLease } from './agent-workflow-run-lease'

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

const DEFAULT_WORKFLOW_CONTEXT_MAX_CHARS = 50_000
const BRIDGE_REQUEST_MAX_CHARS = 1_800

function serializeWorkflowExecutionContext(
  bindings: Array<{
    registryKey: string
    outcome: string
    bindingHash: string
    requiredCapabilities: string[]
    workflowVersion: {
      id: string
      contentHash: string
      portableText: string
    } | null
  }>,
) {
  return JSON.stringify(
    bindings.map((binding) => ({
      registryKey: binding.registryKey,
      outcome: binding.outcome,
      bindingHash: binding.bindingHash,
      requiredCapabilities: binding.requiredCapabilities,
      workflowVersion: binding.workflowVersion,
    })),
  )
}

function buildExecutionPrompt(input: {
  request: string
  workflowExecutionContext: string
  executionContext: string
}) {
  const request =
    input.request.length <= BRIDGE_REQUEST_MAX_CHARS
      ? input.request
      : `${input.request.slice(0, BRIDGE_REQUEST_MAX_CHARS - 38)}\n...[task request explicitly truncated]`
  const workflowSection =
    input.workflowExecutionContext === '[]'
      ? ''
      : `\n\nSelected workflow instructions and provenance:\n${input.workflowExecutionContext}`
  return `${request}${workflowSection}\n\nBounded persisted execution context:\n${input.executionContext}`
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

async function lockAndValidateTerminalLease(
  transaction: typeof db,
  input: { tenantId: string; runId: string; leaseToken: string },
  allowCancellationFinalization = false,
) {
  const bindings = await transaction.agentWorkflowRunBinding.findMany({
    where: { tenantId: input.tenantId, agentRunId: input.runId },
    select: { registryKey: true, venueId: true },
    orderBy: { registryKey: 'asc' },
    take: 51,
  })
  if (bindings.length > 50)
    throw new AgentRunExecutionError('LEASE_LOST', 'Workflow binding limit exceeded')
  for (const binding of bindings)
    await transaction.$queryRaw`SELECT id FROM agent_workflow_activation_heads
      WHERE tenant_id=${input.tenantId} AND venue_id=${binding.venueId}
      AND registry_key=${binding.registryKey} FOR UPDATE`
  const rows = await transaction.$queryRaw<
    Array<{ id: string; executionLeaseExpiresAt: Date }>
  >`SELECT id,
    execution_lease_expires_at AS "executionLeaseExpiresAt"
    FROM agent_runs WHERE id=${input.runId} AND tenant_id=${input.tenantId}
      AND status='RUNNING' AND execution_lease_token=${input.leaseToken}::uuid
      AND execution_lease_expires_at > clock_timestamp() FOR UPDATE`
  if (!rows[0]) throw new AgentRunExecutionError('LEASE_LOST', 'Execution lease was lost')
  const run = await transaction.agentRun.findFirst({
    where: { id: input.runId, tenantId: input.tenantId },
    select: {
      venueId: true,
      agentIdentityId: true,
      parentAgentRunId: true,
      attemptNumber: true,
      maxAttempts: true,
      cancelRequestedAt: true,
    },
  })
  if (!run) throw new AgentRunExecutionError('LEASE_LOST', 'Execution lease was lost')
  const clockRows = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS now`
  const now = clockRows[0]?.now
  if (!now || !Number.isFinite(now.getTime()) || rows[0].executionLeaseExpiresAt <= now)
    throw new AgentRunExecutionError('LEASE_LOST', 'Execution lease was lost')
  if (run.cancelRequestedAt && allowCancellationFinalization) return run
  if (bindings.length)
    await assertEligibleWorkflowRunLease(transaction, {
      tenantId: input.tenantId,
      venueId: run.venueId!,
      agentRunId: input.runId,
      executionLeaseToken: input.leaseToken,
      actionClass: 'RUN_TERMINAL_WRITE',
    })
  return run
}

export async function validateDelegatedParent(
  transaction: typeof db,
  input: { tenantId: string; venueId: string | null; parentAgentRunId: string | null },
) {
  if (!input.parentAgentRunId) return
  const parent = await transaction.agentRun.findFirst({
    where: {
      id: input.parentAgentRunId,
      tenantId: input.tenantId,
      venueId: input.venueId,
    },
    select: { id: true },
  })
  if (!parent)
    throw new AgentRunExecutionError(
      'LEASE_LOST',
      'Delegated run parent is unavailable in the exact terminal scope',
    )
}

export async function appendDelegatedTerminalResult(
  transaction: typeof db,
  input: {
    tenantId: string
    venueId: string | null
    childAgentRunId: string
    parentAgentRunId: string | null
    childAgentIdentityId: string
    outcome: 'COMPLETED' | 'FAILED' | 'CANCELLED'
    summary: string
    artifactCount?: number
  },
) {
  if (!input.parentAgentRunId) return
  const resultReference = `agent-run:${input.childAgentRunId}`
  const outcome = input.outcome.toLowerCase()
  await transaction.agentTimelineEvent.create({
    data: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentRunId: input.parentAgentRunId,
      actorType: input.outcome === 'COMPLETED' ? 'AGENT' : 'SYSTEM',
      actorId: input.outcome === 'COMPLETED' ? input.childAgentIdentityId : 'agent-runtime',
      eventType: `DELEGATED_TASK_${input.outcome}`,
      message: `A delegated specialist task ${outcome} and retained its terminal result.`,
      data: {
        childAgentRunId: input.childAgentRunId,
        resultReference,
        outcome: input.outcome,
        ...(input.artifactCount !== undefined ? { artifactCount: input.artifactCount } : {}),
      },
    },
  })
  await transaction.agentMessage.create({
    data: {
      tenantId: input.tenantId,
      venueId: input.venueId!,
      agentRunId: input.parentAgentRunId,
      agentIdentityId: input.childAgentIdentityId,
      role: 'AGENT',
      messageType: 'RESULT',
      content: `${resultReference} ${outcome}. Untrusted delegated terminal result: ${input.summary}`,
      actorId: input.childAgentIdentityId,
    },
  })
}

/** Atomically claims a queued run or takes over a running run whose lease expired. */
export async function claimAgentRunExecution(
  rawInput: z.input<typeof scopeSchema> & {
    leaseDurationMs?: number
    bridgeSessionId?: string
    executionWorkerId?: string
    workflowContextMaxChars?: number
    executionPromptMaxChars?: number
  },
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
      executionWorkerId: z.string().trim().min(1).max(191).optional(),
      workflowContextMaxChars: z
        .number()
        .int()
        .min(1)
        .max(50_000)
        .default(DEFAULT_WORKFLOW_CONTEXT_MAX_CHARS),
      executionPromptMaxChars: z.number().int().min(1).max(50_000).optional(),
    })
    .parse(rawInput)
  const result = await client.$transaction(async (rawTransaction) => {
    const transaction = rawTransaction as unknown as typeof db
    const bindingKeys = await transaction.agentWorkflowRunBinding.findMany({
      where: { tenantId: input.tenantId, agentRunId: input.runId },
      select: { registryKey: true, venueId: true },
      orderBy: { registryKey: 'asc' },
      take: 51,
    })
    if (bindingKeys.length > 50)
      throw new AgentRunExecutionError('NOT_CLAIMABLE', 'Workflow binding limit exceeded')
    for (const binding of bindingKeys)
      await transaction.$queryRaw`SELECT id FROM agent_workflow_activation_heads
        WHERE tenant_id=${input.tenantId} AND venue_id=${binding.venueId}
        AND registry_key=${binding.registryKey} FOR UPDATE`
    const now = new Date()
    const leaseToken = randomUUID()
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs)
    const run = await transaction.agentRun.findFirst({
      where: { id: input.runId, tenantId: input.tenantId },
      select: {
        id: true,
        operationId: true,
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
        initiatedByType: true,
        initiatedById: true,
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
        questions: {
          where: { status: 'ANSWERED' },
          orderBy: [{ answeredAt: 'desc' }, { id: 'desc' }],
          take: 8,
          select: {
            id: true,
            question: true,
            answer: true,
            category: true,
            answeredAt: true,
            updatedAt: true,
            answeredById: true,
            evidence: true,
            callbackMetadata: true,
          },
        },
        messages: {
          where: { messageType: { in: ['PROMPT', 'RESULT'] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 12,
          select: {
            id: true,
            role: true,
            messageType: true,
            content: true,
            actorId: true,
            createdAt: true,
          },
        },
        workflowBindings: {
          where: { workflowVersionId: { not: null } },
          orderBy: { registryKey: 'asc' },
          take: 51,
          select: {
            registryKey: true,
            outcome: true,
            bindingHash: true,
            requiredCapabilities: true,
            workflowVersion: {
              select: { id: true, contentHash: true, portableText: true },
            },
          },
        },
      },
    })
    if (!run) throw new AgentRunExecutionError('NOT_FOUND', 'Agent run not found')
    if (run.cancelRequestedAt) {
      if (!(terminalStatuses as readonly string[]).includes(run.status)) {
        const cancelled = await transaction.agentRun.updateMany({
          where: {
            id: run.id,
            tenantId: run.tenantId,
            status: run.status,
            attemptNumber: run.attemptNumber,
            cancelRequestedAt: run.cancelRequestedAt,
          },
          data: { status: 'CANCELLED', startedAt: run.startedAt ?? now, completedAt: now },
        })
        if (cancelled.count !== 1)
          throw new AgentRunExecutionError('NOT_CLAIMABLE', 'Agent run changed while cancelling')
      }
      return { cancelled: true as const }
    }
    if (!run.agentIdentity.enabled) {
      throw new AgentRunExecutionError('NOT_CLAIMABLE', 'Agent identity is disabled')
    }
    if (run.attemptNumber >= run.maxAttempts) {
      throw new AgentRunExecutionError('NOT_CLAIMABLE', 'Agent run exhausted its attempts')
    }
    const workflowExecutionContext = serializeWorkflowExecutionContext(run.workflowBindings)
    if (
      run.workflowBindings.length > 50 ||
      workflowExecutionContext.length > input.workflowContextMaxChars
    )
      throw new AgentRunExecutionError(
        'NOT_CLAIMABLE',
        'Selected workflow artifacts exceed the complete context budget',
      )
    const executionContext = buildBoundedAgentRunExecutionContext({
      ...run,
      attemptNumber: run.attemptNumber + 1,
    })
    const executionPrompt = buildExecutionPrompt({
      request: run.requestPrompt ?? run.requestedOperation,
      workflowExecutionContext,
      executionContext,
    })
    if (
      input.executionPromptMaxChars !== undefined &&
      executionPrompt.length > input.executionPromptMaxChars
    )
      throw new AgentRunExecutionError(
        'NOT_CLAIMABLE',
        'Complete selected workflow and persisted task context exceed the execution prompt budget',
      )
    const changed = await transaction.agentRun.updateMany({
      where: {
        id: run.id,
        tenantId: run.tenantId,
        attemptNumber: run.attemptNumber,
        agentIdentityId: run.agentIdentityId,
        cancelRequestedAt: null,
        agentIdentity: { enabled: true },
        OR: [{ status: 'QUEUED' }, { status: 'RUNNING', executionLeaseExpiresAt: { lt: now } }],
      },
      data: {
        status: 'RUNNING',
        executionLeaseToken: leaseToken,
        executionLeaseExpiresAt: leaseExpiresAt,
        executionBridgeSessionId: input.bridgeSessionId ?? null,
        executionWorkerId: input.executionWorkerId ?? null,
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
    if (bindingKeys.length) {
      const workerCapabilities = input.executionWorkerId
        ? ((
            await transaction.agentWorker.findFirst({
              where: {
                id: input.executionWorkerId,
                tenantId: run.tenantId,
                status: 'ONLINE',
              },
              select: { capabilities: true },
            })
          )?.capabilities ?? [])
        : []
      const availableCapabilities = run.agentIdentity.accessCapabilities.filter((capability) =>
        workerCapabilities.includes(capability),
      )
      await assertEligibleWorkflowRunLease(transaction, {
        tenantId: run.tenantId,
        venueId: run.venueId!,
        agentRunId: run.id,
        executionLeaseToken: leaseToken,
        availableCapabilities,
      })
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
      executionContext,
      workflowExecutionContext,
      executionPrompt,
      status: 'RUNNING' as const,
      attemptNumber: run.attemptNumber + 1,
      leaseToken,
      leaseExpiresAt,
    }
  })
  if ('cancelled' in result)
    throw new AgentRunExecutionError('NOT_CLAIMABLE', 'Agent run was cancelled')
  return result
}

/** Extends a live lease and reports cancellation without racing completion. */
export async function heartbeatAgentRunExecution(
  rawInput: z.input<typeof leaseSchema>,
  client: AgentRunExecutionClient = db,
) {
  const input = leaseSchema.parse(rawInput)
  return client.$transaction(async (rawTransaction) => {
    const transaction = rawTransaction as unknown as typeof db
    const rows = await transaction.$queryRaw<
      Array<{ cancelRequestedAt: Date | null; executionLeaseExpiresAt: Date }>
    >`
      SELECT cancel_requested_at AS "cancelRequestedAt",
        execution_lease_expires_at AS "executionLeaseExpiresAt" FROM agent_runs
      WHERE id=${input.runId} AND tenant_id=${input.tenantId} AND status='RUNNING'
        AND execution_lease_token=${input.leaseToken}::uuid
        AND execution_lease_expires_at > clock_timestamp() FOR UPDATE`
    const run = rows[0]
    if (!run) throw new AgentRunExecutionError('LEASE_LOST', 'Execution lease was lost')
    const clockRows = await transaction.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now`
    const now = clockRows[0]?.now
    if (!now || !Number.isFinite(now.getTime()) || run.executionLeaseExpiresAt <= now)
      throw new AgentRunExecutionError('LEASE_LOST', 'Execution lease was lost')
    const current = await transaction.agentRun.findFirst({
      where: { id: input.runId, tenantId: input.tenantId },
      select: { cancelRequestedAt: true },
    })
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
    return { cancelRequested: current?.cancelRequestedAt !== null, leaseExpiresAt }
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
    costStatus?: 'UNREPORTED' | 'ESTIMATED' | 'EXACT'
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
      costStatus: z.enum(['UNREPORTED', 'ESTIMATED', 'EXACT']).default('UNREPORTED'),
    })
    .parse(rawInput)
  return client.$transaction(async (rawTransaction) => {
    const transaction = rawTransaction as unknown as typeof db
    const now = new Date()
    const run = await lockAndValidateTerminalLease(transaction, input)
    await validateDelegatedParent(transaction, {
      tenantId: input.tenantId,
      venueId: run.venueId,
      parentAgentRunId: run.parentAgentRunId,
    })
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
        costStatus: input.costStatus,
      },
    })
    if (changed.count !== 1)
      throw new AgentRunExecutionError('LEASE_LOST', 'Execution lease was lost')
    await transaction.agentTimelineEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: run.venueId,
        agentRunId: input.runId,
        actorType: 'AGENT',
        actorId: run.agentIdentityId,
        eventType: 'EXECUTION_COMPLETED',
        message: input.summary,
        data: {
          artifactCount: input.artifacts.length,
          modelProvider: input.modelProvider ?? null,
          modelName: input.modelName ?? null,
          costE8Usd: input.costE8Usd.toString(),
          costStatus: input.costStatus,
        },
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
    await appendDelegatedTerminalResult(transaction, {
      tenantId: input.tenantId,
      venueId: run.venueId,
      childAgentRunId: input.runId,
      parentAgentRunId: run.parentAgentRunId,
      childAgentIdentityId: run.agentIdentityId,
      outcome: 'COMPLETED',
      summary: input.summary,
      artifactCount: input.artifacts.length,
    })
    return { status: 'COMPLETED' as const, completedAt: now }
  })
}

export async function failAgentRunExecution(
  rawInput: z.input<typeof scopeSchema> & {
    leaseToken: string
    errorCode: AgentRunFailureCode
    retryable: boolean
  },
  client: AgentRunExecutionClient = db,
) {
  const input = scopeSchema
    .extend({
      leaseToken: z.string().uuid(),
      errorCode: AgentRunFailureCode,
      retryable: z.boolean(),
    })
    .parse(rawInput)
  return client.$transaction(async (rawTransaction) => {
    const transaction = rawTransaction as unknown as typeof db
    const run = await lockAndValidateTerminalLease(transaction, input, true)
    const status = run.cancelRequestedAt
      ? 'CANCELLED'
      : input.retryable && run.attemptNumber < run.maxAttempts
        ? 'QUEUED'
        : 'FAILED'
    const failureMessage = `Agent execution failed (${input.errorCode}).`
    const now = new Date()
    if (status !== 'QUEUED')
      await validateDelegatedParent(transaction, {
        tenantId: input.tenantId,
        venueId: run.venueId,
        parentAgentRunId: run.parentAgentRunId,
      })
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
        errorMessage: status === 'FAILED' ? failureMessage : null,
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
        message:
          status === 'QUEUED'
            ? 'The task will be retried.'
            : status === 'CANCELLED'
              ? 'The task was cancelled.'
              : failureMessage,
        data: { errorCode: input.errorCode, retryable: input.retryable },
      },
    })
    if (status !== 'QUEUED')
      await appendDelegatedTerminalResult(transaction, {
        tenantId: input.tenantId,
        venueId: run.venueId,
        childAgentRunId: input.runId,
        parentAgentRunId: run.parentAgentRunId,
        childAgentIdentityId: run.agentIdentityId,
        outcome: status,
        summary: status === 'CANCELLED' ? 'The task was cancelled.' : failureMessage,
      })
    return { status, completedAt: status === 'QUEUED' ? null : now }
  })
}
