import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import {
  activateAgentBridgeCredentialAction,
  claimAgentBridgeTask,
  completeAgentBridgeTask,
  db,
  heartbeatAgentBridgeTask,
  issueExternalCredentialAction,
  registerAgentBridgeSession,
  verifyAgentBridgeCredential,
  withTenantIsolationBypass,
} from '../index'

const enabled =
  process.env.RUN_AGENT_BRIDGE_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('agent bridge disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('proves credential activation through claimed execution and durable artifact readback', async () => {
    await withTenantIsolationBypass(async () => {
      const tenantId = 'tenant-agent-bridge-smoke'
      const venueId = 'venue-agent-bridge-smoke'
      const identityId = 'identity-agent-bridge-smoke'
      const actor = {
        type: 'HUMAN' as const,
        id: 'integration-operator',
        role: 'PLATFORM_ADMIN' as const,
      }
      await db.tenant.create({
        data: { id: tenantId, name: 'Disposable bridge tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Disposable bridge venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: 'bridge.smoke',
          name: 'Bridge Smoke Specialist',
          agentType: 'OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['operations.read'],
          autonomyLevel: 'READ_ONLY',
          defaultProvider: 'codex-bridge',
          defaultModel: 'subscription-default',
          enabled: true,
          createdBy: actor.id,
        },
      })
      const issued = await issueExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        actor,
        kind: 'MCP',
        label: 'Disposable bridge credential',
        capabilities: ['resources:read', 'agent-runs:execute'],
        expiresAt: new Date(Date.now() + 60 * 60_000),
      })
      expect(issued.plaintextSecret).toMatch(/^pf_mcp_/u)
      const activated = await activateAgentBridgeCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        credentialId: issued.credential.id,
        expectedUpdatedAt: issued.credential.updatedAt,
        actor,
      })
      expect(activated.credential.enabled).toBe(true)
      const credential = await verifyAgentBridgeCredential({
        tenantId,
        venueId,
        plaintext: issued.plaintextSecret!,
      })
      const sessionId = randomUUID()
      await registerAgentBridgeSession({
        sessionId,
        venueId,
        provider: 'CODEX_SUBSCRIPTION',
        label: 'Disposable Codex runner',
        runnerVersion: 'integration/1',
        supportedModels: ['subscription-default'],
        credential,
      })
      const run = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'OPERATIONS',
          requestedOperation: 'disposable_bridge_smoke',
          requestPrompt: 'Return durable proof.',
          scopeSnapshot: { accessCapabilities: ['operations.read'] },
          status: 'QUEUED',
          modelProvider: 'codex-bridge',
          modelName: 'subscription-default',
          initiatedByType: 'HUMAN',
          initiatedById: actor.id,
        },
      })
      const claimed = await claimAgentBridgeTask({ sessionId, venueId, credential })
      expect(claimed.task?.id).toBe(run.id)
      await heartbeatAgentBridgeTask({
        sessionId,
        venueId,
        runId: run.id,
        leaseToken: claimed.task!.leaseToken,
        credential,
      })
      await completeAgentBridgeTask({
        sessionId,
        venueId,
        runId: run.id,
        leaseToken: claimed.task!.leaseToken,
        summary: 'Disposable lifecycle completed.',
        artifacts: [{ type: 'markdown', title: 'Proof', content: 'BRIDGE_E2E_OK' }],
        modelName: 'subscription-default',
        costE8Usd: 0n,
        credential,
      })
      const evidence = await db.agentRun.findUniqueOrThrow({
        where: { id: run.id },
        select: { status: true, artifacts: true, executionBridgeSessionId: true },
      })
      expect(evidence).toMatchObject({
        status: 'COMPLETED',
        executionBridgeSessionId: sessionId,
        artifacts: [{ type: 'markdown', title: 'Proof', content: 'BRIDGE_E2E_OK' }],
      })
      expect(
        await db.externalCredentialActivation.count({
          where: { credentialId: issued.credential.id, tenantId },
        }),
      ).toBe(1)
    })
  }, 30_000)
})
