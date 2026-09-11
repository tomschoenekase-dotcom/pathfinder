import { z } from 'zod'

import {
  AgentAccessCapability,
  AgentIdentityType,
  McpCapability,
  VerifiedMcpCredentialScope,
} from '@pathfinder/contracts'
import { AgentWorkflowSupportedActionClassSchema } from '@pathfinder/contracts/agent-workflow-activation'

import type { WorkflowRunLeaseTransaction } from './agent-workflow-run-lease'
import { assertEligibleWorkflowRunLease } from './agent-workflow-run-lease'

const id = z.string().min(1).max(191)
const inputSchema = z
  .object({
    tenantId: id,
    clientId: id,
    venueId: id,
    agentRunId: id,
    executionLeaseToken: z.string().uuid(),
    bridgeSessionId: id,
    workerId: id,
    credentialScope: VerifiedMcpCredentialScope,
    requiredAgentType: AgentIdentityType,
    requiredIdentityCapability: AgentAccessCapability,
    requiredTransportCapabilities: z.array(McpCapability).min(1).max(McpCapability.options.length),
    actionClass: AgentWorkflowSupportedActionClassSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.requiredTransportCapabilities).size !==
      value.requiredTransportCapabilities.length
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredTransportCapabilities'],
        message: 'Required transport capabilities must be unique',
      })
  })

export type CurrentAgentWorkerClaimInput = z.input<typeof inputSchema>
export type CurrentAgentWorkerClaim = Readonly<{
  agentIdentityId: string
  workerId: string
  credentialId: string
  bridgeSessionId: string
}>

export class CurrentAgentWorkerClaimError extends Error {
  readonly code = 'CURRENT_AGENT_WORKER_CLAIM_DENIED'

  constructor(message = 'Current agent worker claim is unavailable.') {
    super(message)
    this.name = 'CurrentAgentWorkerClaimError'
  }
}

type Tx = WorkflowRunLeaseTransaction

const hasAll = (available: readonly string[], required: readonly string[]) =>
  required.every((capability) => available.includes(capability))

const requiredTransportCapabilities = (input: z.output<typeof inputSchema>): McpCapability[] => [
  ...new Set<McpCapability>(['agent-runs:execute', ...input.requiredTransportCapabilities]),
]

/**
 * Admits a current portable-worker claim inside the caller's existing interactive transaction.
 * The caller must acquire receipt/question advisory locks first and keep its bounded database
 * effect in this transaction. Passing the root client is unsupported because it would release
 * these row locks too early. This helper opens no transaction and does not authorize source data.
 */
export async function assertCurrentAgentWorkerClaim(
  tx: Tx,
  raw: CurrentAgentWorkerClaimInput,
): Promise<CurrentAgentWorkerClaim> {
  const input = inputSchema.parse(raw)
  const scope = input.credentialScope
  const transportCapabilities = requiredTransportCapabilities(input)
  if (
    input.clientId !== input.tenantId ||
    scope.tenantId !== input.tenantId ||
    scope.clientId !== input.clientId ||
    scope.credentialId.length === 0 ||
    scope.venueIds.length !== 1 ||
    scope.venueIds[0] !== input.venueId ||
    !hasAll(scope.capabilities, transportCapabilities)
  )
    throw new CurrentAgentWorkerClaimError()

  await assertEligibleWorkflowRunLease(tx, {
    tenantId: input.tenantId,
    venueId: input.venueId,
    agentRunId: input.agentRunId,
    executionLeaseToken: input.executionLeaseToken,
    ...(input.actionClass ? { actionClass: input.actionClass } : {}),
  })

  const runs = await tx.$queryRaw<
    Array<{
      id: string
      agentIdentityId: string
      requestedOperation: string
      executionWorkerId: string | null
      executionBridgeSessionId: string | null
      executionLeaseExpiresAt: Date | null
      cancelRequestedAt: Date | null
    }>
  >`SELECT id, agent_identity_id AS "agentIdentityId", requested_operation AS "requestedOperation",
      execution_worker_id AS "executionWorkerId",
      execution_bridge_session_id AS "executionBridgeSessionId",
      execution_lease_expires_at AS "executionLeaseExpiresAt",
      cancel_requested_at AS "cancelRequestedAt"
    FROM agent_runs
    WHERE id=${input.agentRunId} AND tenant_id=${input.tenantId} AND venue_id=${input.venueId}
      AND status='RUNNING' AND execution_lease_token=${input.executionLeaseToken}::uuid
    FOR UPDATE`
  const run = runs[0]
  if (
    runs.length !== 1 ||
    !run ||
    run.executionWorkerId !== input.workerId ||
    run.executionBridgeSessionId !== input.bridgeSessionId
  )
    throw new CurrentAgentWorkerClaimError()

  const identities = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM agent_identities
    WHERE id=${run.agentIdentityId} AND tenant_id=${input.tenantId}
      AND agent_type=${input.requiredAgentType} AND enabled=TRUE
      AND ((access_scope='CLIENT' AND venue_id IS NULL) OR
        (access_scope='VENUE' AND venue_id=${input.venueId}))
      AND ${input.requiredIdentityCapability}=ANY(access_capabilities)
      AND (${run.requestedOperation !== 'intake_source_review'} OR
        (agent_type='CONTENT' AND access_capabilities @> ARRAY['intake.read','content.draft']::text[]
          AND 'content.prepare-draft'=ANY(autonomous_actions) AND autonomy_level<>'READ_ONLY'))
    FOR SHARE`
  if (identities.length !== 1) throw new CurrentAgentWorkerClaimError()

  const workers = await tx.$queryRaw<
    Array<{
      id: string
      credentialId: string
      credentialScopeKey: string
      leaseExpiresAt: Date
      capabilities: string[]
      agentRoles: string[]
    }>
  >`SELECT id, credential_id AS "credentialId",
      credential_scope_key AS "credentialScopeKey", lease_expires_at AS "leaseExpiresAt",
      capabilities, agent_roles AS "agentRoles"
    FROM agent_workers
    WHERE id=${input.workerId} AND tenant_id=${input.tenantId} AND client_id=${input.clientId}
      AND credential_id=${scope.credentialId} AND status='ONLINE'
    FOR SHARE`
  const worker = workers[0]
  if (
    workers.length !== 1 ||
    !worker ||
    worker.credentialId !== scope.credentialId ||
    !worker.agentRoles.includes(input.requiredAgentType) ||
    !hasAll(worker.capabilities, transportCapabilities)
  )
    throw new CurrentAgentWorkerClaimError()

  const credentials = await tx.$queryRaw<
    Array<{ id: string; scopeKey: string; expiresAt: Date | null; capabilities: string[] }>
  >`SELECT id, scope_key AS "scopeKey", expires_at AS "expiresAt", capabilities
    FROM external_access_credentials
    WHERE id=${scope.credentialId} AND tenant_id=${input.tenantId} AND client_id=${input.clientId}
      AND venue_id=${input.venueId} AND kind='MCP' AND enabled=TRUE AND revoked_at IS NULL
    FOR SHARE`
  const credential = credentials[0]
  if (
    credentials.length !== 1 ||
    !credential ||
    credential.scopeKey !== input.venueId ||
    credential.scopeKey !== worker.credentialScopeKey ||
    !hasAll(credential.capabilities, transportCapabilities)
  )
    throw new CurrentAgentWorkerClaimError()

  const sessions = await tx.$queryRaw<
    Array<{ id: string; expiresAt: Date }>
  >`SELECT id, expires_at AS "expiresAt" FROM agent_bridge_sessions
    WHERE id=${input.bridgeSessionId} AND tenant_id=${input.tenantId}
      AND client_id=${input.clientId} AND venue_id=${input.venueId}
      AND credential_id=${scope.credentialId} AND scope_key=${credential.scopeKey}
      AND status='ONLINE'
    FOR SHARE`
  const session = sessions[0]
  if (sessions.length !== 1 || !session) throw new CurrentAgentWorkerClaimError()

  const clockRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  const now = clockRows[0]?.now
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    run.cancelRequestedAt !== null ||
    !(run.executionLeaseExpiresAt instanceof Date) ||
    !Number.isFinite(run.executionLeaseExpiresAt.getTime()) ||
    run.executionLeaseExpiresAt <= now ||
    !(worker.leaseExpiresAt instanceof Date) ||
    !Number.isFinite(worker.leaseExpiresAt.getTime()) ||
    worker.leaseExpiresAt <= now ||
    (credential.expiresAt !== null &&
      (!(credential.expiresAt instanceof Date) ||
        !Number.isFinite(credential.expiresAt.getTime()) ||
        credential.expiresAt <= now)) ||
    !(session.expiresAt instanceof Date) ||
    !Number.isFinite(session.expiresAt.getTime()) ||
    session.expiresAt <= now
  )
    throw new CurrentAgentWorkerClaimError('Current agent worker claim expired before admission.')

  return {
    agentIdentityId: run.agentIdentityId,
    workerId: worker.id,
    credentialId: credential.id,
    bridgeSessionId: session.id,
  }
}
