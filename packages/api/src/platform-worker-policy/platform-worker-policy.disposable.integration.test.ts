import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { applyFounderDecisionPacketAction, db } from '@pathfinder/db'

import type { TRPCContext } from '../context'
import { router } from '../core'
import { adminPlatformWorkerPolicyCredentialsRouter } from '../routers/admin/platform-worker-policy-credentials'
import { handlePlatformWorkerFounderDecisionRequest } from './http'

const enabled =
  process.env.RUN_PLATFORM_WORKER_POLICY_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('platform worker policy disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('issues dark, activates, reads exact founder truth, audits, and revokes', async () => {
    const founderId = `founder-${randomUUID().slice(0, 8)}`
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
            key: 'ordinary-engineering-authority',
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
      capabilities: ['founder-decisions:read'],
      expiresAt: null,
    })
    expect(issued.credential.enabled).toBe(false)
    expect(issued.plaintextSecret).toMatch(/^pf_platform_[A-Za-z0-9_-]{43}$/u)
    await expect(
      handlePlatformWorkerFounderDecisionRequest(
        new Request('http://localhost/api/platform-worker/founder-decisions', {
          method: 'POST',
          headers: { authorization: `Bearer ${issued.plaintextSecret}` },
          body: JSON.stringify({ keys: ['ordinary-engineering-authority'] }),
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
        body: JSON.stringify({ keys: ['ordinary-engineering-authority'] }),
      }),
    )
    expect(policyResponse.status).toBe(200)
    await expect(policyResponse.json()).resolves.toMatchObject({
      complete: true,
      decisions: [
        {
          key: 'ordinary-engineering-authority',
          decision: 'Make the best reasonable technical decision, test it, and keep moving.',
        },
      ],
      missingKeys: [],
    })
    const current = await db.platformWorkerPolicyCredential.findUniqueOrThrow({
      where: { id: issued.credential.id },
    })
    expect(current.lastUsedAt).not.toBeNull()

    const revoked = await caller.credentials.revokePlatformWorkerPolicyCredential({
      operationId: randomUUID(),
      credentialId: current.id,
      expectedUpdatedAt: current.updatedAt.toISOString(),
      reason: 'PROOF_COMPLETE',
    })
    expect(revoked.credential).toMatchObject({ enabled: false, revokedAt: expect.any(Date) })
    const denied = await handlePlatformWorkerFounderDecisionRequest(
      new Request('http://localhost/api/platform-worker/founder-decisions', {
        method: 'POST',
        headers: { authorization: `Bearer ${issued.plaintextSecret}` },
        body: JSON.stringify({ keys: ['ordinary-engineering-authority'] }),
      }),
    )
    expect(denied.status).toBe(401)
    expect(
      await db.auditLog.count({
        where: {
          targetType: { in: ['PlatformWorkerPolicyCredential', 'FounderDecisionKeySet'] },
        },
      }),
    ).toBe(4)
  })
})
