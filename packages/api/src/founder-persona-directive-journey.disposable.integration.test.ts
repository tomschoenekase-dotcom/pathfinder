import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  activatePlatformWorkerPolicyCredentialAction,
  claimAgentRunExecution,
  completeAgentRunExecution,
  db,
  issuePlatformWorkerPolicyCredentialAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import type { TRPCContext } from './context'
import { handlePlatformWorkerFounderDirectiveTasksRequest } from './platform-worker-policy/founder-directive-tasks-http'
import { handlePlatformWorkerFounderOperatingViewRequest } from './platform-worker-policy/operating-view-http'
import { appRouter } from './root'

const enabled =
  process.env.RUN_FOUNDER_PERSONA_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_founder_persona_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

function context(userId: string, isPlatformAdmin = true): TRPCContext {
  return {
    db,
    headers: new Headers({ 'x-forwarded-for': '203.0.113.81' }),
    session: { userId, activeTenantId: null, role: null, isPlatformAdmin },
  }
}

function workerRequest(secret: string, body: Record<string, unknown>) {
  return new Request('http://localhost/api/platform-worker/founder-directive-tasks', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function workerCall(secret: string, body: Record<string, unknown>) {
  const response = await handlePlatformWorkerFounderDirectiveTasksRequest(
    workerRequest(secret, body),
    { allowAttempt: () => true, enqueue: async () => ({ enqueued: false }) },
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function operatingView(secret: string) {
  const response = await handlePlatformWorkerFounderOperatingViewRequest(
    new Request('http://localhost/api/platform-worker/founder-operating-view', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 20 }),
    }),
    { allowAttempt: () => true },
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe.skipIf(!enabled)('connected founder persona directive journey', () => {
  afterAll(async () => db.$disconnect())

  it('directs, approves, executes, and reads back one scoped artifact without SQL advancement', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const founderId = `founder-${suffix}`
    const workerId = `worker-${suffix}`
    const tenantId = `tenant-${suffix}`
    const venueId = `venue-${suffix}`
    const identityId = `identity-${suffix}`
    const seeded = await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: tenantId, name: 'Founder persona tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Founder persona venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `founder-persona.${suffix}`,
          name: 'Founder persona analyst',
          agentType: 'OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['operations.read'],
          autonomyLevel: 'READ_ONLY',
          autonomousActions: [],
          enabled: true,
          createdBy: founderId,
        },
      })
      const issued = await issuePlatformWorkerPolicyCredentialAction({
        operationId: randomUUID(),
        workerId,
        label: 'Founder persona platform worker',
        capabilities: [
          'founder-operating-view:read',
          'founder-directive-tasks:read',
          'founder-directive-tasks:propose',
          'founder-directive-tasks:materialize',
        ],
        expiresAt: null,
        actor: { type: 'HUMAN', id: founderId, role: 'PLATFORM_ADMIN' },
      })
      await activatePlatformWorkerPolicyCredentialAction({
        operationId: randomUUID(),
        credentialId: issued.credential.id,
        expectedUpdatedAt: issued.credential.updatedAt,
        actor: { type: 'HUMAN', id: founderId, role: 'PLATFORM_ADMIN' },
      })
      return { secret: issued.plaintextSecret! }
    })

    const admin = appRouter.createCaller(context(founderId)).admin
    const operationId = randomUUID()
    const prompt =
      'Review this venue’s bounded reliability evidence and return an internal findings artifact.'
    const conversation = await admin.askFounderOperatingSystem({ operationId, prompt })
    expect(conversation).toMatchObject({
      replayed: false,
      exchange: { disposition: 'RECORDED_FOR_TRIAGE' },
    })
    await expect(admin.askFounderOperatingSystem({ operationId, prompt })).resolves.toMatchObject({
      replayed: true,
      exchange: { id: conversation.exchange.id },
    })

    const read = await operatingView(seeded.secret)
    expect(read.status).toBe(200)
    const recentConversation = read.body.recentConversation as Array<{
      id: string
      disposition: string
      snapshotHash: string
    }>
    expect(recentConversation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: conversation.exchange.id,
          disposition: 'RECORDED_FOR_TRIAGE',
          snapshotHash: conversation.exchange.snapshotHash,
        }),
      ]),
    )
    const workerExchange = recentConversation.find((item) => item.id === conversation.exchange.id)
    if (!workerExchange) throw new Error('Worker operating view omitted the retained directive')

    const proposalOperationId = randomUUID()
    const proposalPayload = {
      action: 'propose',
      operationId: proposalOperationId,
      founderOperatingExchangeId: workerExchange.id,
      expectedSnapshotHash: workerExchange.snapshotHash,
      tenantId,
      venueId,
      agentIdentityId: identityId,
      proposedPrompt:
        'Read bounded venue reliability evidence and return an internal findings artifact. Do not mutate venue state or contact anyone.',
      rationale: 'Exact safe interpretation of the retained founder direction.',
      riskCategory: 'LOW',
      constraints: ['Read only.', 'No external communication or venue mutation.'],
    }
    const wrongScope = await workerCall(seeded.secret, {
      ...proposalPayload,
      operationId: randomUUID(),
      venueId: `wrong-${venueId}`,
    })
    expect(wrongScope.status).toBe(404)
    const proposed = await workerCall(seeded.secret, proposalPayload)
    expect(proposed.status).toBe(201)
    const request = proposed.body.request as { id: string; approvalRequestId: string }
    await expect(workerCall(seeded.secret, proposalPayload)).resolves.toMatchObject({
      status: 200,
      body: { replayed: true },
    })

    const approval = await admin.recordApprovalDecision({
      tenantId,
      venueId,
      approvalRequestId: request.approvalRequestId,
      decision: 'APPROVED',
      reason: 'Approve this exact read-only internal analysis task.',
    })
    expect(approval.executionTriggered).toBe(false)

    const materializePayload = {
      action: 'materialize',
      operationId: randomUUID(),
      requestId: request.id,
      expectedApprovalDecisionId: approval.decision.id,
    }
    const materialized = await workerCall(seeded.secret, materializePayload)
    expect(materialized.status).toBe(201)
    const run = materialized.body.run as { id: string; status: string }
    expect(run.status).toBe('QUEUED')
    await expect(workerCall(seeded.secret, materializePayload)).resolves.toMatchObject({
      status: 200,
      body: { replayed: true, run: { id: run.id } },
    })

    // Direct fixture execution uses the canonical lease without claiming a registered
    // external worker identity or a live model execution.
    const claimed = await claimAgentRunExecution({
      tenantId,
      runId: run.id,
      leaseDurationMs: 60_000,
    })
    const artifact = {
      kind: 'INTERNAL_FINDINGS',
      title: 'Bounded reliability findings',
      findings: ['No customer-facing or venue mutation was performed.'],
    }
    await completeAgentRunExecution({
      tenantId,
      runId: run.id,
      leaseToken: claimed.leaseToken,
      summary: 'Internal reliability findings are ready for founder review.',
      artifacts: [artifact],
      modelProvider: 'fixture',
      modelName: 'deterministic-safe-worker',
    })

    const retainedRun = await admin.getAgentRun({ tenantId, venueId, agentRunId: run.id })
    expect(retainedRun).toMatchObject({ status: 'COMPLETED', artifacts: [artifact] })
    const trace = await admin.listAgentRunTrace({
      tenantId,
      venueId,
      agentRunId: run.id,
      limit: 50,
    })
    expect(trace.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'EVENT', eventType: 'EXECUTION_COMPLETED' }),
      ]),
    )
    const refreshed = await admin.attentionConsole({ limit: 25 })
    const exchange = refreshed.founderConversation.find(
      (item) => item.id === conversation.exchange.id,
    )
    expect(exchange).toMatchObject({
      directiveTaskRequest: {
        id: request.id,
        status: 'MATERIALIZED',
        agentRun: { id: run.id, status: 'COMPLETED' },
      },
    })
  })
})
