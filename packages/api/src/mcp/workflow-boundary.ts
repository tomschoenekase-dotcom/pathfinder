import { assertEligibleWorkflowRunLease } from '@pathfinder/db'
import type { WorkflowRunLeaseTransaction } from '@pathfinder/db'
import { PATHFINDER_MCP_TOOLS } from '@pathfinder/contracts/mcp-v0'
import type { VerifiedMcpInvocationContext } from './registry'

const guardedTools = new Set([
  'pathfinder.create_update_draft',
  'pathfinder.create_support_draft',
  'pathfinder.add_support_internal_note',
  'pathfinder.delegate_specialist',
  'pathfinder.propose_intake_v1_package_draft',
  'pathfinder.apply_intake_v1_package_draft',
])

export class McpWorkflowBoundaryError extends Error {
  constructor(
    readonly code: 'WORKFLOW_LEASE_REQUIRED' | 'WORKFLOW_EFFECT_UNSUPPORTED',
    message: string,
  ) {
    super(message)
    this.name = 'McpWorkflowBoundaryError'
  }
}

/** Runs after each tool's input and credential scope validation. Unsupported
 * effects cannot use a bound run until their canonical effect transaction is fenced.
 * This is an attributed-run boundary, not a restriction on unrelated credential work. */
export async function assertMcpWorkflowToolSupported(
  client: Pick<WorkflowRunLeaseTransaction, 'agentWorkflowRunBinding'>,
  name: string,
  parsedInput: unknown,
  context: VerifiedMcpInvocationContext,
) {
  const definition = PATHFINDER_MCP_TOOLS.find((tool) => tool.name === name)
  if (
    !definition ||
    definition._meta['com.pathfinder/security'].effect === 'read' ||
    guardedTools.has(name)
  )
    return
  const input = parsedInput as { agentRunId?: string; parentAgentRunId?: string; venueId?: string }
  const agentRunId =
    name === 'pathfinder.delegate_specialist' ? input.parentAgentRunId : input.agentRunId
  if (!agentRunId) return
  const binding = await client.agentWorkflowRunBinding.findFirst({
    where: {
      tenantId: context.credential.tenantId,
      agentRunId,
      outcome: { in: ['SELECTED', 'CANARY_SKIPPED_PRIOR_VERSION'] },
      venueId: input.venueId ?? { in: context.credential.venueIds },
    },
    select: { id: true },
  })
  if (binding)
    throw new McpWorkflowBoundaryError(
      'WORKFLOW_EFFECT_UNSUPPORTED',
      'This effect does not support workflow-bound execution',
    )
}

/** Bindings are immutable and installed before a run can be queued. The caller's
 * token is mandatory for a bound run; never recover a current token for an old caller.
 * Invoke inside the transaction that consumes approval and performs the effect. */
export async function assertMcpWorkflowEffectLease(
  tx: WorkflowRunLeaseTransaction,
  input: {
    tenantId: string
    venueId: string
    agentRunId: string
    executionLeaseToken?: string | undefined
    availableCapabilities?: string[]
  },
) {
  const binding = await tx.agentWorkflowRunBinding.findFirst({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentRunId: input.agentRunId,
      outcome: { in: ['SELECTED', 'CANARY_SKIPPED_PRIOR_VERSION'] },
    },
    select: { id: true },
  })
  if (!binding) return
  if (!input.executionLeaseToken) {
    throw new McpWorkflowBoundaryError(
      'WORKFLOW_LEASE_REQUIRED',
      'Workflow-bound writes require the caller execution lease token',
    )
  }
  await assertEligibleWorkflowRunLease(tx, {
    ...input,
    executionLeaseToken: input.executionLeaseToken,
    actionClass: 'APPROVAL_BACKED_DOMAIN_EFFECT',
  })
}
