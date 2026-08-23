import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { applyFounderDecisionPacketAction, db } from '@pathfinder/db'

import type { TRPCContext } from '../context'
import { router } from '../core'
import { adminPlatformWorkerPolicyCredentialsRouter } from '../routers/admin/platform-worker-policy-credentials'
import { handlePlatformWorkerFounderDecisionRequest } from './http'
import { handlePlatformWorkerFounderOperatingViewRequest } from './operating-view-http'
import { handlePlatformWorkerOperationsReadinessRequest } from './operations-readiness-http'

const enabled =
  process.env.RUN_PLATFORM_WORKER_POLICY_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('platform worker policy disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('issues dark, activates, reads exact founder truth, audits, and revokes', async () => {
    const founderId = `founder-${randomUUID().slice(0, 8)}`
    const decisionKey = `ordinary-engineering-authority-${randomUUID().slice(0, 8)}`
    await applyFounderDecisionPacketAction({
      actor: { type: 'HUMAN', actorId: founderId, role: 'PLATFORM_ADMIN' },
      packet: {
        schemaVersion: 'founder-decision-packet.v1',
        packetId: `platform-policy-proof-${randomUUID()}`,
        title: 'Platform policy proof',
        effectiveAt: '2026-08-23T10:30:00.000Z',
        sourceRef: 'disposable://platform-policy-proof',
        decisions: [
          {
            key: decisionKey,
            title: 'Ordinary engineering authority',
            summary: 'Codex may make reversible internal engineering choices.',
            decision: 'Make the best reasonable technical decision, test it, and keep moving.',
            rationale: 'Ordinary implementation choices do not require founder judgment.',
            affectedSystems: ['engineering'],
            scope: { productionAuthorized: false },
          },
        ],
      },
    })
    const context: TRPCContext = {
      db,
      headers: new Headers(),
      session: { userId: founderId, activeTenantId: null, role: null, isPlatformAdmin: true },
    }
    const caller = router({ credentials: adminPlatformWorkerPolicyCredentialsRouter }).createCaller(
      context,
    )
    const issued = await caller.credentials.issuePlatformWorkerPolicyCredential({
      operationId: randomUUID(),
      workerId: 'edith-primary',
      label: 'Disposable EDITH policy reader',
      capabilities: [
        'founder-decisions:read',
        'founder-operating-view:read',
        'operations-readiness:read',
      ],
      expiresAt: null,
    })
    expect(issued.credential.enabled).toBe(false)
    expect(issued.plaintextSecret).toMatch(/^pf_platform_[A-Za-z0-9_-]{43}$/u)
    await expect(
      handlePlatformWorkerFounderDecisionRequest(
        new Request('http://localhost/api/platform-worker/founder-decisions', {
          method: 'POST',
          headers: { authorization: `Bearer ${issued.plaintextSecret}` },
          body: JSON.stringify({ keys: [decisionKey] }),
        }),
      ),
    ).resolves.toMatchObject({ status: 401 })

    const activated = await caller.credentials.activatePlatformWorkerPolicyCredential({
      operationId: randomUUID(),
      credentialId: issued.credential.id,
      expectedUpdatedAt: issued.credential.updatedAt.toISOString(),
    })
    expect(activated.credential.enabled).toBe(true)
    const policyResponse = await handlePlatformWorkerFounderDecisionRequest(
      new Request('http://localhost/api/platform-worker/founder-decisions', {
        method: 'POST',
        headers: { authorization: `Bearer ${issued.plaintextSecret}` },
        body: JSON.stringify({ keys: [decisionKey] }),
      }),
    )
    expect(policyResponse.status).toBe(200)
    await expect(policyResponse.json()).resolves.toMatchObject({
      complete: true,
      decisions: [
        {
          key: decisionKey,
          decision: 'Make the best reasonable technical decision, test it, and keep moving.',
        },
      ],
      missingKeys: [],
    })
    const current = await db.platformWorkerPolicyCredential.findUniqueOrThrow({
      where: { id: issued.credential.id },
    })
    expect(current.lastUsedAt).not.toBeNull()

    const suffix = randomUUID().slice(0, 8)
    const tenantId = `worker-evidence-${suffix}`
    const venueId = `worker-evidence-venue-${suffix}`
    const tenant = await db.tenant.create({
      data: { id: tenantId, name: 'Worker evidence proof', slug: tenantId },
    })
    const venue = await db.venue.create({
      data: {
        id: venueId,
        tenantId: tenant.id,
        name: 'Worker evidence venue',
        slug: venueId,
      },
    })
    const identity = await db.agentIdentity.create({
      data: {
        tenantId: tenant.id,
        venueId: venue.id,
        identityKey: `support-worker-${suffix}`,
        name: `Support worker ${suffix}`,
        agentType: 'OPERATIONS',
        accessScope: 'VENUE',
        enabled: true,
        createdBy: founderId,
      },
    })
    const run = await db.agentRun.create({
      data: {
        operationId: randomUUID(),
        tenantId: tenant.id,
        venueId: venue.id,
        agentIdentityId: identity.id,
        runType: 'SUPPORT',
        requestedOperation: 'resolve-visitor-content-gap',
        scopeSnapshot: { tenantId: tenant.id, venueId: venue.id },
        status: 'COMPLETED',
        initiatedByType: 'AGENT',
        initiatedById: identity.id,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    })
    const approvalRequest = await db.approvalRequest.create({
      data: {
        tenantId: tenant.id,
        venueId: venue.id,
        agentIdentityId: identity.id,
        agentRunId: run.id,
        requestedByType: 'AGENT',
        requestedById: identity.id,
        proposedAction: 'support.publish-correction',
        scopeSnapshot: { tenantId: tenant.id, venueId: venue.id },
        reason: 'Publish a bounded visitor-content correction.',
        riskCategory: 'LOW',
      },
    })
    const approvalDecision = await db.approvalDecision.create({
      data: {
        tenantId: tenant.id,
        venueId: venue.id,
        approvalRequestId: approvalRequest.id,
        decision: 'APPROVED',
        decidedByType: 'HUMAN',
        decidedById: founderId,
      },
    })
    await db.agentAction.createMany({
      data: [
        {
          tenantId: tenant.id,
          venueId: venue.id,
          agentRunId: run.id,
          agentIdentityId: identity.id,
          approvalDecisionId: approvalDecision.id,
          actorType: 'AGENT',
          actorId: identity.id,
          requestedOperation: 'resolve-visitor-content-gap',
          actionName: 'support.publish-correction',
          status: 'SUCCEEDED',
        },
        {
          tenantId: tenant.id,
          venueId: venue.id,
          agentRunId: run.id,
          agentIdentityId: identity.id,
          actorType: 'AGENT',
          actorId: identity.id,
          requestedOperation: 'resolve-visitor-content-gap',
          actionName: 'support.refresh-source',
          status: 'FAILED',
          errorCode: 'FIXTURE_PROVIDER_ERROR',
        },
      ],
    })
    await db.agentOutcomeObservation.createMany({
      data: [
        {
          operationId: randomUUID(),
          tenantId: tenant.id,
          venueId: venue.id,
          agentRunId: run.id,
          agentIdentityId: identity.id,
          signalKind: 'QUALITY_EVALUATION',
          verdict: 'NEGATIVE',
          summary: 'The first retrieval attempt used a stale source.',
          taskClass: 'SUPPORT',
          actorType: 'SYSTEM',
          actorId: 'disposable-evidence-proof',
        },
        {
          operationId: randomUUID(),
          tenantId: tenant.id,
          venueId: venue.id,
          agentRunId: run.id,
          agentIdentityId: identity.id,
          signalKind: 'CUSTOMER_SIGNAL',
          verdict: 'MIXED',
          summary: 'The correction helped, but required follow-up.',
          taskClass: 'SUPPORT',
          actorType: 'SYSTEM',
          actorId: 'disposable-evidence-proof',
        },
      ],
    })

    const operatingResponse = await handlePlatformWorkerFounderOperatingViewRequest(
      new Request('http://localhost/api/platform-worker/founder-operating-view', {
        method: 'POST',
        headers: { authorization: `Bearer ${issued.plaintextSecret}` },
        body: JSON.stringify({ limit: 10 }),
      }),
    )
    expect(operatingResponse.status).toBe(200)
    await expect(operatingResponse.json()).resolves.toMatchObject({
      schemaVersion: 1,
      scope: 'PLATFORM',
      effect: 'READ_ONLY',
      authority: {
        transport: 'PLATFORM_WORKER_CREDENTIAL',
        customerCredentialCompatible: false,
        canExecute: false,
        canApprove: false,
        canAcknowledge: false,
        canMutatePolicy: false,
      },
      autonomyEvidence: {
        schemaVersion: 2,
        state: 'NEGATIVE_EVIDENCE_PRESENT',
        evidenceCoverage: {
          deniedActions: 'AVAILABLE_NOT_POLICY_VIOLATION',
          rollbackRate: 'UNAVAILABLE_NO_CANONICAL_LINK',
          policyViolations: 'UNAVAILABLE_NO_CANONICAL_SIGNAL',
          confidenceCalibration: 'UNAVAILABLE_NO_PREDICTION_OUTCOME_PAIR',
        },
        byAgent: expect.arrayContaining([
          expect.objectContaining({
            agentIdentityId: identity.id,
            actions: expect.objectContaining({ succeeded: 1, failed: 1 }),
            approvals: expect.objectContaining({ decided: 1, approved: 1 }),
            taskClasses: ['SUPPORT'],
          }),
        ]),
        policy: { approvalReductionRecommended: false },
      },
    })

    const readinessResponse = await handlePlatformWorkerOperationsReadinessRequest(
      new Request('http://localhost/api/platform-worker/operations-readiness', {
        method: 'POST',
        headers: { authorization: `Bearer ${issued.plaintextSecret}` },
        body: JSON.stringify({}),
      }),
      {
        resolve: async () =>
          ({
            schemaVersion: 'pathfinder.operations-readiness.v2',
            status: 'degraded',
            queue: {
              live: {
                status: 'unavailable',
                source: 'bullmq-redis',
                reason: 'probe-failed',
              },
            },
            boundaries: {
              retryAuthorized: false,
              cancellationAuthorized: false,
              redriveAuthorized: false,
              incidentControlAuthorized: false,
            },
          }) as never,
      },
    )
    expect(readinessResponse.status).toBe(200)
    await expect(readinessResponse.json()).resolves.toMatchObject({
      schemaVersion: 'pathfinder.operations-readiness.v2',
      status: 'degraded',
      queue: { live: { status: 'unavailable', reason: 'probe-failed' } },
      boundaries: { retryAuthorized: false, redriveAuthorized: false },
    })

    const refreshed = await db.platformWorkerPolicyCredential.findUniqueOrThrow({
      where: { id: issued.credential.id },
    })
    const revoked = await caller.credentials.revokePlatformWorkerPolicyCredential({
      operationId: randomUUID(),
      credentialId: refreshed.id,
      expectedUpdatedAt: refreshed.updatedAt.toISOString(),
      reason: 'PROOF_COMPLETE',
    })
    expect(revoked.credential).toMatchObject({ enabled: false, revokedAt: expect.any(Date) })
    const denied = await handlePlatformWorkerFounderDecisionRequest(
      new Request('http://localhost/api/platform-worker/founder-decisions', {
        method: 'POST',
        headers: { authorization: `Bearer ${issued.plaintextSecret}` },
        body: JSON.stringify({ keys: [decisionKey] }),
      }),
    )
    expect(denied.status).toBe(401)
    expect(
      await db.auditLog.count({
        where: {
          OR: [{ actorId: founderId }, { credentialId: issued.credential.id }],
          targetType: {
            in: [
              'PlatformWorkerPolicyCredential',
              'FounderDecisionKeySet',
              'FounderOperatingView',
              'OperationsReadiness',
            ],
          },
        },
      }),
    ).toBe(6)
  })
})
