import { beforeEach, describe, expect, it, vi } from 'vitest'

const { consumeApproval, createUpdate, buildPreview } = vi.hoisted(() => ({
  consumeApproval: vi.fn(),
  createUpdate: vi.fn(),
  buildPreview: vi.fn(),
}))

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  consumeApprovalGrantAction: consumeApproval,
  createOperationalUpdateAction: createUpdate,
  buildOperationalUpdatePreview: buildPreview,
}))

import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'

import { createSafeOperationalMcpRegistry } from './composition'

const credential = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueIds: ['venue-1'],
  capabilities: ['packages:draft'],
} satisfies VerifiedMcpCredentialScope

describe('safe operational MCP composition', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('exposes the canonical catalog while unbound writes still fail closed', async () => {
    const registry = createSafeOperationalMcpRegistry({
      approvalGrant: {
        findFirst: vi.fn().mockResolvedValue({ id: 'grant-1', maxUses: 1, useCount: 0 }),
      },
    } as never)
    expect(registry.listTools().some((tool) => tool.name === 'pathfinder.read')).toBe(true)
    await expect(
      registry.callTool(
        'pathfinder.create_package_draft',
        {
          clientId: 'tenant-1',
          venueId: 'venue-1',
          title: 'Synthetic draft',
          changeRequest: 'Prepare a reviewable synthetic change.',
          sourceIds: [],
        },
        { credential, approvalGrantId: 'grant-1' },
      ),
    ).rejects.toMatchObject({
      code: 'MCP_ACTION_UNAVAILABLE',
    })
  })

  it('consumes an exact one-shot grant and uses the canonical machine-attributed draft action', async () => {
    const update = {
      id: 'update-1',
      status: 'DRAFT',
      isActive: false,
      startsAt: new Date('2030-01-01T10:00:00.000Z'),
      expiresAt: new Date('2030-01-01T12:00:00.000Z'),
    }
    consumeApproval.mockResolvedValue({
      replayed: false,
      consumption: { id: 'consumption-1', resultReference: null },
    })
    createUpdate.mockResolvedValue({
      update,
      preview: { lifecycle: 'DRAFT', guestVisibleNow: false },
    })
    const tx = {
      operationalUpdate: { findFirst: vi.fn() },
      approvalGrantConsumption: { update: vi.fn().mockResolvedValue({}) },
    }
    const database = {
      approvalGrant: {
        findFirst: vi.fn().mockResolvedValue({ id: 'grant-1', maxUses: 1, useCount: 0 }),
      },
      agentWorker: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'worker-id-1',
          workerKey: 'worker-1',
          modelProvider: 'openai',
          modelName: 'gpt-test',
        }),
      },
      agentRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }) },
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    }
    const registry = createSafeOperationalMcpRegistry(database as never)
    const machineCredential: VerifiedMcpCredentialScope = {
      ...credential,
      capabilities: ['updates:draft'],
    }
    const input = {
      clientId: 'tenant-1',
      venueId: 'venue-1',
      operationId: '8c5f9673-d43d-4e40-a01d-cf188431ab81',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      title: 'Synthetic closure draft',
      body: 'Review before publishing.',
      startsAt: '2030-01-01T10:00:00.000Z',
      expiresAt: '2030-01-01T12:00:00.000Z',
    }

    const result = await registry.callTool('pathfinder.create_update_draft', input, {
      credential: machineCredential,
      approvalGrantId: 'grant-1',
    })

    expect(consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalGrantId: 'grant-1',
        operationId: input.operationId,
        actionName: 'pathfinder.create_update_draft',
        capability: 'updates:draft',
        parameters: expect.objectContaining({
          updateType: 'GENERAL_NOTICE',
          severity: 'INFO',
          priority: 'NORMAL',
          title: input.title,
        }),
        actor: expect.objectContaining({
          type: 'AGENT',
          actorId: 'agent-1',
          agentRunId: 'run-1',
          workerId: 'worker-1',
          approvalGrantId: 'grant-1',
        }),
      }),
      expect.anything(),
    )
    expect(createUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        schedule: false,
        actor: expect.objectContaining({ type: 'AGENT', capability: 'updates:draft' }),
      }),
      expect.anything(),
    )
    expect(tx.approvalGrantConsumption.update).toHaveBeenCalledWith({
      where: { id: 'consumption-1' },
      data: { resultReference: 'OperationalUpdate:update-1' },
    })
    expect(result.structuredContent.data).toMatchObject({ id: 'update-1', replayed: false })
    expect(database.agentWorker.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          credentialId: 'credential-1',
          capabilities: { has: 'updates:draft' },
        }),
      }),
    )
    expect(database.agentRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ executionWorkerId: 'worker-id-1' }),
      }),
    )
  })
})
