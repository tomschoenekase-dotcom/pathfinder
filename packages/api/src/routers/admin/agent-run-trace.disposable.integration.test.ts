import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '@pathfinder/db'

import type { TRPCContext } from '../../context'
import { adminAgentRunTraceRouter } from './agent-run-trace'

const enabled =
  process.env.RUN_AGENT_RUN_TRACE_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('agent run trace disposable integration', () => {
  afterAll(async () => db.$disconnect())

  it('returns one tenant-scoped, bounded chronology without raw execution material', async () => {
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `run-trace-${suffix}`
    const venueId = `run-trace-venue-${suffix}`
    const operatorId = `operator-${suffix}`
    const tenant = await db.tenant.create({
      data: { id: tenantId, name: 'Run trace proof', slug: tenantId },
    })
    const venue = await db.venue.create({
      data: { id: venueId, tenantId: tenant.id, name: 'Run trace venue', slug: venueId },
    })
    const identity = await db.agentIdentity.create({
      data: {
        tenantId: tenant.id,
        venueId: venue.id,
        identityKey: `trace-worker-${suffix}`,
        name: 'Trace proof worker',
        agentType: 'OPERATIONS',
        accessScope: 'VENUE',
        enabled: true,
        createdBy: operatorId,
      },
    })
    const run = await db.agentRun.create({
      data: {
        operationId: randomUUID(),
        tenantId: tenant.id,
        venueId: venue.id,
        agentIdentityId: identity.id,
        runType: 'SUPPORT',
        requestedOperation: 'prove-unified-run-trace',
        scopeSnapshot: { secretScopeDetail: 'must-not-leak' },
        executionLeaseToken: randomUUID(),
        status: 'COMPLETED',
        initiatedByType: 'HUMAN',
        initiatedById: operatorId,
        startedAt: new Date('2026-08-23T12:00:00.000Z'),
        completedAt: new Date('2026-08-23T12:04:00.000Z'),
      },
    })
    const action = await db.agentAction.create({
      data: {
        tenantId: tenant.id,
        venueId: venue.id,
        agentRunId: run.id,
        agentIdentityId: identity.id,
        actorType: 'AGENT',
        actorId: identity.id,
        requestedOperation: 'prove-unified-run-trace',
        actionName: 'support.prepare-correction',
        inputSummary: 'Prepared a bounded correction.',
        inputReference: 'private://must-not-leak',
        output: { private: 'must-not-leak' },
        status: 'SUCCEEDED',
        createdAt: new Date('2026-08-23T12:01:00.000Z'),
      },
    })
    await db.agentTimelineEvent.create({
      data: {
        tenantId: tenant.id,
        venueId: venue.id,
        agentRunId: run.id,
        agentActionId: action.id,
        actorType: 'SYSTEM',
        actorId: 'trace-proof',
        eventType: 'ACTION_RECORDED',
        message: 'The bounded action was recorded.',
        data: { privateEventData: 'must-not-leak' },
        createdAt: new Date('2026-08-23T12:02:00.000Z'),
      },
    })
    const approval = await db.approvalRequest.create({
      data: {
        tenantId: tenant.id,
        venueId: venue.id,
        agentIdentityId: identity.id,
        agentRunId: run.id,
        requestedByType: 'AGENT',
        requestedById: identity.id,
        proposedAction: 'support.publish-correction',
        scopeSnapshot: { privateApprovalScope: 'must-not-leak' },
        reason: 'External publication requires approval.',
        riskCategory: 'HIGH',
        createdAt: new Date('2026-08-23T12:03:00.000Z'),
      },
    })
    await db.approvalDecision.create({
      data: {
        tenantId: tenant.id,
        venueId: venue.id,
        approvalRequestId: approval.id,
        decision: 'APPROVED',
        decidedByType: 'HUMAN',
        decidedById: operatorId,
      },
    })
    await db.agentOutcomeObservation.create({
      data: {
        operationId: randomUUID(),
        tenantId: tenant.id,
        venueId: venue.id,
        agentRunId: run.id,
        agentIdentityId: identity.id,
        signalKind: 'HUMAN_REVIEW',
        verdict: 'POSITIVE',
        summary: 'The trace retained the evidence boundary.',
        evidenceRef: `agent-run:${run.id}`,
        taskClass: 'SUPPORT',
        actorType: 'HUMAN',
        actorId: operatorId,
        createdAt: new Date('2026-08-23T12:04:00.000Z'),
      },
    })

    const context: TRPCContext = {
      db,
      headers: new Headers(),
      session: { userId: operatorId, activeTenantId: null, role: null, isPlatformAdmin: true },
    }
    const caller = adminAgentRunTraceRouter.createCaller(context)
    const first = await caller.listAgentRunTrace({
      tenantId: tenant.id,
      venueId: venue.id,
      agentRunId: run.id,
      limit: 3,
    })

    expect(first.items.map((item) => item.kind)).toEqual(['OUTCOME', 'APPROVAL', 'EVENT'])
    expect(first.nextCursor).toMatchObject({ kind: 'EVENT' })
    expect(first.items.find((item) => item.kind === 'APPROVAL')).toMatchObject({
      state: 'APPROVED',
    })
    expect(JSON.stringify(first)).not.toContain('must-not-leak')
    expect(first.excludes).toContain('EXECUTION_LEASE')

    const second = await caller.listAgentRunTrace({
      tenantId: tenant.id,
      venueId: venue.id,
      agentRunId: run.id,
      cursor: first.nextCursor!,
      limit: 3,
    })
    expect(second.items.map((item) => `${item.kind}:${item.id}`)).toEqual([`ACTION:${action.id}`])

    await expect(
      caller.listAgentRunTrace({
        tenantId: tenant.id,
        venueId: `wrong-${venue.id}`,
        agentRunId: run.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
