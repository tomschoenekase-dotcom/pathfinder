import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AgentWorkflowCanaryPolicySchema } from '@pathfinder/contracts/agent-workflow-activation'
import { db } from '../client'
import {
  agentWorkflowBindingHash,
  agentWorkflowActivationEventHash,
  agentWorkflowSelectionProof,
  AgentWorkflowRunLeaseError,
} from './agent-workflow-run-lease'
import {
  agentWorkflowManifestHash,
  isAgentWorkflowArtifactIntact,
} from './agent-workflow-registry-actions'

const inputSchema = z
  .object({
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    agentRunId: z.string().min(1).max(191),
    runType: z.string().min(1).max(100),
    operation: z.string().min(1).max(100),
    registryKeys: z.array(z.string().min(1).max(191)).max(50),
  })
  .strict()

type Tx = Pick<
  typeof db,
  '$queryRaw' | 'agentWorkflowActivationHead' | 'agentWorkflowRunBinding' | 'agentWorkflowVersion'
>
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export async function lockAgentWorkflowActivationHeads(
  transaction: Pick<Tx, '$queryRaw'>,
  input: { tenantId: string; venueId: string; registryKeys: string[]; maxKeys?: number },
) {
  const keys = [...new Set(input.registryKeys)].sort()
  if (keys.length > (input.maxKeys ?? 50))
    throw new AgentWorkflowRunLeaseError(
      'CORRUPT_BINDING',
      'Workflow registry lock set exceeds the bounded context',
    )
  for (const registryKey of keys)
    await transaction.$queryRaw`SELECT id FROM agent_workflow_activation_heads WHERE tenant_id=${input.tenantId} AND venue_id=${input.venueId} AND registry_key=${registryKey} FOR UPDATE`
  return keys
}

export async function resolveActiveAgentWorkflowRegistryKeys(
  transaction: Pick<Tx, 'agentWorkflowActivationHead'>,
  input: { tenantId: string; venueId: string },
) {
  const heads = await transaction.agentWorkflowActivationHead.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      activeVersionId: { not: null },
    },
    select: { registryKey: true },
    orderBy: { registryKey: 'asc' },
    take: 51,
  })
  if (heads.length > 50)
    throw new AgentWorkflowRunLeaseError(
      'CORRUPT_BINDING',
      'Active workflow registry exceeds the bounded run context',
    )
  return heads.map((head) => head.registryKey)
}

export async function bindAgentWorkflowVersions(transaction: Tx, raw: z.input<typeof inputSchema>) {
  const input = inputSchema.parse(raw)
  const keys = await lockAgentWorkflowActivationHeads(transaction, {
    tenantId: input.tenantId,
    venueId: input.venueId,
    registryKeys: input.registryKeys,
  })
  const runs = await transaction.$queryRaw<
    Array<{ status: string; attemptNumber: number; leaseToken: string | null }>
  >`SELECT status, attempt_number AS "attemptNumber", execution_lease_token AS "leaseToken"
      FROM agent_runs WHERE id=${input.agentRunId} AND tenant_id=${input.tenantId}
      AND venue_id=${input.venueId} FOR UPDATE`
  if (runs.length !== 1)
    throw new AgentWorkflowRunLeaseError('CORRUPT_BINDING', 'Scoped agent run is unavailable')
  const existing = await transaction.agentWorkflowRunBinding.findMany({
    where: { tenantId: input.tenantId, venueId: input.venueId, agentRunId: input.agentRunId },
    include: { workflowVersion: true, activationEvent: true },
    orderBy: { registryKey: 'asc' },
    take: 51,
  })
  if (existing.length) {
    if (
      existing.length !== keys.length ||
      existing.some((row, index) => row.registryKey !== keys[index])
    )
      throw new AgentWorkflowRunLeaseError(
        'CORRUPT_BINDING',
        'Run already has a different workflow selection',
      )
    return { bindings: existing, replayed: true as const }
  }
  if (runs[0]!.status !== 'QUEUED' || runs[0]!.attemptNumber !== 0 || runs[0]!.leaseToken)
    throw new AgentWorkflowRunLeaseError(
      'REVOKED',
      'Workflow selection must be frozen before execution starts',
    )
  const created = []
  for (const registryKey of keys) {
    const head = await transaction.agentWorkflowActivationHead.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId, registryKey },
      include: { activationEvent: true, activeVersion: true },
    })
    let outcome: 'SELECTED' | 'CANARY_SKIPPED_NO_WORKFLOW' | 'CANARY_SKIPPED_PRIOR_VERSION'
    let selectionReason:
      | 'HASH_SELECTED'
      | 'HASH_SKIPPED'
      | 'CAPACITY_EXHAUSTED'
      | 'NO_ACTIVE_WORKFLOW'
      | 'INELIGIBLE_RUN'
      | 'WINDOW_INACTIVE'
    let selectionOrdinal: number | null = null
    let workflowVersion = null
    if (!head?.activationEvent || !head.activeVersion) {
      outcome = 'CANARY_SKIPPED_NO_WORKFLOW'
      selectionReason = 'NO_ACTIVE_WORKFLOW'
    } else {
      const event = head.activationEvent
      const policyResult = AgentWorkflowCanaryPolicySchema.safeParse(event.canaryPolicy)
      if (!policyResult.success || !isAgentWorkflowArtifactIntact(head.activeVersion))
        throw new AgentWorkflowRunLeaseError(
          'CORRUPT_BINDING',
          'Current workflow activation is corrupt',
        )
      const policy = policyResult.data
      const clock = await transaction.$queryRaw<
        Array<{ now: Date }>
      >`SELECT clock_timestamp() AS now`
      const now = clock[0]?.now
      const eligible =
        policy.eligibleRunTypes.includes(input.runType) &&
        policy.eligibleOperations.includes(input.operation)
      const windowActive =
        Boolean(now) && now! >= new Date(policy.startsAt) && now! < new Date(policy.endsAt)
      const bucket =
        BigInt(
          `0x${digest(`${policy.salt}\u0000${input.agentRunId}\u0000${registryKey}`).slice(0, 16)}`,
        ) % BigInt(policy.denominator)
      const selectedByHash = bucket < BigInt(policy.numerator)
      if (!eligible || !windowActive) {
        outcome = 'CANARY_SKIPPED_NO_WORKFLOW'
        selectionReason = eligible ? 'WINDOW_INACTIVE' : 'INELIGIBLE_RUN'
      } else if (selectedByHash && head.selectedRunCount < policy.maxSelectedRuns) {
        const updated = await transaction.agentWorkflowActivationHead.updateMany({
          where: { id: head.id, revision: head.revision, selectedRunCount: head.selectedRunCount },
          data: { selectedRunCount: { increment: 1 } },
        })
        if (updated.count !== 1)
          throw new AgentWorkflowRunLeaseError('REVOKED', 'Workflow capacity CAS lost')
        outcome = 'SELECTED'
        selectionReason = 'HASH_SELECTED'
        selectionOrdinal = head.selectedRunCount + 1
        workflowVersion = head.activeVersion
      } else {
        selectionReason = selectedByHash ? 'CAPACITY_EXHAUSTED' : 'HASH_SKIPPED'
        if (policy.skippedBaseline.kind === 'PRIOR_VERSION') {
          outcome = 'CANARY_SKIPPED_PRIOR_VERSION'
          workflowVersion = await transaction.agentWorkflowVersion.findFirst({
            where: {
              id: policy.skippedBaseline.workflowVersionId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              registryKey,
              contentHash: policy.skippedBaseline.contentHash,
            },
          })
          if (!workflowVersion || !isAgentWorkflowArtifactIntact(workflowVersion))
            throw new AgentWorkflowRunLeaseError(
              'CORRUPT_BINDING',
              'Reviewed prior workflow baseline is unavailable or corrupt',
            )
        } else outcome = 'CANARY_SKIPPED_NO_WORKFLOW'
      }
      const eventHash = agentWorkflowActivationEventHash({
        tenantId: event.tenantId,
        venueId: event.venueId,
        registryKey: event.registryKey,
        kind: event.kind,
        priorVersionId: event.priorVersionId,
        resultingVersionId: event.resultingVersionId,
        promotionAssessmentId: event.promotionAssessmentId,
        approvalDecisionId: event.approvalDecisionId,
        priorRevision: event.priorRevision,
        resultingRevision: event.resultingRevision,
        evidenceDigest: event.evidenceDigest,
        canaryPolicy: event.canaryPolicy,
        requiredCapabilities: event.requiredCapabilities,
        reason: event.reason,
        createdBy: event.createdBy,
      })
      if (event.eventHash !== eventHash)
        throw new AgentWorkflowRunLeaseError('CORRUPT_BINDING', 'Activation event hash mismatch')
    }
    const activationEventId = head?.activationEventId ?? null
    const workflowVersionId = workflowVersion?.id ?? null
    const requiredCapabilities = [...(workflowVersion?.requiredToolCapabilities ?? [])].sort()
    const proof = agentWorkflowSelectionProof({
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentRunId: input.agentRunId,
      registryKey,
      activationEventHash: head?.activationEvent?.eventHash ?? null,
      policyHash: head?.activationEvent
        ? agentWorkflowManifestHash(head.activationEvent.canaryPolicy)
        : null,
      selectionReason,
      selectionOrdinal,
    })
    const identity = {
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentRunId: input.agentRunId,
      registryKey,
      outcome,
      workflowVersionId,
      activationEventId,
      headRevision: head?.revision ?? 0,
      selectionProof: proof,
      selectionReason,
      selectionOrdinal,
      requiredCapabilities,
    }
    created.push(
      await transaction.agentWorkflowRunBinding.create({
        data: { ...identity, bindingHash: agentWorkflowBindingHash(identity) },
        include: { workflowVersion: true, activationEvent: true },
      }),
    )
  }
  return { bindings: created, replayed: false as const }
}

/** Resolve scoped active keys server-side. Use inside the run-creation transaction. */
export async function bindEligibleAgentWorkflows(
  transaction: Tx,
  input: Omit<z.input<typeof inputSchema>, 'registryKeys'>,
) {
  const registryKeys = await resolveActiveAgentWorkflowRegistryKeys(transaction, input)
  return bindAgentWorkflowVersions(transaction, {
    ...input,
    registryKeys,
  })
}
