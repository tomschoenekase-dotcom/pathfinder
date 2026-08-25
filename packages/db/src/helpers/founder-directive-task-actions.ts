import { createHash } from 'node:crypto'

import {
  FOUNDER_DIRECTIVE_TASK_MATERIALIZE_ACTION,
  PlatformWorkerFounderDirectiveTaskRequest,
} from '@pathfinder/contracts/platform-worker-policy'
import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const actor = z
  .object({
    type: z.literal('AGENT'),
    id: z.string().trim().min(1).max(191),
    credentialId: z.string().trim().min(1).max(191),
    capability: z.enum(['founder-directive-tasks:propose', 'founder-directive-tasks:materialize']),
  })
  .strict()

type ProposeRequest = Extract<
  z.infer<typeof PlatformWorkerFounderDirectiveTaskRequest>,
  { action: 'propose' }
>
type MaterializeRequest = Extract<
  z.infer<typeof PlatformWorkerFounderDirectiveTaskRequest>,
  { action: 'materialize' }
>

export type FounderDirectiveTaskClient = Pick<
  typeof db,
  '$transaction' | 'founderDirectiveTaskRequest'
>

export class FounderDirectiveTaskError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'INACTIVE_CREDENTIAL',
    message: string,
  ) {
    super(message)
    this.name = 'FounderDirectiveTaskError'
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const isUniqueConflict = (error: unknown) =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')

const proposalSelect = {
  id: true,
  operationId: true,
  operationHash: true,
  founderOperatingExchangeId: true,
  sourceSnapshotHash: true,
  tenantId: true,
  venueId: true,
  agentIdentityId: true,
  approvalRequestId: true,
  proposedPrompt: true,
  rationale: true,
  constraints: true,
  prospectScope: true,
  status: true,
  materializationOperationId: true,
  materializationHash: true,
  agentRunId: true,
  requestedById: true,
  credentialId: true,
  createdAt: true,
  updatedAt: true,
  approvalRequest: {
    select: {
      proposedAction: true,
      riskCategory: true,
      expiresAt: true,
      decision: { select: { id: true, decision: true, reason: true, createdAt: true } },
    },
  },
  agentIdentity: { select: { name: true, enabled: true } },
  agentRun: { select: { id: true, status: true, createdAt: true } },
} as const

function proposalHash(input: ProposeRequest, actorInput: z.infer<typeof actor>) {
  return hash({
    action: 'founder-directive-task.propose.v1',
    operationId: input.operationId,
    source: {
      id: input.founderOperatingExchangeId,
      snapshotHash: input.expectedSnapshotHash,
    },
    scope: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentIdentityId: input.agentIdentityId,
      prospectScope: input.prospectScope ?? null,
    },
    proposedPrompt: input.proposedPrompt,
    rationale: input.rationale,
    riskCategory: input.riskCategory,
    constraints: input.constraints,
    expiresAt: input.expiresAt ?? null,
    actor: actorInput,
  })
}

function sameProposal(
  existing: {
    founderOperatingExchangeId: string
    sourceSnapshotHash: string
    tenantId: string
    venueId: string
    agentIdentityId: string
    proposedPrompt: string
    rationale: string
    constraints: string[]
    prospectScope: unknown
    requestedById: string
    credentialId: string
    approvalRequest: { riskCategory: string; expiresAt: Date | null }
  },
  input: ProposeRequest,
  actorInput: z.infer<typeof actor>,
) {
  return (
    existing.founderOperatingExchangeId === input.founderOperatingExchangeId &&
    existing.sourceSnapshotHash === input.expectedSnapshotHash &&
    existing.tenantId === input.tenantId &&
    existing.venueId === input.venueId &&
    existing.agentIdentityId === input.agentIdentityId &&
    existing.proposedPrompt === input.proposedPrompt &&
    existing.rationale === input.rationale &&
    canonical(existing.constraints) === canonical(input.constraints) &&
    canonical(existing.prospectScope ?? null) === canonical(input.prospectScope ?? null) &&
    existing.requestedById === actorInput.id &&
    existing.credentialId === actorInput.credentialId &&
    existing.approvalRequest.riskCategory === input.riskCategory &&
    (existing.approvalRequest.expiresAt?.toISOString() ?? null) === (input.expiresAt ?? null)
  )
}

async function activeCredential(
  transaction: Pick<typeof db, 'platformWorkerPolicyCredential'>,
  actorInput: z.infer<typeof actor>,
) {
  const credential = await transaction.platformWorkerPolicyCredential.findFirst({
    where: {
      id: actorInput.credentialId,
      workerId: actorInput.id,
      enabled: true,
      revokedAt: null,
      capabilities: { has: actorInput.capability },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  })
  if (!credential) {
    throw new FounderDirectiveTaskError(
      'INACTIVE_CREDENTIAL',
      `An active ${actorInput.capability} credential is required.`,
    )
  }
}

/**
 * Converts one retained directive into an exact human approval request. No task,
 * queue job, provider call, customer contact, price, billing effect, deployment,
 * policy mutation, or data mutation is authorized by this proposal.
 */
export async function proposeFounderDirectiveTaskAction(
  rawInput: unknown,
  client: FounderDirectiveTaskClient = db,
) {
  const candidate = rawInput && typeof rawInput === 'object' ? rawInput : {}
  const { actor: rawActor, ...rawRequest } = candidate as Record<string, unknown>
  const parsed = PlatformWorkerFounderDirectiveTaskRequest.safeParse(rawRequest)
  const parsedActor = actor.safeParse(rawActor)
  if (!parsed.success || parsed.data.action !== 'propose' || !parsedActor.success) {
    throw new FounderDirectiveTaskError(
      'INVALID_INPUT',
      'Founder directive task proposal is invalid.',
    )
  }
  if (parsedActor.data.capability !== 'founder-directive-tasks:propose') {
    throw new FounderDirectiveTaskError('FORBIDDEN', 'The proposal capability is required.')
  }
  const input = parsed.data
  const actorInput = parsedActor.data
  const expectedOperationHash = proposalHash(input, actorInput)
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
  if (expiresAt && expiresAt <= new Date()) {
    throw new FounderDirectiveTaskError('INVALID_INPUT', 'Approval expiry must be in the future.')
  }

  const attempt = () =>
    client.$transaction(async (transaction) => {
      const existingByOperation = await transaction.founderDirectiveTaskRequest.findUnique({
        where: { operationId: input.operationId },
        select: proposalSelect,
      })
      if (existingByOperation) {
        if (existingByOperation.operationHash !== expectedOperationHash) {
          throw new FounderDirectiveTaskError(
            'CONFLICT',
            'The proposal operation ID was already used for different work.',
          )
        }
        return {
          request: existingByOperation,
          replayed: true as const,
          deduplicated: false as const,
        }
      }

      const existingBySource = await transaction.founderDirectiveTaskRequest.findUnique({
        where: { founderOperatingExchangeId: input.founderOperatingExchangeId },
        select: proposalSelect,
      })
      if (existingBySource) {
        if (!sameProposal(existingBySource, input, actorInput)) {
          throw new FounderDirectiveTaskError(
            'CONFLICT',
            'This founder directive already has a different task proposal.',
          )
        }
        return { request: existingBySource, replayed: true as const, deduplicated: true as const }
      }

      await activeCredential(transaction, actorInput)
      const [exchange, identity, venue] = await Promise.all([
        transaction.founderOperatingExchange.findUnique({
          where: { id: input.founderOperatingExchangeId },
          select: { id: true, intent: true, disposition: true, snapshotHash: true },
        }),
        transaction.agentIdentity.findFirst({
          where: {
            id: input.agentIdentityId,
            tenantId: input.tenantId,
            enabled: true,
            OR: [
              { venueId: input.venueId },
              { venueId: null, accessScope: { in: ['CLIENT', 'PLATFORM'] } },
            ],
          },
          select: {
            id: true,
            agentType: true,
            accessScope: true,
            accessCapabilities: true,
          },
        }),
        transaction.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        }),
      ])
      if (
        !exchange ||
        exchange.intent !== 'DIRECTIVE' ||
        exchange.disposition !== 'RECORDED_FOR_TRIAGE' ||
        exchange.snapshotHash !== input.expectedSnapshotHash
      ) {
        throw new FounderDirectiveTaskError(
          'CONFLICT',
          'The source is not the exact retained founder directive snapshot.',
        )
      }
      if (!venue) throw new FounderDirectiveTaskError('NOT_FOUND', 'Task venue was not found.')
      if (!identity) {
        throw new FounderDirectiveTaskError(
          'FORBIDDEN',
          'The enabled task identity is not in the requested venue scope.',
        )
      }
      if (
        input.prospectScope &&
        !identity.accessCapabilities.some((capability) => capability.startsWith('prospects.'))
      ) {
        throw new FounderDirectiveTaskError(
          'FORBIDDEN',
          'The task identity has no prospect capability for the requested prospect scope.',
        )
      }
      if (input.prospectScope?.mode === 'TERRITORIES') {
        const territoryCount = await transaction.prospectTerritory.count({
          where: { id: { in: input.prospectScope.territoryIds }, archivedAt: null },
        })
        if (territoryCount !== input.prospectScope.territoryIds.length) {
          throw new FounderDirectiveTaskError(
            'NOT_FOUND',
            'The task proposal contains an unknown prospect territory.',
          )
        }
      }

      const approvalRequest = await transaction.approvalRequest.create({
        data: {
          id: input.operationId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentIdentityId: identity.id,
          requestedByType: 'AGENT',
          requestedById: actorInput.id,
          proposedAction: FOUNDER_DIRECTIVE_TASK_MATERIALIZE_ACTION,
          scopeSnapshot: {
            contractVersion: 1,
            founderOperatingExchangeId: exchange.id,
            sourceSnapshotHash: exchange.snapshotHash,
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentIdentityId: identity.id,
            agentType: identity.agentType,
            proposedPrompt: input.proposedPrompt,
            constraints: input.constraints,
            prospectScope: input.prospectScope ?? null,
            executionAuthorized: false,
            customerContactAuthorized: false,
            pricingAuthorized: false,
            billingAuthorized: false,
            deploymentAuthorized: false,
            policyMutationAuthorized: false,
            valuableDataDestructionAuthorized: false,
          },
          reason: input.rationale,
          riskCategory: input.riskCategory,
          artifacts: [
            {
              type: 'FounderOperatingExchange',
              id: exchange.id,
              snapshotHash: exchange.snapshotHash,
            },
          ],
          expiresAt,
        },
        select: { id: true },
      })

      const created = await transaction.founderDirectiveTaskRequest.create({
        data: {
          operationId: input.operationId,
          operationHash: expectedOperationHash,
          founderOperatingExchangeId: exchange.id,
          sourceSnapshotHash: exchange.snapshotHash,
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentIdentityId: identity.id,
          approvalRequestId: approvalRequest.id,
          proposedPrompt: input.proposedPrompt,
          rationale: input.rationale,
          constraints: input.constraints,
          ...(input.prospectScope ? { prospectScope: input.prospectScope } : {}),
          requestedById: actorInput.id,
          credentialId: actorInput.credentialId,
        },
        select: proposalSelect,
      })

      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: actorInput.id,
          actorRole: 'PLATFORM_POLICY_WORKER',
          actorType: 'AGENT',
          credentialId: actorInput.credentialId,
          capability: actorInput.capability,
          action: 'founder-directive.task-proposed',
          targetType: 'FounderDirectiveTaskRequest',
          targetId: created.id,
          sourceReferences: [
            { type: 'FounderOperatingExchange', id: exchange.id, hash: exchange.snapshotHash },
          ],
          structuredReason: {
            effect: 'APPROVAL_REQUEST_ONLY',
            riskCategory: input.riskCategory,
            constraintCount: input.constraints.length,
          },
          afterState: {
            status: created.status,
            approvalRequestId: created.approvalRequestId,
            taskCreated: false,
            executionTriggered: false,
            customerContacted: false,
            pricingChanged: false,
            billingChanged: false,
            deployed: false,
            policyChanged: false,
          },
        },
        transaction,
      )
      return { request: created, replayed: false as const, deduplicated: false as const }
    })

  try {
    return await attempt()
  } catch (error) {
    if (error instanceof FounderDirectiveTaskError || !isUniqueConflict(error)) throw error
    return attempt().catch((retryError) => {
      if (retryError instanceof FounderDirectiveTaskError) throw retryError
      throw new FounderDirectiveTaskError(
        'CONFLICT',
        'The founder directive task proposal changed concurrently.',
      )
    })
  }
}

function materializationHash(
  input: MaterializeRequest,
  actorInput: z.infer<typeof actor>,
  request: { sourceSnapshotHash: string; proposedPrompt: string; approvalRequestId: string },
) {
  return hash({
    action: 'founder-directive-task.materialize.v1',
    operationId: input.operationId,
    requestId: input.requestId,
    expectedApprovalDecisionId: input.expectedApprovalDecisionId,
    sourceSnapshotHash: request.sourceSnapshotHash,
    proposedPrompt: request.proposedPrompt,
    approvalRequestId: request.approvalRequestId,
    actor: actorInput,
  })
}

/** Materializes an already-approved exact proposal into one canonical queued agent run. */
export async function materializeFounderDirectiveTaskAction(
  rawInput: unknown,
  client: FounderDirectiveTaskClient = db,
) {
  const candidate = rawInput && typeof rawInput === 'object' ? rawInput : {}
  const { actor: rawActor, ...rawRequest } = candidate as Record<string, unknown>
  const parsed = PlatformWorkerFounderDirectiveTaskRequest.safeParse(rawRequest)
  const parsedActor = actor.safeParse(rawActor)
  if (!parsed.success || parsed.data.action !== 'materialize' || !parsedActor.success) {
    throw new FounderDirectiveTaskError(
      'INVALID_INPUT',
      'Founder directive task materialization is invalid.',
    )
  }
  if (parsedActor.data.capability !== 'founder-directive-tasks:materialize') {
    throw new FounderDirectiveTaskError('FORBIDDEN', 'The materialization capability is required.')
  }
  const input = parsed.data
  const actorInput = parsedActor.data

  const attempt = () =>
    client.$transaction(async (transaction) => {
      await activeCredential(transaction, actorInput)
      const request = await transaction.founderDirectiveTaskRequest.findUnique({
        where: { id: input.requestId },
        select: {
          ...proposalSelect,
          agentIdentity: {
            select: {
              id: true,
              enabled: true,
              venueId: true,
              agentType: true,
              accessScope: true,
              accessCapabilities: true,
              autonomyLevel: true,
              autonomousActions: true,
              defaultProvider: true,
              defaultModel: true,
            },
          },
        },
      })
      if (!request)
        throw new FounderDirectiveTaskError('NOT_FOUND', 'Directive task was not found.')
      const expectedHash = materializationHash(input, actorInput, request)
      if (request.status === 'MATERIALIZED') {
        if (
          request.materializationOperationId !== input.operationId ||
          request.materializationHash !== expectedHash ||
          !request.agentRun
        ) {
          throw new FounderDirectiveTaskError(
            'CONFLICT',
            'The directive task was already materialized by different work.',
          )
        }
        return { request, run: request.agentRun, replayed: true as const }
      }
      if (request.status !== 'APPROVED') {
        throw new FounderDirectiveTaskError(
          'FORBIDDEN',
          'Only an exact approved directive task can be materialized.',
        )
      }
      const decision = request.approvalRequest.decision
      if (
        !decision ||
        decision.id !== input.expectedApprovalDecisionId ||
        decision.decision !== 'APPROVED'
      ) {
        throw new FounderDirectiveTaskError(
          'CONFLICT',
          'The exact approved decision no longer matches this directive task.',
        )
      }
      const identity = request.agentIdentity
      if (
        !identity.enabled ||
        !(
          identity.venueId === request.venueId ||
          (identity.venueId === null && ['CLIENT', 'PLATFORM'].includes(identity.accessScope))
        )
      ) {
        throw new FounderDirectiveTaskError(
          'FORBIDDEN',
          'The approved task identity is no longer enabled in scope.',
        )
      }

      const run = await transaction.agentRun.create({
        data: {
          operationId: input.operationId,
          tenantId: request.tenantId,
          venueId: request.venueId,
          agentIdentityId: identity.id,
          runType: identity.agentType,
          requestedOperation: 'founder_directive_task',
          requestPrompt: request.proposedPrompt,
          scopeSnapshot: {
            accessScope: identity.accessScope,
            accessCapabilities: identity.accessCapabilities,
            autonomyLevel: identity.autonomyLevel,
            autonomousActions: identity.autonomousActions,
            founderDirective: {
              requestId: request.id,
              exchangeId: request.founderOperatingExchangeId,
              sourceSnapshotHash: request.sourceSnapshotHash,
              approvalRequestId: request.approvalRequestId,
              approvalDecisionId: decision.id,
              constraints: request.constraints,
            },
            ...(request.prospectScope ? { prospectScope: request.prospectScope } : {}),
            authority: {
              taskMaterializationApproved: true,
              customerContactAuthorized: false,
              pricingAuthorized: false,
              billingAuthorized: false,
              deploymentAuthorized: false,
              policyMutationAuthorized: false,
              valuableDataDestructionAuthorized: false,
            },
          },
          status: 'QUEUED',
          modelProvider: identity.defaultProvider,
          modelName: identity.defaultModel,
          initiatedByType: 'AGENT',
          initiatedById: actorInput.id,
        },
        select: { id: true, status: true, createdAt: true },
      })
      await transaction.agentTimelineEvent.create({
        data: {
          tenantId: request.tenantId,
          venueId: request.venueId,
          agentRunId: run.id,
          actorType: 'AGENT',
          actorId: actorInput.id,
          eventType: 'FOUNDER_DIRECTIVE_TASK_QUEUED',
          message: 'An exact founder-approved directive task was materialized for this agent.',
          data: {
            founderDirectiveTaskRequestId: request.id,
            approvalRequestId: request.approvalRequestId,
            approvalDecisionId: decision.id,
          },
        },
      })
      await transaction.agentMessage.create({
        data: {
          tenantId: request.tenantId,
          venueId: request.venueId,
          agentRunId: run.id,
          agentIdentityId: identity.id,
          role: 'OPERATOR',
          messageType: 'PROMPT',
          content: request.proposedPrompt,
          actorId: actorInput.id,
        },
      })
      const updated = await transaction.founderDirectiveTaskRequest.updateMany({
        where: { id: request.id, status: 'APPROVED', agentRunId: null },
        data: {
          status: 'MATERIALIZED',
          materializationOperationId: input.operationId,
          materializationHash: expectedHash,
          agentRunId: run.id,
        },
      })
      if (updated.count !== 1) {
        throw new FounderDirectiveTaskError(
          'CONFLICT',
          'The directive task changed before materialization completed.',
        )
      }
      await writeAuditLogStrict(
        {
          tenantId: request.tenantId,
          actorId: actorInput.id,
          actorRole: 'PLATFORM_POLICY_WORKER',
          actorType: 'AGENT',
          credentialId: actorInput.credentialId,
          capability: actorInput.capability,
          action: 'founder-directive.task-materialized',
          targetType: 'AgentRun',
          targetId: run.id,
          sourceReferences: [
            { type: 'FounderDirectiveTaskRequest', id: request.id },
            { type: 'ApprovalDecision', id: decision.id },
          ],
          structuredReason: {
            effect: 'CANONICAL_AGENT_TASK_ONLY',
            approvalRequestId: request.approvalRequestId,
          },
          afterState: {
            status: 'QUEUED',
            executionTriggered: false,
            customerContacted: false,
            pricingChanged: false,
            billingChanged: false,
            deployed: false,
            policyChanged: false,
          },
        },
        transaction,
      )
      return {
        request: { ...request, status: 'MATERIALIZED' as const, agentRunId: run.id },
        run,
        replayed: false as const,
      }
    })

  try {
    return await attempt()
  } catch (error) {
    if (error instanceof FounderDirectiveTaskError || !isUniqueConflict(error)) throw error
    return attempt().catch((retryError) => {
      if (retryError instanceof FounderDirectiveTaskError) throw retryError
      throw new FounderDirectiveTaskError(
        'CONFLICT',
        'The founder directive task materialization changed concurrently.',
      )
    })
  }
}

export async function readFounderDirectiveTasks(
  input: { limit?: number; status?: string },
  client: Pick<typeof db, 'founderDirectiveTaskRequest'> = db,
) {
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)))
  const parsedStatus = z
    .enum(['AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'MATERIALIZED'])
    .optional()
    .safeParse(input.status)
  if (!parsedStatus.success) {
    throw new FounderDirectiveTaskError('INVALID_INPUT', 'Directive task status is invalid.')
  }
  const items = await client.founderDirectiveTaskRequest.findMany({
    ...(parsedStatus.data ? { where: { status: parsedStatus.data } } : {}),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: proposalSelect,
  })
  return {
    schemaVersion: 'torchiko.founder-directive-tasks.v1' as const,
    generatedAt: new Date(),
    items,
    boundaries: {
      proposalIsExecution: false as const,
      approvalIsExecution: false as const,
      exactApprovalRequiredToMaterialize: true as const,
      separateMaterializationCapabilityRequired: true as const,
      customerContactAuthorized: false as const,
      pricingAuthorized: false as const,
      billingAuthorized: false as const,
      deploymentAuthorized: false as const,
      policyMutationAuthorized: false as const,
      valuableDataDestructionAuthorized: false as const,
    },
  }
}
