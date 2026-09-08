import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

const Input = z
  .object({
    bridgeEndpoint: z.string().url(),
    mcpEndpoint: z.string().url(),
    secret: z.string(),
    venueId: z.string(),
    phase: z.enum(['RESEARCH', 'BUILDER', 'NOTIFICATION']),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [key, endpoint] of [
      ['bridgeEndpoint', value.bridgeEndpoint],
      ['mcpEndpoint', value.mcpEndpoint],
    ] as const) {
      const url = new URL(endpoint)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
        context.addIssue({ code: 'custom', path: [key], message: 'Loopback endpoint required' })
    }
  })

async function input() {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 16_384) throw new Error('FIXTURE_INPUT_TOO_LARGE')
    chunks.push(buffer)
  }
  return Input.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
}

async function main() {
  const state = await input()
  if (process.env.DATABASE_URL) throw new Error('DATABASE_ENVIRONMENT_MUST_NOT_REACH_CHILD')
  const sessionId = randomUUID()
  const workerKey = `${state.phase.toLowerCase()}-${state.venueId}`
  const bridge = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(state.bridgeEndpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
    const body = (await response.json()) as {
      ok?: boolean
      result?: unknown
      error?: { code?: string }
    }
    if (!response.ok || !body.ok)
      throw new Error(`BRIDGE_${method}_${body.error?.code ?? response.status}`)
    return body.result
  }
  let requestId = 0
  const tool = async (
    name: string,
    arguments_: Record<string, unknown>,
    approvalGrantId?: string,
  ) => {
    const response = await fetch(state.mcpEndpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `${state.phase}-${++requestId}`,
        method: 'tools/call',
        params: {
          name,
          arguments: arguments_,
          ...(approvalGrantId ? { _meta: { approvalGrantId } } : {}),
        },
      }),
    })
    const body = (await response.json()) as {
      result?: { structuredContent?: { data?: Record<string, unknown> } }
      error?: { code?: number; data?: unknown }
    }
    if (!response.ok || body.error || !body.result?.structuredContent?.data)
      throw new Error(`MCP_${name}_${body.error?.code ?? response.status}`)
    return body.result.structuredContent.data
  }

  await bridge('register', {
    sessionId,
    venueId: state.venueId,
    provider: 'CODEX_SUBSCRIPTION',
    label: `Deterministic ${state.phase.toLowerCase()} adapter`,
    runnerVersion: 'deterministic-specialist-chain/1',
    supportedModels: ['subscription-default'],
  })
  const claim = (await bridge('claimTask', { sessionId, venueId: state.venueId, workerKey })) as {
    task?: { id: string; prompt: string; leaseToken: string }
  }
  if (!claim.task) throw new Error('NO_CLAIMED_TASK')
  const identityId = claim.task.prompt.match(/identity:([^\s]+)/u)?.[1]
  if (!identityId) throw new Error('PERSISTED_IDENTITY_REFERENCE_MISSING')
  let artifact: Record<string, unknown>
  let sourceHash: string | null = null
  let proposalApprovalRequestId: string | null = null

  if (state.phase === 'RESEARCH') {
    artifact = {
      type: 'research-result',
      finding: 'step-free east entrance',
      sourceRef: 'SyntheticFixtureInput:accessible-east',
    }
  } else {
    const sourceRunId = claim.task.prompt.match(/agent-run:([^\s]+)/u)?.[1]
    const expectedParentRunId = claim.task.prompt.match(/parent-run:([^\s]+)/u)?.[1]
    if (!sourceRunId || !expectedParentRunId) throw new Error('PERSISTED_RESULT_REFERENCE_MISSING')
    if (state.phase === 'BUILDER') {
      const result = await tool('pathfinder.read', {
        resource: 'agent-run-result',
        clientId: state.venueId.replace(/^venue-/u, 'tenant-'),
        venueId: state.venueId,
        agentRunId: sourceRunId,
        artifactIndex: 0,
        limit: 25,
      })
      const selected = result.selectedArtifact as { serialized: string; sha256: string }
      const sourceRun = result.run as { parentAgentRunId?: string }
      if (sourceRun.parentAgentRunId !== expectedParentRunId)
        throw new Error('PERSISTED_RESULT_PARENT_MISMATCH')
      const source = JSON.parse(selected.serialized) as Record<string, unknown>
      sourceHash = createHash('sha256').update(selected.serialized).digest('hex')
      if (sourceHash !== selected.sha256) throw new Error('PERSISTED_RESULT_HASH_MISMATCH')
      const proposal = await tool('torchiko.locations.propose_draft', {
        clientId: state.venueId.replace(/^venue-/u, 'tenant-'),
        venueId: state.venueId,
        operationId: randomUUID(),
        agentIdentityId: identityId,
        agentRunId: claim.task.id,
        workerKey,
        reason: 'Deterministic retained research supports a review-only entrance proposal.',
        evidence: [{ type: 'AgentRun', id: sourceRunId }],
        draft: {
          stableKey: `east-entrance-${claim.task.id.replaceAll('-', '').slice(0, 12)}`,
          kind: 'ENTRANCE',
          displayName: 'Accessible east entrance',
          description: `Deterministic draft from ${String(source.finding)}.`,
          visibility: 'PUBLIC',
          mapAnchor: { x: 12, y: 24 },
          accessibilityMetadata: { stepFree: true },
        },
      })
      const approvalRequestId = proposal.approvalRequestId
      if (typeof approvalRequestId !== 'string')
        throw new Error('PROPOSAL_APPROVAL_REFERENCE_MISSING')
      process.stdout.write(
        JSON.stringify({
          phase: state.phase,
          processId: process.pid,
          runId: claim.task.id,
          sourceHash,
          awaitingApproval: true,
          approvalRequestId,
        }),
      )
      return
    } else {
      const result = await tool('pathfinder.read', {
        resource: 'agent-run-result',
        clientId: state.venueId.replace(/^venue-/u, 'tenant-'),
        venueId: state.venueId,
        agentRunId: sourceRunId,
        limit: 25,
      })
      const sourceRun = result.run as {
        parentAgentRunId?: string
        status?: string
        terminal?: boolean
        pending?: boolean
      }
      const artifacts = result.artifacts as { count?: number }
      if (sourceRun.parentAgentRunId !== expectedParentRunId)
        throw new Error('PERSISTED_RESULT_PARENT_MISMATCH')
      if (
        sourceRun.status !== 'AWAITING_APPROVAL' ||
        sourceRun.terminal !== false ||
        sourceRun.pending !== true ||
        artifacts.count !== 0
      )
        throw new Error('PERSISTED_BUILDER_STATE_MISMATCH')
      const trace = await tool('pathfinder.read', {
        resource: 'agent-run-trace',
        clientId: state.venueId.replace(/^venue-/u, 'tenant-'),
        venueId: state.venueId,
        agentRunId: sourceRunId,
        limit: 25,
      })
      const approvals = (trace.items as Array<Record<string, unknown>>).filter(
        (item) =>
          item.kind === 'APPROVAL' &&
          item.proposedAction === 'torchiko.locations.create_draft' &&
          item.state === 'PENDING' &&
          item.decision == null,
      )
      if (approvals.length !== 1 || typeof approvals[0]!.id !== 'string')
        throw new Error('PERSISTED_PROPOSAL_REFERENCE_MISSING')
      const approvalGrantId = claim.task.prompt.match(/approval-grant:([^\s]+)/u)?.[1]
      const operationId = claim.task.prompt.match(/update-operation:([^\s]+)/u)?.[1]
      const startsAt = claim.task.prompt.match(/starts-at:([^\s]+)/u)?.[1]
      const expiresAt = claim.task.prompt.match(/expires-at:([^\s]+)/u)?.[1]
      if (!approvalGrantId || !operationId || !startsAt || !expiresAt)
        throw new Error('PERSISTED_APPROVAL_CONTEXT_MISSING')
      const retainedProposalId = approvals[0]!.id
      proposalApprovalRequestId = retainedProposalId
      const update = await tool(
        'pathfinder.create_update_draft',
        {
          clientId: state.venueId.replace(/^venue-/u, 'tenant-'),
          venueId: state.venueId,
          operationId,
          agentIdentityId: identityId,
          agentRunId: claim.task.id,
          workerKey,
          executionLeaseToken: claim.task.leaseToken,
          title: 'Accessible entrance information under review',
          body: `A deterministic visitor draft references retained proposal ${retainedProposalId}.`,
          startsAt,
          expiresAt,
        },
        approvalGrantId,
      )
      artifact = { type: 'visitor-notification-draft', sourceRunId, retainedProposalId, update }
      sourceHash = null
    }
  }
  await bridge('completeTask', {
    sessionId,
    venueId: state.venueId,
    runId: claim.task.id,
    leaseToken: claim.task.leaseToken,
    summary: `Deterministic ${state.phase.toLowerCase()} adapter completed retained work.`,
    artifacts: [artifact],
    modelName: 'subscription-default',
    costE8Usd: '0',
    costStatus: 'UNREPORTED',
  })
  let staleCompletionRejected = false
  if (state.phase === 'RESEARCH') {
    try {
      await bridge('completeTask', {
        sessionId,
        venueId: state.venueId,
        runId: claim.task.id,
        leaseToken: claim.task.leaseToken,
        summary: 'Duplicate settlement must be rejected.',
        artifacts: [],
        modelName: 'subscription-default',
        costE8Usd: '0',
        costStatus: 'UNREPORTED',
      })
    } catch (error) {
      staleCompletionRejected =
        error instanceof Error &&
        /^BRIDGE_completeTask_(?:BRIDGE_OPERATION_REJECTED|409)$/u.test(error.message)
    }
  }
  process.stdout.write(
    JSON.stringify({
      phase: state.phase,
      processId: process.pid,
      runId: claim.task.id,
      sourceHash,
      sourceReadResource: state.phase === 'NOTIFICATION' ? 'agent-run-trace' : undefined,
      proposalApprovalRequestId,
      staleCompletionRejected,
    }),
  )
}

void main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : 'SPECIALIST_CHAIN_CHILD_FAILED')
  process.exitCode = 1
})
