import { describe, expect, it, vi } from 'vitest'

import {
  approvalParameterHash,
  consumeApprovalGrantAction,
  issueApprovalGrantAction,
} from './approval-grants'
import {
  defaultIntakeNotesProposalPolicyConstraints,
  defaultOperationalUpdateDraftPolicyConstraints,
  defaultSupportRequestDraftPolicyConstraints,
} from '@pathfinder/contracts'

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
    agentOutcomeObservation: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'outcome_1',
          agentRunId: 'run_1',
          signalKind: 'HUMAN_REVIEW',
          verdict: 'SUCCESS',
          taskClass: 'OPERATIONAL_UPDATE_DRAFT',
          modelProvider: 'openai',
          modelName: 'gpt-5',
          createdAt: now,
        },
      ]),
    },
    approvalGrantEvidence: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
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
        authorityEvidence: [],
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
      findFirstOrThrow: vi.fn().mockResolvedValue({
        id: 'grant_1',
        authorityEvidence: [],
      }),
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

function policyIssueInput(overrides = {}) {
  return {
    operationId: '33333333-3333-4333-8333-333333333333',
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    agentIdentityId: 'agent_1',
    actionName: 'pathfinder.create_update_draft',
    capability: 'updates:draft',
    mode: 'POLICY_BACKED' as const,
    scope: { tenantId: 'tenant_1', venueId: 'venue_1', effect: 'DRAFT_ONLY' },
    policyKey: 'support-operational-update-drafts',
    constraints: defaultOperationalUpdateDraftPolicyConstraints(),
    issueReason: 'Reviewed outcome evidence supports bounded draft authority.',
    outcomeObservationIds: ['outcome_1'],
    actor: { type: 'HUMAN' as const, id: 'admin_1', role: 'PLATFORM_ADMIN' as const },
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

  it('binds a policy grant to exact outcome evidence in the same agent and venue scope', async () => {
    const { tx, client } = harness()
    tx.approvalGrant.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    tx.approvalGrant.create.mockResolvedValueOnce({
      id: 'grant_policy',
      operationId: '33333333-3333-4333-8333-333333333333',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      approvalDecisionId: null,
      policyKey: 'support-operational-update-drafts',
      agentIdentityId: 'agent_1',
      actionName: 'pathfinder.create_update_draft',
      capability: 'updates:draft',
      mode: 'POLICY_BACKED',
      scope: { tenantId: 'tenant_1', venueId: 'venue_1', effect: 'DRAFT_ONLY' },
      parameterHash: null,
      constraints: defaultOperationalUpdateDraftPolicyConstraints(),
      issueReason: 'Reviewed outcome evidence supports bounded draft authority.',
      maxUses: null,
      useCount: 0,
      notBefore: now,
      expiresAt: null,
      revokedAt: null,
      createdByType: 'HUMAN',
      createdById: 'admin_1',
      createdAt: now,
      updatedAt: now,
      authorityEvidence: [{ outcomeObservationId: 'outcome_1' }],
    })

    const result = await issueApprovalGrantAction(policyIssueInput({ notBefore: now }), client)

    expect(result.replayed).toBe(false)
    expect(tx.agentOutcomeObservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          agentIdentityId: 'agent_1',
          id: { in: ['outcome_1'] },
        }),
      }),
    )
    expect(tx.approvalGrantEvidence.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          {
            tenantId: 'tenant_1',
            approvalGrantId: 'grant_policy',
            outcomeObservationId: 'outcome_1',
          },
        ],
      }),
    )
  })

  it('rejects policy evidence outside the exact agent or venue scope', async () => {
    const { tx, client } = harness()
    tx.approvalGrant.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    tx.agentOutcomeObservation.findMany.mockResolvedValueOnce([])

    await expect(
      issueApprovalGrantAction(policyIssueInput({ notBefore: now }), client),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(tx.approvalGrant.create).not.toHaveBeenCalled()
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

  it('consumes only a private support draft inside reviewed policy bounds', async () => {
    const { tx, client } = harness()
    tx.approvalGrant.findFirst.mockResolvedValueOnce({
      id: 'grant_support',
      mode: 'POLICY_BACKED',
      constraints: {
        ...defaultSupportRequestDraftPolicyConstraints(),
        maxSubjectChars: 30,
        maxBodyChars: 100,
      },
      parameterHash: null,
      useCount: 0,
      maxUses: null,
      notBefore: new Date('2029-12-31T12:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
    })
    const supportInput = consumeInput({
      approvalGrantId: 'grant_support',
      actionName: 'pathfinder.create_support_draft',
      capability: 'support:draft',
      parameters: {
        clientId: 'tenant_1',
        venueId: 'venue_1',
        category: 'GENERAL',
        subject: 'Review answer',
        body: 'Internal review only.',
      },
      actor: { ...machineActor, capability: 'support:draft' },
    })
    await expect(consumeApprovalGrantAction(supportInput, client)).resolves.toMatchObject({
      replayed: false,
    })
    expect(tx.approvalGrant.updateMany).toHaveBeenCalledTimes(1)
  })

  it('rejects a support draft outside its reviewed subject bound', async () => {
    const { tx, client } = harness()
    tx.approvalGrant.findFirst.mockResolvedValueOnce({
      id: 'grant_support',
      mode: 'POLICY_BACKED',
      constraints: {
        ...defaultSupportRequestDraftPolicyConstraints(),
        maxSubjectChars: 5,
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
          approvalGrantId: 'grant_support',
          actionName: 'pathfinder.create_support_draft',
          capability: 'support:draft',
          parameters: {
            clientId: 'tenant_1',
            venueId: 'venue_1',
            category: 'GENERAL',
            subject: 'Too long',
            body: 'Internal review only.',
          },
          actor: { ...machineActor, capability: 'support:draft' },
        }),
        client,
      ),
    ).rejects.toMatchObject({ code: 'PARAMETER_MISMATCH' })
    expect(tx.approvalGrant.updateMany).not.toHaveBeenCalled()
  })

  it('consumes only a NOTES intake proposal inside reviewed policy bounds', async () => {
    const { tx, client } = harness()
    tx.approvalGrant.findFirst.mockResolvedValueOnce({
      id: 'grant_intake',
      mode: 'POLICY_BACKED',
      constraints: {
        ...defaultIntakeNotesProposalPolicyConstraints(),
        maxNotesChars: 100,
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
          approvalGrantId: 'grant_intake',
          actionName: 'pathfinder.create_intake_notes_proposal',
          capability: 'intake:draft',
          parameters: {
            clientId: 'tenant_1',
            venueId: 'venue_1',
            kind: 'NOTES',
            notes: 'Private onboarding notes for review.',
          },
          actor: { ...machineActor, capability: 'intake:draft' },
        }),
        client,
      ),
    ).resolves.toMatchObject({ replayed: false })
    expect(tx.approvalGrant.updateMany).toHaveBeenCalledTimes(1)
  })

  it('rejects an intake proposal outside its reviewed notes bound', async () => {
    const { tx, client } = harness()
    tx.approvalGrant.findFirst.mockResolvedValueOnce({
      id: 'grant_intake',
      mode: 'POLICY_BACKED',
      constraints: {
        ...defaultIntakeNotesProposalPolicyConstraints(),
        maxNotesChars: 5,
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
          approvalGrantId: 'grant_intake',
          actionName: 'pathfinder.create_intake_notes_proposal',
          capability: 'intake:draft',
          parameters: {
            clientId: 'tenant_1',
            venueId: 'venue_1',
            kind: 'NOTES',
            notes: 'Too long',
          },
          actor: { ...machineActor, capability: 'intake:draft' },
        }),
        client,
      ),
    ).rejects.toMatchObject({ code: 'PARAMETER_MISMATCH' })
    expect(tx.approvalGrant.updateMany).not.toHaveBeenCalled()
  })
})
