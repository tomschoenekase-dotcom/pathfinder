import { z } from 'zod'

import type { AgentWorkflowSupportedActionClass } from '@pathfinder/contracts'

import type { WorkflowRunLeaseTransaction } from './agent-workflow-run-lease'
import { assertEligibleWorkflowRunLease } from './agent-workflow-run-lease'

const schema = z
  .object({
    tenantId: z.string().min(1).max(191),
    clientId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    agentIdentityId: z.string().min(1).max(191),
    agentRunId: z.string().min(1).max(191),
    workerKey: z.string().min(1).max(191),
    credentialId: z.string().min(1).max(191),
    capability: z.string().min(1).max(191),
    executionLeaseToken: z.string().uuid(),
    actionClass: z.custom<AgentWorkflowSupportedActionClass>().optional(),
  })
  .strict()

export class IntakeV1PackageMachineAuthorityError extends Error {
  constructor(message = 'Current V1 package machine authority is unavailable.') {
    super(message)
    this.name = 'IntakeV1PackageMachineAuthorityError'
  }
}

type Tx = WorkflowRunLeaseTransaction & {
  agentRun: WorkflowRunLeaseTransaction['agentRun']
}

export async function assertIntakeV1PackageMachineAuthority(tx: Tx, raw: z.input<typeof schema>) {
  const input = schema.parse(raw)
  await assertEligibleWorkflowRunLease(tx, {
    tenantId: input.tenantId,
    venueId: input.venueId,
    agentRunId: input.agentRunId,
    executionLeaseToken: input.executionLeaseToken,
    ...(input.actionClass ? { actionClass: input.actionClass } : {}),
  })
  const run = await tx.agentRun.findFirst({
    where: {
      id: input.agentRunId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentIdentityId: input.agentIdentityId,
      status: 'RUNNING',
    },
    select: {
      id: true,
      executionWorkerId: true,
      executionLeaseExpiresAt: true,
      cancelRequestedAt: true,
    },
  })
  if (!run?.executionWorkerId) throw new IntakeV1PackageMachineAuthorityError()
  const identities = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM agent_identities WHERE id=${input.agentIdentityId} AND tenant_id=${input.tenantId}
      AND enabled=TRUE AND (access_scope IN ('CLIENT','PLATFORM') OR (access_scope='VENUE' AND venue_id=${input.venueId}))
      AND ${input.capability}=ANY(access_capabilities) FOR SHARE`
  const workers = await tx.$queryRaw<
    Array<{ id: string; leaseExpiresAt: Date; credentialScopeKey: string }>
  >`
    SELECT id, lease_expires_at AS "leaseExpiresAt", credential_scope_key AS "credentialScopeKey"
      FROM agent_workers WHERE id=${run.executionWorkerId} AND tenant_id=${input.tenantId}
      AND client_id=${input.clientId} AND credential_id=${input.credentialId} AND worker_key=${input.workerKey}
      AND status='ONLINE' AND ${input.capability}=ANY(capabilities) FOR SHARE`
  const credentials = await tx.$queryRaw<
    Array<{ id: string; expiresAt: Date | null; scopeKey: string }>
  >`
    SELECT id, expires_at AS "expiresAt", scope_key AS "scopeKey" FROM external_access_credentials
      WHERE id=${input.credentialId} AND tenant_id=${input.tenantId} AND client_id=${input.clientId}
      AND kind='MCP' AND enabled=TRUE AND revoked_at IS NULL AND (venue_id IS NULL OR venue_id=${input.venueId})
      AND ${input.capability}=ANY(capabilities) FOR SHARE`
  const worker = workers[0]
  const credential = credentials[0]
  if (
    identities.length !== 1 ||
    workers.length !== 1 ||
    credentials.length !== 1 ||
    !worker ||
    !credential ||
    worker.credentialScopeKey !== credential.scopeKey
  )
    throw new IntakeV1PackageMachineAuthorityError()
  const recheckTime = async () => {
    const checkedAt = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]
      ?.now
    if (
      !(checkedAt instanceof Date) ||
      !Number.isFinite(checkedAt.getTime()) ||
      run.cancelRequestedAt ||
      !run.executionLeaseExpiresAt ||
      run.executionLeaseExpiresAt <= checkedAt ||
      worker.leaseExpiresAt <= checkedAt ||
      (credential.expiresAt !== null && credential.expiresAt <= checkedAt)
    )
      throw new IntakeV1PackageMachineAuthorityError(
        'V1 package machine authority expired before the effect.',
      )
    return checkedAt
  }
  await recheckTime()
  return { recheckTime }
}
