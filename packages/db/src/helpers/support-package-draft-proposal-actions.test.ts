import { describe, expect, it, vi } from 'vitest'

import {
  prepareSupportPackageDraftProposalAction,
  supportPackageDraftPayloadHash,
} from './support-package-draft-proposal-actions'

const payload = {
  schemaVersion: 3,
  places: { create: [], update: [], delete: [] },
  knowledgeEntries: {
    create: [
      {
        itemKey: '22222222-2222-4222-8222-222222222222',
        provenance: { sourceType: 'support-request', contentOrigin: 'HUMAN_AUTHORED' },
        value: {
          title: 'Updated visitor guidance',
          category: 'Visitor information',
          content: 'The requested visitor guidance is now current.',
          isEnabled: true,
        },
      },
    ],
    update: [],
    delete: [],
  },
}

const operationCounts = {
  venuePatch: false,
  placeCreates: 0,
  placeUpdates: 0,
  placeDeletes: 0,
  knowledgeCreates: 1,
  knowledgeUpdates: 0,
  knowledgeDeletes: 0,
  total: 1,
}

const input = {
  operationId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  requestId: 'request_1',
  expectedVersion: 5,
  fromStatus: 'IN_REVIEW' as const,
  draftKey: '33333333-3333-4333-8333-333333333333',
  payload,
  operationCounts,
  reason: 'The requested content change is exact, reviewable, and ready for a package draft.',
  evidence: [{ type: 'SupportMessage', id: 'message_1' }],
  actor: {
    type: 'AGENT' as const,
    actorId: 'agent_1',
    role: 'AGENT' as const,
    agentIdentityId: 'agent_1',
    agentRunId: 'run_1',
    workerId: 'worker_1',
    credentialId: 'credential_1',
    capability: 'packages:draft',
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
      findFirst: vi.fn().mockResolvedValue({ id: 'run_1', requestedOperation: 'draft change' }),
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

describe('support package-draft proposal action', () => {
  it('freezes an exact V3 draft proposal without creating or changing operational state', async () => {
    const { tx, client } = harness()
    await expect(prepareSupportPackageDraftProposalAction(input, client)).resolves.toMatchObject({
      proposalPayloadHash: supportPackageDraftPayloadHash(payload),
      replayed: false,
    })
    expect(tx.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          proposedAction: 'pathfinder.apply_support_package_draft',
          riskCategory: 'MEDIUM',
          scopeSnapshot: expect.objectContaining({
            payload,
            operationCounts,
            packageDraftCreated: false,
            packageLinked: false,
            packageApproved: false,
            packageApplied: false,
            packagePublished: false,
            supportRequestChanged: false,
            customerContacted: false,
            externalDeliveryTriggered: false,
            executionAuthorized: false,
          }),
        }),
      }),
    )
    expect(tx.supportRequest).not.toHaveProperty('update')
    expect(tx).not.toHaveProperty('venuePackage')
    expect(tx).not.toHaveProperty('supportHandoff')
    expect(tx).not.toHaveProperty('supportMessage')
  })

  it('fails closed while requested information remains unresolved', async () => {
    const { tx, client } = harness(['Current hours'])
    await expect(prepareSupportPackageDraftProposalAction(input, client)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(tx.approvalRequest.create).not.toHaveBeenCalled()
  })
})
