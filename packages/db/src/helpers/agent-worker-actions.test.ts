import { describe, expect, it, vi } from 'vitest'

import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'

import {
  heartbeatAgentWorkerAction,
  listAgentWorkerHealth,
  registerAgentWorkerAction,
} from './agent-worker-actions'

const credential: VerifiedMcpCredentialScope = {
  credentialId: 'credential_1',
  tenantId: 'tenant_1',
  clientId: 'tenant_1',
  venueIds: ['venue_1'],
  capabilities: ['resources:read', 'accounts:read', 'agent-runs:execute'],
}
const now = new Date('2030-01-01T12:00:00.000Z')

function harness() {
  const tx = {
    externalAccessCredential: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'credential_1',
        scopeKey: '__client__',
        createdBy: 'secondary_admin',
        capabilities: credential.capabilities,
      }),
    },
    agentWorker: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: 'worker_id_1',
        workerKey: 'friend-hermes-01',
        status: 'ONLINE',
        leaseExpiresAt: new Date('2030-01-01T12:01:30.000Z'),
      }),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const agentWorker = {
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findMany: vi.fn().mockResolvedValue([]),
  }
  const client = {
    agentWorker,
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, agentWorker, client: client as never }
}

describe('portable agent worker registry', () => {
  it('registers an independent worker from verified credential authority without storing secrets', async () => {
    const { tx, client } = harness()
    const result = await registerAgentWorkerAction(
      {
        workerKey: 'friend-hermes-01',
        runtimeType: 'HERMES',
        label: 'Secondary administrator Hermes',
        protocolVersion: '2026-07-28',
        softwareVersion: '1.2.3',
        capabilities: ['resources:read', 'accounts:read'],
        agentRoles: ['CLIENT_OPERATIONS'],
        modelProvider: 'nous',
        modelName: 'deepseek-v4-flash',
        safeHealth: { queueDepth: 0, gpuAvailable: true },
      },
      credential,
      { now, client },
    )
    expect(result.status).toBe('ONLINE')
    expect(tx.agentWorker.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerAdminId: 'secondary_admin',
          credentialScopeKey: '__client__',
          capabilities: ['resources:read', 'accounts:read'],
        }),
      }),
    )
    expect(JSON.stringify(tx.agentWorker.create.mock.calls[0]?.[0])).not.toContain('secret')
  })

  it('rejects capability escalation and secret-shaped health metadata', async () => {
    await expect(
      registerAgentWorkerAction(
        {
          workerKey: 'friend-hermes-01',
          runtimeType: 'HERMES',
          label: 'Worker',
          protocolVersion: '2026-07-28',
          softwareVersion: '1.0.0',
          capabilities: ['billing:propose'],
          agentRoles: [],
          safeHealth: {},
        },
        credential,
        { now, client: harness().client },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      heartbeatAgentWorkerAction(
        { workerKey: 'friend-hermes-01', safeHealth: { apiToken: 'nope' } },
        credential,
        { now, client: harness().client },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('marks expired presence offline while retaining the durable worker record', async () => {
    const { agentWorker, client } = harness()
    await listAgentWorkerHealth({ clientId: 'tenant_1', now }, client)
    expect(agentWorker.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ONLINE', leaseExpiresAt: { lte: now } }),
        data: { status: 'OFFLINE', offlineAt: now },
      }),
    )
    expect(agentWorker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'tenant_1', status: { not: 'REVOKED' } } }),
    )
  })
})
