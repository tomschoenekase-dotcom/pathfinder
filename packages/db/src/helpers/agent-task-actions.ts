import { z } from 'zod'
import {
  AgentSourceAssignment,
  readAgentSourceAssignment,
  AGENT_SOURCE_WORKER_ROLES,
  AGENT_SOURCE_WORKER_CAPABILITIES,
} from '@pathfinder/contracts'
import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { bindEligibleAgentWorkflows } from './agent-workflow-run-binding'

export type AgentTaskClient = Pick<typeof db, '$transaction'>
export type AgentTaskTransaction = Parameters<Parameters<AgentTaskClient['$transaction']>[0]>[0]

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    agentIdentityId: z.string().trim().min(1).max(191),
    prompt: z.string().trim().min(1).max(10_000),
    promptIdentity: z.string().trim().min(1).max(191).optional(),
    sourceAssignment: AgentSourceAssignment.optional(),
    prospectScope: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('ALL') }).strict(),
        z
          .object({
            mode: z.literal('TERRITORIES'),
            territoryIds: z.array(z.string().trim().min(1).max(191)).min(1).max(100),
          })
          .strict(),
      ])
      .optional(),
    actor: z
      .object({
        actorType: z.literal('HUMAN'),
        actorId: z.string().trim().min(1).max(191),
        auditRole: z.literal('PLATFORM_ADMIN'),
      })
      .strict(),
  })
  .strict()

const systemSourceInputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    agentIdentityId: z.string().trim().min(1).max(191),
    sourceAssignment: AgentSourceAssignment,
    dispatchId: z.string().trim().min(1).max(177),
    policyRevision: z.number().int().positive(),
  })
  .strict()

export type CreateAgentTaskInput = z.input<typeof inputSchema>
export type CreateSystemSourceAgentTaskInput = z.input<typeof systemSourceInputSchema>

export class AgentTaskActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'BAD_REQUEST',
    message: string,
  ) {
    super(message)
    this.name = 'AgentTaskActionError'
  }
}

const SYSTEM_SOURCE_PROMPT =
  'Read only the assigned source through pathfinder.read. Ask the exact clarification questions needed through ask_operator and resolve_source_clarification. Wait for a retained human answer before creating any evidence amendment, and create one only when that answer supports it. Do not review, apply, or publish any change.'

type NormalizedTaskInput = {
  operationId: string
  tenantId: string
  venueId: string
  agentIdentityId: string
  prompt: string
  promptIdentity?: string | undefined
  sourceAssignment?: z.output<typeof AgentSourceAssignment> | undefined
  prospectScope?: { mode: 'ALL' } | { mode: 'TERRITORIES'; territoryIds: string[] } | undefined
  requestedOperation: 'operator_task' | 'intake_source_review'
  initiatedByType: 'HUMAN' | 'SYSTEM'
  initiatedById: string
  auditRole: 'PLATFORM_ADMIN' | 'SYSTEM'
  messageRole: 'OPERATOR' | 'SYSTEM'
  sourceDispatch?: { version: 1; dispatchId: string; policyRevision: number } | undefined
  requireContentDraft: boolean
}

async function createAgentTaskInTransaction(
  transaction: AgentTaskTransaction,
  input: NormalizedTaskInput,
) {
  const replay = await transaction.agentRun.findFirst({
    where: { tenantId: input.tenantId, operationId: input.operationId },
    select: {
      id: true,
      venueId: true,
      agentIdentityId: true,
      requestedOperation: true,
      requestPrompt: true,
      scopeSnapshot: true,
      status: true,
      initiatedByType: true,
      initiatedById: true,
      createdAt: true,
    },
  })
  if (replay) {
    const snapshot = replay.scopeSnapshot as {
      prospectScope?: unknown
      promptIdentity?: unknown
      sourceDispatch?: unknown
    }
    if (
      replay.venueId !== input.venueId ||
      replay.agentIdentityId !== input.agentIdentityId ||
      replay.requestPrompt !== input.prompt ||
      (input.initiatedByType === 'SYSTEM' &&
        (replay.requestedOperation !== input.requestedOperation ||
          replay.initiatedByType !== input.initiatedByType ||
          replay.initiatedById !== input.initiatedById)) ||
      JSON.stringify(readAgentSourceAssignment(replay.scopeSnapshot)) !==
        JSON.stringify(input.sourceAssignment ?? null) ||
      JSON.stringify(snapshot.prospectScope ?? null) !==
        JSON.stringify(input.prospectScope ?? null) ||
      (snapshot.promptIdentity ?? null) !==
        (input.prospectScope ? (input.promptIdentity ?? 'operator-task') : null) ||
      (input.initiatedByType === 'SYSTEM' &&
        JSON.stringify(snapshot.sourceDispatch ?? null) !==
          JSON.stringify(input.sourceDispatch ?? null))
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
  if (!identity)
    throw new AgentTaskActionError('FORBIDDEN', 'Enabled agent identity is not in scope')
  if (input.sourceAssignment) {
    if (
      identity.agentType !== 'CONTENT' ||
      !identity.accessCapabilities.includes('intake.read') ||
      (input.requireContentDraft && !identity.accessCapabilities.includes('content.draft')) ||
      input.prospectScope
    ) {
      throw new AgentTaskActionError(
        'FORBIDDEN',
        input.requireContentDraft
          ? 'System source review requires a scoped Content identity with intake.read and content.draft'
          : 'Source assignments require a scoped Content identity with intake.read and no prospect scope',
      )
    }
    const source = input.sourceAssignment
    const receipt = await transaction.intakeFileExtractionReceipt.findFirst({
      where: {
        id: source.receiptId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: source.intakeRunId,
        extractedTextHash: source.extractedTextHash,
        outcome: 'SUCCEEDED',
        review: { is: null },
        run: { sourceKind: 'FILE_UPLOAD', status: 'AWAITING_REVIEW' },
      },
      select: { id: true },
    })
    if (!receipt)
      throw new AgentTaskActionError(
        'BAD_REQUEST',
        'Exact unreviewed source is unavailable for assignment',
      )
  }
  const prospectCapabilities = identity.accessCapabilities.filter((capability) =>
    capability.startsWith('prospects.'),
  )
  if (input.prospectScope && prospectCapabilities.length === 0)
    throw new AgentTaskActionError(
      'FORBIDDEN',
      'Agent identity has no prospect capability for the requested scope',
    )
  if (input.prospectScope?.mode === 'TERRITORIES') {
    const territoryIds = [...new Set(input.prospectScope.territoryIds)]
    const territoryCount = await transaction.prospectTerritory.count({
      where: { id: { in: territoryIds }, archivedAt: null },
    })
    if (territoryCount !== territoryIds.length)
      throw new AgentTaskActionError('BAD_REQUEST', 'Prospect scope contains an unknown territory')
  }

  const run = await transaction.agentRun.create({
    data: {
      operationId: input.operationId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentIdentityId: identity.id,
      runType: identity.agentType,
      requestedOperation: input.requestedOperation,
      requestPrompt: input.prompt,
      scopeSnapshot: {
        accessScope: identity.accessScope,
        accessCapabilities: identity.accessCapabilities,
        autonomyLevel: identity.autonomyLevel,
        autonomousActions: identity.autonomousActions,
        ...(input.sourceAssignment
          ? {
              sourceAssignment: input.sourceAssignment,
              requiredWorkerRoles: [...AGENT_SOURCE_WORKER_ROLES],
              requiredWorkerCapabilities: [...AGENT_SOURCE_WORKER_CAPABILITIES],
            }
          : {}),
        ...(input.prospectScope
          ? {
              prospectScope: input.prospectScope,
              promptIdentity: input.promptIdentity ?? 'operator-task',
            }
          : {}),
        ...(input.sourceDispatch ? { sourceDispatch: input.sourceDispatch } : {}),
      },
      status: 'QUEUED',
      modelProvider: identity.defaultProvider,
      modelName: identity.defaultModel,
      initiatedByType: input.initiatedByType,
      initiatedById: input.initiatedById,
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
  await bindEligibleAgentWorkflows(transaction, {
    tenantId: input.tenantId,
    venueId: input.venueId,
    agentRunId: run.id,
    runType: identity.agentType,
    operation: input.requestedOperation,
  })
  await transaction.agentTimelineEvent.create({
    data: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentRunId: run.id,
      actorType: input.initiatedByType,
      actorId: input.initiatedById,
      eventType: 'TASK_QUEUED',
      message:
        input.initiatedByType === 'SYSTEM'
          ? 'System queued an assigned-source review task for this agent.'
          : 'Operator queued a task for this agent.',
      data: {},
    },
  })
  await transaction.agentMessage.create({
    data: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentRunId: run.id,
      agentIdentityId: identity.id,
      role: input.messageRole,
      messageType: 'PROMPT',
      content: input.prompt,
      actorId: input.initiatedById,
    },
  })
  await writeAuditLogStrict(
    {
      tenantId: input.tenantId,
      actorType: input.initiatedByType,
      actorId: input.initiatedById,
      actorRole: input.auditRole,
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
}

/** Queues durable operator intent. It never calls a model, tool, queue, or provider. */
export async function createAgentTaskAction(
  rawInput: CreateAgentTaskInput,
  client: AgentTaskClient = db,
) {
  const input = inputSchema.parse(rawInput)
  return client.$transaction(async (transaction) => {
    if (input.sourceAssignment) {
      const source = input.sourceAssignment
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-file-extraction-review:${input.tenantId}:${input.venueId}:${source.receiptId}`}, 0))`
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:agent-task-operation:${input.tenantId}:${input.operationId}`}, 0))`
    }
    return createAgentTaskInTransaction(transaction, {
      ...input,
      requestedOperation: 'operator_task',
      initiatedByType: 'HUMAN',
      initiatedById: input.actor.actorId,
      auditRole: 'PLATFORM_ADMIN',
      messageRole: 'OPERATOR',
      requireContentDraft: false,
    })
  })
}

/** Queues a bounded source review after trusted admission inside the caller's transaction. */
export async function createSystemSourceAgentTaskInTransaction(
  transaction: AgentTaskTransaction,
  rawInput: CreateSystemSourceAgentTaskInput,
  options: { admitTask: () => void | Promise<void> },
) {
  const input = systemSourceInputSchema.parse(rawInput)
  if (!options || typeof options.admitTask !== 'function')
    throw new AgentTaskActionError('BAD_REQUEST', 'A trusted task admission callback is required')
  const source = input.sourceAssignment
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-file-extraction-review:${input.tenantId}:${input.venueId}:${source.receiptId}`}, 0))`
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:agent-task-operation:${input.tenantId}:${input.operationId}`}, 0))`
  await options.admitTask()
  const initiatedById = `intake-source:${input.dispatchId}`
  return createAgentTaskInTransaction(transaction, {
    operationId: input.operationId,
    tenantId: input.tenantId,
    venueId: input.venueId,
    agentIdentityId: input.agentIdentityId,
    prompt: SYSTEM_SOURCE_PROMPT,
    sourceAssignment: input.sourceAssignment,
    requestedOperation: 'intake_source_review',
    initiatedByType: 'SYSTEM',
    initiatedById,
    auditRole: 'SYSTEM',
    messageRole: 'SYSTEM',
    sourceDispatch: {
      version: 1,
      dispatchId: input.dispatchId,
      policyRevision: input.policyRevision,
    },
    requireContentDraft: true,
  })
}
