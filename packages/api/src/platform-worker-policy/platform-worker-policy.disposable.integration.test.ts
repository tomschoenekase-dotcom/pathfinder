import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { applyFounderDecisionPacketAction, db } from '@pathfinder/db'

import type { TRPCContext } from '../context'
import { router } from '../core'
import { adminPlatformWorkerPolicyCredentialsRouter } from '../routers/admin/platform-worker-policy-credentials'
import { handlePlatformWorkerFounderDecisionRequest } from './http'
import { handlePlatformWorkerFounderOperatingViewRequest } from './operating-view-http'

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
      capabilities: ['founder-decisions:read', 'founder-operating-view:read'],
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
        policy: { approvalReductionRecommended: false },
      },
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
            in: ['PlatformWorkerPolicyCredential', 'FounderDecisionKeySet', 'FounderOperatingView'],
          },
        },
      }),
    ).toBe(5)
  })
})
