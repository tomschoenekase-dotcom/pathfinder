import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  transaction: vi.fn(),
  decision: vi.fn(),
  grant: vi.fn(),
  request: vi.fn(),
  revision: vi.fn(),
}))
vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  withTenantIsolationBypass: mocks.bypass,
  recordApprovalDecisionInTransaction: mocks.decision,
  issueApprovalGrantInTransaction: mocks.grant,
  db: { $transaction: mocks.transaction },
}))

import type { TRPCContext } from '../../context'
import { adminIntakeV1PackageDraftApprovalRouter } from './intake-v1-package-draft-approval'

const snapshot = {
  contractVersion: 1,
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  submissionId: 'submission-1',
  revision: 1,
  manifestHash: 'a'.repeat(64),
  candidateHash: 'b'.repeat(64),
  payloadHash: 'c'.repeat(64),
  selectionHash: 'd'.repeat(64),
  selectedMemberIds: ['member-1'],
  partialAcknowledged: false,
  draftOperationId: '11111111-1111-4111-8111-111111111111',
  packageDraftCreated: false,
  packageApproved: false,
  packageApplied: false,
  packagePublished: false,
  executionAuthorized: false,
}
const input = {
  operationId: '22222222-2222-4222-8222-222222222222',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  approvalRequestId: 'request-1',
  decision: 'APPROVED' as const,
  reason: 'Reviewed exact selection.',
}
function caller() {
  return adminIntakeV1PackageDraftApprovalRouter.createCaller({
    db: {} as never,
    headers: new Headers(),
    session: { userId: 'admin-1', activeTenantId: null, role: 'STAFF', isPlatformAdmin: true },
  } as TRPCContext)
}

beforeEach(() => {
  vi.clearAllMocks()
  const tx = {
    approvalRequest: { findFirst: mocks.request },
    intakeV1SubmissionRevision: { findFirst: mocks.revision },
  }
  mocks.transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) =>
    callback(tx),
  )
  mocks.request.mockResolvedValue({
    id: 'request-1',
    agentIdentityId: 'agent-1',
    scopeSnapshot: snapshot,
    expiresAt: null,
    decision: null,
  })
  mocks.revision.mockResolvedValue({ id: 'revision-1' })
  mocks.decision.mockResolvedValue({
    id: 'decision-1',
    decision: 'APPROVED',
    decidedById: 'admin-1',
    reason: input.reason,
  })
  mocks.grant.mockResolvedValue({ id: 'grant-1' })
})

describe('V1 package draft approval', () => {
  it('records the human decision and exact one-shot grant in the same transaction without execution', async () => {
    const result = await caller().decideIntakeV1PackageDraftProposal(input)
    const tx = (mocks.decision.mock.calls[0] as unknown[])[0]
    expect(mocks.grant.mock.calls[0]?.[0]).toBe(tx)
    expect(mocks.grant).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actionName: 'pathfinder.apply_intake_v1_package_draft',
        capability: 'packages:draft',
        parameters: expect.objectContaining({
          submissionId: 'submission-1',
          draftOperationId: snapshot.draftOperationId,
        }),
      }),
    )
    expect(result).toMatchObject({ executionTriggered: false, approvalGrant: { id: 'grant-1' } })
  })

  it('reuses an exact immutable decision and fails closed on stale revision or grant failure', async () => {
    mocks.request.mockResolvedValueOnce({
      id: 'request-1',
      agentIdentityId: 'agent-1',
      scopeSnapshot: snapshot,
      expiresAt: null,
      decision: {
        id: 'decision-1',
        decision: 'APPROVED',
        decidedById: 'admin-1',
        reason: input.reason,
      },
    })
    await caller().decideIntakeV1PackageDraftProposal(input)
    expect(mocks.decision).not.toHaveBeenCalled()
    mocks.revision.mockResolvedValueOnce(null)
    await expect(
      caller().decideIntakeV1PackageDraftProposal({
        ...input,
        operationId: '33333333-3333-4333-8333-333333333333',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    mocks.grant.mockRejectedValueOnce(new Error('private database detail'))
    await expect(
      caller().decideIntakeV1PackageDraftProposal({
        ...input,
        operationId: '44444444-4444-4444-8444-444444444444',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'V1 package draft approval could not be recorded.',
    })
  })
})
