import { z } from 'zod'
import type { AgentWorkflowSupportedActionClass } from '@pathfinder/contracts/agent-workflow-activation'
import {
  AgentWorkflowCanaryPolicySchema,
  AgentWorkflowSupportedActionClassSchema,
} from '@pathfinder/contracts/agent-workflow-activation'
import { db } from '../client'
import {
  agentWorkflowManifestHash,
  isAgentWorkflowArtifactIntact,
} from './agent-workflow-registry-actions'
import { createHash } from 'node:crypto'

export const agentWorkflowSelectionProof = (value: {
  tenantId: string
  venueId: string
  agentRunId: string
  registryKey: string
  activationEventHash: string | null
  policyHash: string | null
  selectionReason: string
  selectionOrdinal: number | null
}) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        value.tenantId,
        value.venueId,
        value.agentRunId,
        value.registryKey,
        value.activationEventHash,
        value.policyHash,
        value.selectionReason,
        value.selectionOrdinal,
      ]),
    )
    .digest('hex')

export const agentWorkflowBindingHash = (value: {
  tenantId: string
  venueId: string
  agentRunId: string
  registryKey: string
  outcome: string
  workflowVersionId: string | null
  activationEventId: string | null
  headRevision: number
  selectionProof: string
  selectionReason: string
  selectionOrdinal: number | null
  requiredCapabilities: string[]
}) => agentWorkflowManifestHash(value)
export const agentWorkflowActivationEventHash = (value: {
  tenantId: string
  venueId: string
  registryKey: string
  kind: string
  priorVersionId: string | null
  resultingVersionId: string | null
  promotionAssessmentId: string | null
  approvalDecisionId: string
  priorRevision: number
  resultingRevision: number
  evidenceDigest: string
  canaryPolicy: unknown
  requiredCapabilities: string[]
  reason: string
  createdBy: string
}) =>
  agentWorkflowManifestHash({
    ...value,
    requiredCapabilities: [...value.requiredCapabilities].sort(),
  })

export class AgentWorkflowRunLeaseError extends Error {
  constructor(
    readonly code: 'LEASE_LOST' | 'REVOKED' | 'UNSUPPORTED_ACTION' | 'CORRUPT_BINDING',
    message: string,
  ) {
    super(message)
    this.name = 'AgentWorkflowRunLeaseError'
  }
}
const inputSchema = z
  .object({
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    agentRunId: z.string().min(1).max(191),
    executionLeaseToken: z.string().uuid(),
    actionClass: AgentWorkflowSupportedActionClassSchema.optional(),
    availableCapabilities: z.array(z.string().min(1).max(191)).max(200).optional(),
  })
  .strict()
export type WorkflowRunLeaseTransaction = Pick<
  typeof db,
  | '$queryRaw'
  | 'agentWorkflowRunBinding'
  | 'agentWorkflowActivationHead'
  | 'agentRun'
  | 'agentWorker'
  | 'externalAccessCredential'
>

async function readDatabaseClock(tx: Pick<WorkflowRunLeaseTransaction, '$queryRaw'>) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  return rows[0]?.now
}

export async function assertEligibleWorkflowRunLease(
  tx: WorkflowRunLeaseTransaction,
  raw: {
    tenantId: string
    venueId: string
    agentRunId: string
    executionLeaseToken: string
    actionClass?: AgentWorkflowSupportedActionClass
    availableCapabilities?: string[]
  },
) {
  const input = inputSchema.parse(raw)
  const initialBindings = await tx.agentWorkflowRunBinding.findMany({
    where: { tenantId: input.tenantId, venueId: input.venueId, agentRunId: input.agentRunId },
    select: { registryKey: true },
    orderBy: { registryKey: 'asc' },
    take: 51,
  })
  if (initialBindings.length > 50)
    throw new AgentWorkflowRunLeaseError('CORRUPT_BINDING', 'Workflow binding limit exceeded')
  for (const registryKey of [...new Set(initialBindings.map((item) => item.registryKey))].sort())
    await tx.$queryRaw`SELECT id FROM agent_workflow_activation_heads WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId} AND registry_key = ${registryKey} FOR UPDATE`
  const rows = await tx.$queryRaw<
    Array<{ id: string; executionLeaseExpiresAt: Date; cancelRequestedAt: Date | null }>
  >`
    SELECT id, execution_lease_expires_at AS "executionLeaseExpiresAt",
      cancel_requested_at AS "cancelRequestedAt" FROM agent_runs
    WHERE id = ${input.agentRunId} AND tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
      AND status = 'RUNNING' AND execution_lease_token = ${input.executionLeaseToken}::uuid
      AND execution_lease_expires_at > clock_timestamp()
    FOR UPDATE`
  if (rows.length !== 1)
    throw new AgentWorkflowRunLeaseError('LEASE_LOST', 'The exact live run lease is required')
  const bindings = await tx.agentWorkflowRunBinding.findMany({
    where: { tenantId: input.tenantId, venueId: input.venueId, agentRunId: input.agentRunId },
    include: { activationEvent: true, workflowVersion: true },
    orderBy: { registryKey: 'asc' },
    take: 51,
  })
  if (bindings.length > 50)
    throw new AgentWorkflowRunLeaseError('CORRUPT_BINDING', 'Workflow binding limit exceeded')
  const effectiveBindings = bindings.filter(
    (binding) =>
      binding.outcome === 'SELECTED' || binding.outcome === 'CANARY_SKIPPED_PRIOR_VERSION',
  )
  if (!effectiveBindings.length) {
    const checkedAt = await readDatabaseClock(tx)
    const lockedRun = rows[0]
    if (
      !checkedAt ||
      !Number.isFinite(checkedAt.getTime()) ||
      !lockedRun ||
      !(lockedRun.executionLeaseExpiresAt instanceof Date) ||
      !Number.isFinite(lockedRun.executionLeaseExpiresAt.getTime()) ||
      Boolean(lockedRun.cancelRequestedAt) ||
      lockedRun.executionLeaseExpiresAt <= checkedAt
    )
      throw new AgentWorkflowRunLeaseError(
        'LEASE_LOST',
        'The exact live run lease expired while admission was waiting',
      )
  }
  let effectiveCapabilities: string[] | undefined
  if (effectiveBindings.length) {
    let lockedWorker: { id: string; leaseExpiresAt: Date } | undefined
    let lockedCredential: { id: string; expiresAt: Date | null } | undefined
    const authority = await tx.agentRun.findFirst({
      where: { id: input.agentRunId, tenantId: input.tenantId, venueId: input.venueId },
      select: {
        executionWorkerId: true,
        agentIdentityId: true,
        agentIdentity: { select: { enabled: true, accessCapabilities: true } },
      },
    })
    if (authority)
      await tx.$queryRaw`SELECT id FROM agent_identities WHERE id=${authority.agentIdentityId}
        AND tenant_id=${input.tenantId} FOR SHARE`
    if (authority?.executionWorkerId) {
      const liveWorkers = await tx.$queryRaw<Array<{ id: string; leaseExpiresAt: Date }>>`SELECT id,
        lease_expires_at AS "leaseExpiresAt" FROM agent_workers
        WHERE id=${authority.executionWorkerId} AND tenant_id=${input.tenantId}
        AND status='ONLINE' AND lease_expires_at > clock_timestamp() FOR SHARE`
      if (liveWorkers.length !== 1)
        throw new AgentWorkflowRunLeaseError(
          'UNSUPPORTED_ACTION',
          'Current workflow worker lease is unavailable',
        )
      lockedWorker = liveWorkers[0]
    }
    const currentAuthority = authority
      ? await tx.agentRun.findFirst({
          where: { id: input.agentRunId, tenantId: input.tenantId, venueId: input.venueId },
          select: {
            executionWorkerId: true,
            agentIdentityId: true,
            agentIdentity: { select: { enabled: true, accessCapabilities: true } },
          },
        })
      : null
    const worker = currentAuthority?.executionWorkerId
      ? await tx.agentWorker.findFirst({
          where: {
            id: currentAuthority.executionWorkerId,
            tenantId: input.tenantId,
            status: 'ONLINE',
          },
          select: {
            capabilities: true,
            credentialId: true,
            clientId: true,
            credentialScopeKey: true,
          },
        })
      : null
    if (!currentAuthority?.agentIdentity.enabled || (currentAuthority.executionWorkerId && !worker))
      throw new AgentWorkflowRunLeaseError(
        'UNSUPPORTED_ACTION',
        'Current workflow execution authority is unavailable',
      )
    if (worker) {
      const credentials = await tx.$queryRaw<
        Array<{ id: string; expiresAt: Date | null }>
      >`SELECT id,
        expires_at AS "expiresAt"
        FROM external_access_credentials WHERE id=${worker.credentialId}
          AND tenant_id=${input.tenantId} AND client_id=${worker.clientId}
          AND scope_key=${worker.credentialScopeKey} AND enabled=TRUE AND revoked_at IS NULL
          AND (venue_id IS NULL OR venue_id=${input.venueId})
          AND (expires_at IS NULL OR expires_at > clock_timestamp()) FOR SHARE`
      if (credentials.length !== 1)
        throw new AgentWorkflowRunLeaseError(
          'UNSUPPORTED_ACTION',
          'Current workflow credential authority is unavailable',
        )
      lockedCredential = credentials[0]
      const credential = await tx.externalAccessCredential.findFirst({
        where: {
          id: worker.credentialId,
          tenantId: input.tenantId,
          clientId: worker.clientId,
          scopeKey: worker.credentialScopeKey,
          enabled: true,
          revokedAt: null,
        },
        select: { capabilities: true },
      })
      if (!credential)
        throw new AgentWorkflowRunLeaseError(
          'UNSUPPORTED_ACTION',
          'Current workflow credential authority is unavailable',
        )
      worker.capabilities = worker.capabilities.filter((capability) =>
        credential.capabilities.includes(capability),
      )
    }

    const authorityCheckedAt = await readDatabaseClock(tx)
    const lockedRun = rows[0]
    if (
      !authorityCheckedAt ||
      !Number.isFinite(authorityCheckedAt.getTime()) ||
      !lockedRun ||
      !(lockedRun.executionLeaseExpiresAt instanceof Date) ||
      !Number.isFinite(lockedRun.executionLeaseExpiresAt.getTime()) ||
      Boolean(lockedRun.cancelRequestedAt) ||
      (authorityCheckedAt && lockedRun.executionLeaseExpiresAt <= authorityCheckedAt) ||
      (worker &&
        (!lockedWorker ||
          (authorityCheckedAt && lockedWorker.leaseExpiresAt <= authorityCheckedAt))) ||
      (worker &&
        (!lockedCredential ||
          (authorityCheckedAt &&
            lockedCredential.expiresAt !== null &&
            lockedCredential.expiresAt <= authorityCheckedAt)))
    )
      throw new AgentWorkflowRunLeaseError(
        'LEASE_LOST',
        'Workflow execution authority expired while admission was waiting',
      )

    const workerCapabilities =
      worker?.capabilities ?? currentAuthority.agentIdentity.accessCapabilities
    effectiveCapabilities = currentAuthority.agentIdentity.accessCapabilities.filter(
      (capability) =>
        workerCapabilities.includes(capability) &&
        (!input.availableCapabilities || input.availableCapabilities.includes(capability)),
    )
  }
  for (const binding of bindings) {
    if (
      binding.bindingHash !==
        agentWorkflowBindingHash({
          tenantId: binding.tenantId,
          venueId: binding.venueId,
          agentRunId: binding.agentRunId,
          registryKey: binding.registryKey,
          outcome: binding.outcome,
          workflowVersionId: binding.workflowVersionId,
          activationEventId: binding.activationEventId,
          headRevision: binding.headRevision,
          selectionProof: binding.selectionProof,
          selectionReason: binding.selectionReason,
          selectionOrdinal: binding.selectionOrdinal,
          requiredCapabilities: [...binding.requiredCapabilities].sort(),
        }) ||
      binding.selectionProof !==
        agentWorkflowSelectionProof({
          tenantId: binding.tenantId,
          venueId: binding.venueId,
          agentRunId: binding.agentRunId,
          registryKey: binding.registryKey,
          activationEventHash: binding.activationEvent?.eventHash ?? null,
          policyHash: binding.activationEvent
            ? agentWorkflowManifestHash(binding.activationEvent.canaryPolicy)
            : null,
          selectionReason: binding.selectionReason,
          selectionOrdinal: binding.selectionOrdinal,
        })
    )
      throw new AgentWorkflowRunLeaseError('CORRUPT_BINDING', 'Workflow binding integrity failed')
    if (binding.selectionReason === 'NO_ACTIVE_WORKFLOW') continue
    if (
      effectiveCapabilities &&
      binding.requiredCapabilities.some(
        (capability) => !effectiveCapabilities!.includes(capability),
      )
    )
      throw new AgentWorkflowRunLeaseError(
        'UNSUPPORTED_ACTION',
        'Current run capability inventory cannot execute the selected workflow',
      )
    if (!binding.activationEvent)
      throw new AgentWorkflowRunLeaseError(
        'CORRUPT_BINDING',
        'Selected workflow binding has no activation event',
      )
    if (
      binding.activationEvent.eventHash !==
        agentWorkflowActivationEventHash({
          tenantId: binding.activationEvent.tenantId,
          venueId: binding.activationEvent.venueId,
          registryKey: binding.activationEvent.registryKey,
          kind: binding.activationEvent.kind,
          priorVersionId: binding.activationEvent.priorVersionId,
          resultingVersionId: binding.activationEvent.resultingVersionId,
          promotionAssessmentId: binding.activationEvent.promotionAssessmentId,
          approvalDecisionId: binding.activationEvent.approvalDecisionId,
          priorRevision: binding.activationEvent.priorRevision,
          resultingRevision: binding.activationEvent.resultingRevision,
          evidenceDigest: binding.activationEvent.evidenceDigest,
          canaryPolicy: binding.activationEvent.canaryPolicy,
          requiredCapabilities: binding.activationEvent.requiredCapabilities,
          reason: binding.activationEvent.reason,
          createdBy: binding.activationEvent.createdBy,
        }) ||
      binding.activationEvent.registryKey !== binding.registryKey ||
      binding.activationEvent.resultingRevision !== binding.headRevision ||
      (binding.outcome === 'SELECTED' &&
        binding.activationEvent.resultingVersionId !== binding.workflowVersionId)
    )
      throw new AgentWorkflowRunLeaseError('CORRUPT_BINDING', 'Activation event integrity failed')
    if (binding.outcome === 'CANARY_SKIPPED_NO_WORKFLOW') {
      if (
        !['HASH_SKIPPED', 'CAPACITY_EXHAUSTED', 'INELIGIBLE_RUN', 'WINDOW_INACTIVE'].includes(
          binding.selectionReason,
        ) ||
        binding.workflowVersionId !== null
      )
        throw new AgentWorkflowRunLeaseError(
          'CORRUPT_BINDING',
          'No-workflow selection has an invalid reason or artifact',
        )
      continue
    }
    if (
      !binding.workflowVersion ||
      !isAgentWorkflowArtifactIntact(binding.workflowVersion) ||
      binding.workflowVersion.registryKey !== binding.registryKey ||
      JSON.stringify([...binding.requiredCapabilities].sort()) !==
        JSON.stringify([...binding.workflowVersion.requiredToolCapabilities].sort())
    )
      throw new AgentWorkflowRunLeaseError(
        'CORRUPT_BINDING',
        'Workflow binding or artifact integrity failed',
      )
    const head = await tx.agentWorkflowActivationHead.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId, registryKey: binding.registryKey },
    })
    if (
      !head ||
      head.activationEventId !== binding.activationEventId ||
      head.revision !== binding.headRevision
    )
      throw new AgentWorkflowRunLeaseError('REVOKED', 'Workflow activation was revoked or replaced')
    const policy = AgentWorkflowCanaryPolicySchema.safeParse(binding.activationEvent.canaryPolicy)
    if (!policy.success)
      throw new AgentWorkflowRunLeaseError(
        'CORRUPT_BINDING',
        'Workflow activation policy is invalid',
      )
    if (
      binding.outcome === 'CANARY_SKIPPED_PRIOR_VERSION' &&
      (policy.data.skippedBaseline.kind !== 'PRIOR_VERSION' ||
        policy.data.skippedBaseline.workflowVersionId !== binding.workflowVersionId)
    )
      throw new AgentWorkflowRunLeaseError(
        'CORRUPT_BINDING',
        'Skipped workflow binding does not match its reviewed baseline',
      )
    const now = await readDatabaseClock(tx)
    if (!now || now < new Date(policy.data.startsAt) || now >= new Date(policy.data.endsAt))
      throw new AgentWorkflowRunLeaseError(
        'REVOKED',
        'Workflow canary execution window is not active',
      )
    if (input.actionClass && !policy.data.supportedActionClasses.includes(input.actionClass))
      throw new AgentWorkflowRunLeaseError(
        'UNSUPPORTED_ACTION',
        'Action class is not approved for this workflow',
      )
  }
  return {
    bindings: bindings.map(({ id, registryKey, outcome, workflowVersionId, bindingHash }) => ({
      id,
      registryKey,
      outcome,
      workflowVersionId,
      bindingHash,
    })),
  }
}

export async function withEligibleWorkflowRunLease<T>(
  input: Parameters<typeof assertEligibleWorkflowRunLease>[1],
  effect: (
    tx: WorkflowRunLeaseTransaction,
    context: Awaited<ReturnType<typeof assertEligibleWorkflowRunLease>>,
  ) => Promise<T>,
  client: Pick<typeof db, '$transaction'> = db,
) {
  return client.$transaction(async (rawTx) => {
    return effect(rawTx, await assertEligibleWorkflowRunLease(rawTx, input))
  })
}
