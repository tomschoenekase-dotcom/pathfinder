import { describe, expect, it, vi } from 'vitest'

import { prepareIntakeV1PackageDraftProposalAction } from './intake-v1-package-draft-proposal-actions'

const base = {
  operationId: '11111111-1111-4111-8111-111111111111',
  clientId: 'tenant-1',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  submissionId: 'submission-1',
  revision: 2,
  manifestHash: 'a'.repeat(64),
  candidateHash: 'b'.repeat(64),
  payloadHash: 'c'.repeat(64),
  selectionHash: 'd'.repeat(64),
  selectedMemberIds: ['member-1'],
  partialAcknowledged: false,
  draftOperationId: '22222222-2222-4222-8222-222222222222',
  executionLeaseToken: '33333333-3333-4333-8333-333333333333',
  reason: 'Prepare exact reviewed V1 draft.',
  actor: {
    type: 'AGENT' as const,
    actorId: 'agent-1',
    role: 'AGENT' as const,
    agentIdentityId: 'agent-1',
    agentRunId: 'run-1',
    workerId: 'worker-1',
    credentialId: 'credential-1',
    capability: 'packages:draft',
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
  },
}

describe('V1 package draft proposal action', () => {
  it('returns an exact immutable replay before mutable authority checks', async () => {
    const existing = {
      id: base.operationId,
      tenantId: base.tenantId,
      venueId: base.venueId,
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      proposedAction: 'pathfinder.apply_intake_v1_package_draft',
      reason: base.reason,
      createdAt: new Date(),
      scopeSnapshot: {
        contractVersion: 1,
        tenantId: base.tenantId,
        venueId: base.venueId,
        submissionId: base.submissionId,
        revision: 2,
        manifestHash: base.manifestHash,
        candidateHash: base.candidateHash,
        payloadHash: base.payloadHash,
        selectionHash: base.selectionHash,
        selectedMemberIds: base.selectedMemberIds,
        partialAcknowledged: false,
        draftOperationId: base.draftOperationId,
        packageDraftCreated: false,
        packageApproved: false,
        packageApplied: false,
        packagePublished: false,
        executionAuthorized: false,
      },
    }
    existing.scopeSnapshot = Object.fromEntries(
      Object.entries(existing.scopeSnapshot).reverse(),
    ) as typeof existing.scopeSnapshot
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      approvalRequest: { findUnique: vi.fn().mockResolvedValue(existing) },
    }
    const client = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    }
    await expect(
      prepareIntakeV1PackageDraftProposalAction(base, client as never),
    ).resolves.toMatchObject({ replayed: true })
    expect(tx.approvalRequest.findUnique).toHaveBeenCalledOnce()
  })

  it('rejects client/tenant disagreement before persistence', async () => {
    const client = { $transaction: vi.fn() }
    await expect(
      prepareIntakeV1PackageDraftProposalAction({ ...base, clientId: 'other' }, client as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })
})
