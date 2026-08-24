import { describe, expect, it, vi } from 'vitest'

import { prepareSupportCompletionProposalAction } from './support-completion-proposal-actions'

const input = {
  operationId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  requestId: 'request_1',
  expectedVersion: 5,
  fromStatus: 'IN_REVIEW' as const,
  body: 'Your requested update is complete and ready to use.',
  reason: 'The requested venue change passed review and no information remains outstanding.',
  evidence: [{ type: 'SupportMessage', id: 'message_1' }],
  actor: {
    type: 'AGENT' as const,
    actorId: 'agent_1',
    role: 'AGENT' as const,
    agentIdentityId: 'agent_1',
    agentRunId: 'run_1',
    workerId: 'worker_1',
    credentialId: 'credential_1',
    capability: 'support:complete',
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
  },
}

function harness(missingInformation: string[] = []) {
  const tx = {
    approvalRequest: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ ...data, createdAt: new Date() })),
    },
    agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent_1' }) },
    agentRun: {
      findFirst: vi.fn().mockResolvedValue({ id: 'run_1', requestedOperation: 'complete request' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    supportRequest: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'request_1',
        version: 5,
        status: 'IN_REVIEW',
        missingInformation,
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

describe('support completion proposal action', () => {
  it('records exact founder-review state without contacting or changing the client request', async () => {
    const { tx, client } = harness()
    await expect(prepareSupportCompletionProposalAction(input, client)).resolves.toMatchObject({
      replayed: false,
    })
    expect(tx.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          proposedAction: 'pathfinder.apply_support_completion',
          riskCategory: 'MEDIUM',
          scopeSnapshot: expect.objectContaining({
            fromStatus: 'IN_REVIEW',
            toStatus: 'COMPLETED',
            body: input.body,
            missingInformationCount: 0,
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

  it('fails closed while requested information remains unresolved', async () => {
    const { tx, client } = harness(['Current photograph'])
    await expect(prepareSupportCompletionProposalAction(input, client)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(tx.approvalRequest.create).not.toHaveBeenCalled()
  })
})
