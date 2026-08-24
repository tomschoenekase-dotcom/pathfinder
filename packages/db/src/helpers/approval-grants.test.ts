import { describe, expect, it, vi } from 'vitest'

import {
  approvalParameterHash,
  consumeApprovalGrantAction,
  issueApprovalGrantAction,
} from './approval-grants'
import { defaultOperationalUpdateDraftPolicyConstraints } from '@pathfinder/contracts'

const now = new Date('2030-01-01T12:00:00.000Z')
const parameters = {
  clientId: 'tenant_1',
  venueId: 'venue_1',
  updateType: 'GENERAL_NOTICE',
  title: 'Gallery note',
}
const machineActor = {
  type: 'AGENT',
  actorId: 'agent_1',
  role: 'AGENT',
  agentIdentityId: 'agent_1',
  agentRunId: 'run_1',
  workerId: 'worker_1',
  credentialId: 'credential_1',
  capability: 'operational-updates:draft',
  modelProvider: 'hermes',
  modelName: 'worker-default',
} as const

function harness() {
  const tx = {
    approvalDecision: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'decision_1',
        grant: null,
        approvalRequest: {
          proposedAction: 'pathfinder.create_update_draft',
          agentIdentityId: 'agent_1',
        },
      }),
    },
    agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent_1' }) },
    approvalGrant: {
      create: vi.fn().mockResolvedValue({
        id: 'grant_1',
        operationId: '22222222-2222-4222-8222-222222222222',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentIdentityId: 'agent_1',
        actionName: 'pathfinder.create_update_draft',
        capability: 'operational-updates:draft',
        mode: 'ONE_SHOT',
        approvalDecisionId: 'decision_1',
        policyKey: null,
        scope: { tenantId: 'tenant_1', venueId: 'venue_1' },
        parameterHash: approvalParameterHash(parameters),
        constraints: {},
        issueReason: 'Approve the exact operational update draft.',
        maxUses: 1,
        useCount: 0,
        notBefore: now,
        expiresAt: new Date('2030-01-02T12:00:00.000Z'),
        revokedAt: null,
        createdByType: 'HUMAN',
        createdById: 'admin_1',
        createdAt: now,
        updatedAt: now,
      }),
      findFirst: vi.fn().mockResolvedValue({
        id: 'grant_1',
        mode: 'ONE_SHOT',
        constraints: {},
        parameterHash: approvalParameterHash(parameters),
        useCount: 0,
        maxUses: 1,
        notBefore: new Date('2029-12-31T12:00:00.000Z'),
        expiresAt: new Date('2030-01-02T12:00:00.000Z'),
        revokedAt: null,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    approvalGrantConsumption: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: 'consumption_1',
        approvalGrantId: 'grant_1',
        agentIdentityId: 'agent_1',
        agentRunId: 'run_1',
        workerId: 'worker_1',
        credentialId: 'credential_1',
        actionName: 'pathfinder.create_update_draft',
        capability: 'operational-updates:draft',
        parameterHash: approvalParameterHash(parameters),
        resultReference: null,
        consumedAt: now,
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, client: client as never }
}

function consumeInput(overrides = {}) {
  return {
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    approvalGrantId: 'grant_1',
    operationId: '11111111-1111-4111-8111-111111111111',
    actionName: 'pathfinder.create_update_draft',
    capability: 'operational-updates:draft',
    parameters,
    actor: machineActor,
    now,
    ...overrides,
  }
}

describe('approval grants', () => {
  it('hashes equivalent JSON objects identically', () => {
    expect(approvalParameterHash({ b: 2, a: [1, { z: true }] })).toBe(
      approvalParameterHash({ a: [1, { z: true }], b: 2 }),
    )
  })

  it('issues a one-shot grant only from the matching approved action and agent', async () => {
    const { tx, client } = harness()
    tx.approvalGrant.findFirst.mockResolvedValueOnce(null)
    await issueApprovalGrantAction(
      {
        operationId: '22222222-2222-4222-8222-222222222222',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentIdentityId: 'agent_1',
        actionName: 'pathfinder.create_update_draft',
        capability: 'operational-updates:draft',
        mode: 'ONE_SHOT',
        scope: { tenantId: 'tenant_1', venueId: 'venue_1' },
        approvalDecisionId: 'decision_1',
        parameters,
        issueReason: 'Approve the exact operational update draft.',
        maxUses: 1,
        notBefore: now,
        expiresAt: new Date('2030-01-02T12:00:00.000Z'),
        actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
      },
      client,
    )

    expect(tx.approvalDecision.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'decision_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          decision: 'APPROVED',
        }),
      }),
    )
    expect(tx.approvalGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          maxUses: 1,
          parameterHash: approvalParameterHash(parameters),
        }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'approval-grant.issued', actorType: 'HUMAN' }),
      }),
    )
  })

  it('atomically consumes exact authority with machine lineage', async () => {
    const { tx, client } = harness()
    const result = await consumeApprovalGrantAction(consumeInput(), client)

    expect(result.replayed).toBe(false)
    expect(tx.approvalGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'grant_1', useCount: 0, revokedAt: null }),
        data: { useCount: { increment: 1 } },
      }),
    )
    expect(tx.approvalGrantConsumption.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workerId: 'worker_1',
          agentRunId: 'run_1',
          credentialId: 'credential_1',
        }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'AGENT',
          workerId: 'worker_1',
          approvalGrantId: 'grant_1',
        }),
      }),
    )
  })

  it('replays the same operation without consuming a second use', async () => {
    const { tx, client } = harness()
    tx.approvalGrantConsumption.findFirst.mockResolvedValueOnce({
      id: 'consumption_1',
      approvalGrantId: 'grant_1',
      agentIdentityId: 'agent_1',
      agentRunId: 'run_1',
      workerId: 'worker_1',
      credentialId: 'credential_1',
      actionName: 'pathfinder.create_update_draft',
      capability: 'operational-updates:draft',
      parameterHash: approvalParameterHash(parameters),
      resultReference: 'OperationalUpdate:update_1',
      consumedAt: now,
    })
    const result = await consumeApprovalGrantAction(consumeInput(), client)
    expect(result.replayed).toBe(true)
    expect(tx.approvalGrant.findFirst).not.toHaveBeenCalled()
    expect(tx.approvalGrant.updateMany).not.toHaveBeenCalled()
    expect(tx.approvalGrantConsumption.create).not.toHaveBeenCalled()
  })

  it('rejects parameter substitution before changing use count', async () => {
    const { tx, client } = harness()
    await expect(
      consumeApprovalGrantAction(
        consumeInput({ parameters: { ...parameters, title: 'Unapproved title' } }),
        client,
      ),
    ).rejects.toMatchObject({ code: 'PARAMETER_MISMATCH' })
    expect(tx.approvalGrant.updateMany).not.toHaveBeenCalled()
  })

  it('rejects exhausted authority', async () => {
    const { tx, client } = harness()
    tx.approvalGrant.findFirst.mockResolvedValueOnce({
      id: 'grant_1',
      mode: 'ONE_SHOT',
      constraints: {},
      parameterHash: approvalParameterHash(parameters),
      useCount: 1,
      maxUses: 1,
      notBefore: new Date('2029-12-31T12:00:00.000Z'),
      expiresAt: new Date('2030-01-02T12:00:00.000Z'),
      revokedAt: null,
    })
    await expect(consumeApprovalGrantAction(consumeInput(), client)).rejects.toMatchObject({
      code: 'EXHAUSTED',
    })
    expect(tx.approvalGrantConsumption.create).not.toHaveBeenCalled()
  })

  it('consumes a reviewed policy-backed update-draft grant within its bounds', async () => {
    const { tx, client } = harness()
    tx.approvalGrant.findFirst.mockResolvedValueOnce({
      id: 'grant_policy',
      mode: 'POLICY_BACKED',
      constraints: {
        ...defaultOperationalUpdateDraftPolicyConstraints(),
        maxTitleChars: 20,
        maxBodyChars: 100,
      },
      parameterHash: null,
      useCount: 0,
      maxUses: null,
      notBefore: new Date('2029-12-31T12:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
    })

    const result = await consumeApprovalGrantAction(
      consumeInput({
        approvalGrantId: 'grant_policy',
        capability: 'updates:draft',
        parameters: {
          clientId: 'tenant_1',
          venueId: 'venue_1',
          updateType: 'GENERAL_NOTICE',
          severity: 'INFO',
          priority: 'NORMAL',
          title: 'Gallery note',
          body: 'Temporarily unavailable.',
          startsAt: '2030-01-01T12:00:00.000Z',
          expiresAt: '2030-01-01T13:00:00.000Z',
        },
      }),
      client,
    )

    expect(result.replayed).toBe(false)
    expect(tx.approvalGrant.updateMany).toHaveBeenCalledTimes(1)
  })

  it('rejects policy parameters outside reviewed content bounds', async () => {
    const { tx, client } = harness()
    tx.approvalGrant.findFirst.mockResolvedValueOnce({
      id: 'grant_policy',
      mode: 'POLICY_BACKED',
      constraints: {
        ...defaultOperationalUpdateDraftPolicyConstraints(),
        maxTitleChars: 5,
      },
      parameterHash: null,
      useCount: 0,
      maxUses: null,
      notBefore: new Date('2029-12-31T12:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
    })
    await expect(
      consumeApprovalGrantAction(
        consumeInput({
          approvalGrantId: 'grant_policy',
          capability: 'updates:draft',
          parameters: {
            clientId: 'tenant_1',
            venueId: 'venue_1',
            updateType: 'GENERAL_NOTICE',
            severity: 'INFO',
            priority: 'NORMAL',
            title: 'Too long',
            body: 'Temporarily unavailable.',
            startsAt: '2030-01-01T12:00:00.000Z',
            expiresAt: '2030-01-01T13:00:00.000Z',
          },
        }),
        client,
      ),
    ).rejects.toMatchObject({ code: 'PARAMETER_MISMATCH' })
    expect(tx.approvalGrant.updateMany).not.toHaveBeenCalled()
  })
})
