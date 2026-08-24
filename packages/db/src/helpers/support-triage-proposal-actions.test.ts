import { describe, expect, it, vi } from 'vitest'

import { prepareSupportTriageProposalAction } from './support-triage-proposal-actions'

const input = {
  operationId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  requestId: 'request_1',
  expectedVersion: 4,
  category: 'CONTENT_CORRECTION' as const,
  missingInformation: [' Current admission price ', 'Effective date'],
  reason: 'The source material does not identify the current admission price or effective date.',
  evidence: [{ type: 'SupportMessage', id: 'message_1' }],
  actor: {
    type: 'AGENT' as const,
    actorId: 'agent_1',
    role: 'AGENT' as const,
    agentIdentityId: 'agent_1',
    agentRunId: 'run_1',
    workerId: 'worker_1',
    credentialId: 'credential_1',
    capability: 'support:triage',
    modelProvider: 'openai',
    modelName: 'gpt-test',
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
  },
}

function harness() {
  const created = {
    id: input.operationId,
    tenantId: input.tenantId,
    venueId: input.venueId,
    agentIdentityId: input.actor.agentIdentityId,
    agentRunId: input.actor.agentRunId,
    proposedAction: 'pathfinder.apply_support_triage',
    scopeSnapshot: {},
    reason: input.reason,
    createdAt: new Date(),
  }
  const tx = {
    approvalRequest: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(created),
    },
    agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent_1' }) },
    agentRun: {
      findFirst: vi.fn().mockResolvedValue({ id: 'run_1', requestedOperation: 'triage support' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    supportRequest: {
      findFirst: vi.fn().mockResolvedValue({ id: 'request_1', version: 4, status: 'OPEN' }),
    },
    agentAction: { create: vi.fn().mockResolvedValue({ id: 'action_1' }) },
    agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'timeline_1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
  }
  return { tx, client: client as never }
}

describe('support triage proposal action', () => {
  it('records exact review state and lineage without mutating the support request', async () => {
    const { tx, client } = harness()

    await expect(prepareSupportTriageProposalAction(input, client)).resolves.toMatchObject({
      approvalRequest: { id: input.operationId },
      replayed: false,
    })

    expect(tx.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: input.operationId,
          proposedAction: 'pathfinder.apply_support_triage',
          riskCategory: 'LOW',
          scopeSnapshot: {
            contractVersion: 1,
            tenantId: 'tenant_1',
            venueId: 'venue_1',
            requestId: 'request_1',
            expectedVersion: 4,
            proposedCategory: 'CONTENT_CORRECTION',
            proposedMissingInformation: ['Current admission price', 'Effective date'],
            supportRequestChanged: false,
            clientActivityChanged: false,
            customerContacted: false,
            executionAuthorized: false,
          },
          artifacts: input.evidence,
        }),
      }),
    )
    expect(tx.agentAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionName: 'torchiko.support.propose_triage',
          beforeVersionRef: 'SupportRequest:request_1:v4',
          afterVersionRef: `ApprovalRequest:${input.operationId}:PENDING`,
          modelProvider: 'openai',
          modelName: 'gpt-test',
        }),
      }),
    )
    expect(tx.agentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'AWAITING_APPROVAL' } }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'support-request.triage-proposed',
          afterState: expect.objectContaining({
            supportRequestChanged: false,
            clientActivityChanged: false,
            customerContacted: false,
            executionAuthorized: false,
          }),
        }),
      }),
    )
    expect(tx.supportRequest).not.toHaveProperty('update')
    expect(tx.supportRequest).not.toHaveProperty('updateMany')
    expect(tx).not.toHaveProperty('supportMessage')
    expect(tx).not.toHaveProperty('supportRequestParticipant')
  })

  it('replays only an exact existing proposal without reading or mutating the request', async () => {
    const { tx, client } = harness()
    tx.approvalRequest.findUnique.mockResolvedValueOnce({
      id: input.operationId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentIdentityId: input.actor.agentIdentityId,
      agentRunId: input.actor.agentRunId,
      proposedAction: 'pathfinder.apply_support_triage',
      scopeSnapshot: {
        contractVersion: 1,
        tenantId: input.tenantId,
        venueId: input.venueId,
        requestId: input.requestId,
        expectedVersion: input.expectedVersion,
        proposedCategory: input.category,
        proposedMissingInformation: ['Current admission price', 'Effective date'],
        supportRequestChanged: false,
        clientActivityChanged: false,
        customerContacted: false,
        executionAuthorized: false,
      },
      artifacts: input.evidence,
      reason: input.reason,
      createdAt: new Date(),
      decision: null,
    })

    await expect(prepareSupportTriageProposalAction(input, client)).resolves.toMatchObject({
      replayed: true,
    })
    expect(tx.agentIdentity.findFirst).not.toHaveBeenCalled()
    expect(tx.supportRequest.findFirst).not.toHaveBeenCalled()
    expect(tx.approvalRequest.create).not.toHaveBeenCalled()
  })

  it('fails closed for capability, scope, stale request, closed request, and replay drift', async () => {
    await expect(
      prepareSupportTriageProposalAction(
        { ...input, actor: { ...input.actor, capability: 'support:read' } },
        harness().client,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const missingIdentity = harness()
    missingIdentity.tx.agentIdentity.findFirst.mockResolvedValueOnce(null)
    await expect(
      prepareSupportTriageProposalAction(input, missingIdentity.client),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const stale = harness()
    stale.tx.supportRequest.findFirst.mockResolvedValueOnce({
      id: 'request_1',
      version: 5,
      status: 'OPEN',
    })
    await expect(prepareSupportTriageProposalAction(input, stale.client)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(stale.tx.approvalRequest.create).not.toHaveBeenCalled()

    const closed = harness()
    closed.tx.supportRequest.findFirst.mockResolvedValueOnce({
      id: 'request_1',
      version: 4,
      status: 'COMPLETED',
    })
    await expect(prepareSupportTriageProposalAction(input, closed.client)).rejects.toMatchObject({
      code: 'CONFLICT',
    })

    const drift = harness()
    drift.tx.approvalRequest.findUnique.mockResolvedValueOnce({
      id: input.operationId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentIdentityId: input.actor.agentIdentityId,
      agentRunId: input.actor.agentRunId,
      proposedAction: 'pathfinder.apply_support_triage',
      scopeSnapshot: { different: true },
      artifacts: input.evidence,
      reason: input.reason,
      createdAt: new Date(),
      decision: null,
    })
    await expect(prepareSupportTriageProposalAction(input, drift.client)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })
})
