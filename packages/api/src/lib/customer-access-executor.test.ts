import { describe, expect, it, vi } from 'vitest'

import { executeApprovedCustomerInvitation } from './customer-access-executor'

const revision = new Date('2026-08-25T14:00:00.000Z')
const startedRevision = new Date('2026-08-25T14:00:01.000Z')
const reconciledRevision = new Date('2026-08-25T14:00:02.000Z')
const input = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  requestId: 'access-1',
  expectedUpdatedAt: revision,
  actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' } as const,
}

function started() {
  return {
    state: 'CALL_PROVIDER' as const,
    inviterUserId: 'founder-1',
    request: {
      id: 'access-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      targetEmail: 'member@example.test',
      requestedRole: 'MEMBER' as const,
      status: 'PROVIDER_STARTED' as const,
      providerInvitationId: null,
      approvalRequestId: 'approval-1',
      updatedAt: startedRevision,
      approvalRequest: {
        proposedAction: 'torchiko.customer_access.invite_member',
        decision: {
          id: 'decision-1',
          decision: 'APPROVED' as const,
          decidedByType: 'HUMAN' as const,
          decidedById: 'founder-1',
        },
      },
    },
  }
}

function dependencies() {
  return {
    provider: { ensure: vi.fn(async () => ({ id: 'invite-1', replayed: false })) },
    actions: {
      start: vi.fn(async () => started()),
      confirm: vi.fn(async () => ({
        ...started().request,
        status: 'INVITED' as const,
        providerInvitationId: 'invite-1',
        replayed: false as const,
      })),
      markReconciliation: vi.fn(async () => ({
        ...started().request,
        status: 'RECONCILIATION_REQUIRED' as const,
        updatedAt: reconciledRevision,
        replayed: false as const,
      })),
    },
  }
}

describe('approved customer invitation executor', () => {
  it('fences, calls the exact provider scope, and confirms provider evidence', async () => {
    const deps = dependencies()
    await expect(executeApprovedCustomerInvitation(input, deps as never)).resolves.toEqual({
      requestId: 'access-1',
      status: 'INVITED',
      providerInvitationId: 'invite-1',
      replayed: false,
      membershipCreatedLocally: false,
    })
    expect(deps.provider.ensure).toHaveBeenCalledWith({
      organizationId: 'tenant-1',
      emailAddress: 'member@example.test',
      role: 'org:member',
      inviterUserId: 'founder-1',
    })
    expect(deps.actions.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'access-1',
        expectedUpdatedAt: startedRevision,
        providerInvitationId: 'invite-1',
        providerReplayed: false,
      }),
    )
  })

  it('records ambiguous provider failure before returning the sanitized provider error', async () => {
    const deps = dependencies()
    const providerError = new Error('synthetic provider failure')
    deps.provider.ensure.mockRejectedValueOnce(providerError)
    await expect(executeApprovedCustomerInvitation(input, deps as never)).rejects.toBe(
      providerError,
    )
    expect(deps.actions.markReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: startedRevision,
        failureClass: 'OUTCOME_AMBIGUOUS',
      }),
    )
    expect(deps.actions.confirm).not.toHaveBeenCalled()
  })

  it('reconciles an interrupted provider-start fence before idempotent provider lookup/create', async () => {
    const deps = dependencies()
    deps.actions.start
      .mockResolvedValueOnce({
        state: 'RECONCILIATION_REQUIRED',
        request: started().request,
      } as never)
      .mockResolvedValueOnce(started())
    deps.provider.ensure.mockResolvedValueOnce({ id: 'invite-existing', replayed: true })
    deps.actions.confirm.mockResolvedValueOnce({
      ...started().request,
      status: 'INVITED',
      providerInvitationId: 'invite-existing',
      replayed: false,
    } as never)

    await expect(executeApprovedCustomerInvitation(input, deps as never)).resolves.toMatchObject({
      providerInvitationId: 'invite-existing',
      replayed: true,
    })
    expect(deps.actions.markReconciliation).toHaveBeenCalledOnce()
    expect(deps.actions.start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedUpdatedAt: reconciledRevision }),
    )
  })

  it('returns already-confirmed evidence without contacting the provider', async () => {
    const deps = dependencies()
    deps.actions.start.mockResolvedValueOnce({
      state: 'INVITED',
      request: {
        ...started().request,
        status: 'INVITED',
        providerInvitationId: 'invite-existing',
      },
    } as never)
    await expect(executeApprovedCustomerInvitation(input, deps as never)).resolves.toMatchObject({
      providerInvitationId: 'invite-existing',
      replayed: true,
    })
    expect(deps.provider.ensure).not.toHaveBeenCalled()
    expect(deps.actions.confirm).not.toHaveBeenCalled()
  })
})
