import { describe, expect, it, vi } from 'vitest'

import { prepareSupportInformationRequestProposalAction } from './support-information-request-proposal-actions'

const input = {
  operationId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  requestId: 'request_1',
  expectedVersion: 4,
  fromStatus: 'IN_REVIEW' as const,
  body: 'Please provide the current admission price and effective date.',
  missingInformation: ['Current admission price', 'Effective date'],
  reason: 'The current support evidence does not contain these facts.',
  evidence: [{ type: 'SupportMessage', id: 'message_1' }],
  actor: {
    type: 'AGENT' as const,
    actorId: 'agent_1',
    role: 'AGENT' as const,
    agentIdentityId: 'agent_1',
    agentRunId: 'run_1',
    workerId: 'worker_1',
    credentialId: 'credential_1',
    capability: 'support:request-information',
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
  },
}

function harness() {
  const tx = {
    approvalRequest: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ ...data, createdAt: new Date() })),
    },
    agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent_1' }) },
    agentRun: {
      findFirst: vi.fn().mockResolvedValue({ id: 'run_1', requestedOperation: 'request facts' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    supportRequest: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'request_1',
        version: 4,
        status: 'IN_REVIEW',
        missingInformation: ['Current admission price', 'Effective date'],
      }),
    },
    agentAction: { create: vi.fn().mockResolvedValue({ id: 'action_1' }) },
    agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'timeline_1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  return {
    tx,
    client: { $transaction: vi.fn(async (operation) => operation(tx)) } as never,
  }
}

describe('support information-request proposal action', () => {
  it('records exact founder-review state without contacting or changing the client request', async () => {
    const { tx, client } = harness()
    await expect(
      prepareSupportInformationRequestProposalAction(input, client),
    ).resolves.toMatchObject({
      replayed: false,
    })
    expect(tx.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          proposedAction: 'pathfinder.apply_support_information_request',
          riskCategory: 'MEDIUM',
          scopeSnapshot: expect.objectContaining({
            fromStatus: 'IN_REVIEW',
            toStatus: 'WAITING_FOR_CLIENT',
            body: input.body,
            missingInformation: input.missingInformation,
            clientVisibleMessageCreated: false,
            customerContacted: false,
            externalDeliveryTriggered: false,
          }),
        }),
      }),
    )
    expect(tx.supportRequest).not.toHaveProperty('update')
    expect(tx).not.toHaveProperty('supportMessage')
  })

  it('fails closed when the checklist differs from current triage', async () => {
    const { tx, client } = harness()
    tx.supportRequest.findFirst.mockResolvedValueOnce({
      id: 'request_1',
      version: 4,
      status: 'IN_REVIEW',
      missingInformation: ['Different fact'],
    })
    await expect(
      prepareSupportInformationRequestProposalAction(input, client),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(tx.approvalRequest.create).not.toHaveBeenCalled()
  })
})
