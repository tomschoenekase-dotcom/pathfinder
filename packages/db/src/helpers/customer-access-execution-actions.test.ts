import { describe, expect, it, vi } from 'vitest'

import {
  confirmCustomerInvitationAction,
  CustomerAccessExecutionError,
  markCustomerInvitationReconciliationAction,
  startApprovedCustomerInvitationAction,
} from './customer-access-execution-actions'

const revision = new Date('2026-08-25T14:00:00.000Z')
const nextRevision = new Date('2026-08-25T14:00:01.000Z')
const actor = { type: 'HUMAN', id: 'founder-1', role: 'PLATFORM_ADMIN' } as const

function request(status = 'APPROVED', overrides: Record<string, unknown> = {}) {
  return {
    id: 'access-1',
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    targetEmail: 'member@example.test',
    requestedRole: 'MEMBER',
    status,
    providerInvitationId: null,
    approvalRequestId: 'approval-1',
    updatedAt: revision,
    approvalRequest: {
      proposedAction: 'torchiko.customer_access.invite_member',
      decision: {
        id: 'decision-1',
        decision: 'APPROVED',
        decidedByType: 'HUMAN',
        decidedById: 'founder-1',
      },
    },
    ...overrides,
  }
}

function fixture(
  existing = request(),
  updated = request('PROVIDER_STARTED', { updatedAt: nextRevision }),
) {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    customerAccessRequest: {
      findFirst: vi.fn(async () => existing),
      findUniqueOrThrow: vi.fn(async () => updated),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    operationalEvent: {
      upsert: vi.fn(async () => ({ id: 'event-1', state: 'OPEN', occurrenceCount: 1 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  }
  return { tx, client: { $transaction: vi.fn(async (callback) => callback(tx)) } }
}

const scope = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  requestId: 'access-1',
  expectedUpdatedAt: revision,
  actor,
}

describe('customer access provider execution actions', () => {
  it('commits the provider-start fence only after exact human approval and CAS', async () => {
    const { tx, client } = fixture()
    await expect(
      startApprovedCustomerInvitationAction(scope, client as never),
    ).resolves.toMatchObject({
      state: 'CALL_PROVIDER',
      inviterUserId: 'founder-1',
      request: { status: 'PROVIDER_STARTED', updatedAt: nextRevision },
    })
    expect(tx.customerAccessRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'access-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        status: 'APPROVED',
        updatedAt: revision,
      },
      data: { status: 'PROVIDER_STARTED' },
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'customer-access.provider-started',
        afterState: { status: 'PROVIDER_STARTED', externalEffectConfirmed: false },
      }),
    })
  })

  it('refuses missing, rejected, or nonhuman approval evidence without a write', async () => {
    const { tx, client } = fixture(
      request('APPROVED', {
        approvalRequest: {
          proposedAction: 'torchiko.customer_access.invite_member',
          decision: {
            id: 'decision-1',
            decision: 'APPROVED',
            decidedByType: 'AGENT',
            decidedById: 'agent-1',
          },
        },
      }),
    )
    await expect(
      startApprovedCustomerInvitationAction(scope, client as never),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    } satisfies Partial<CustomerAccessExecutionError>)
    expect(tx.customerAccessRequest.updateMany).not.toHaveBeenCalled()
  })

  it('does not automatically redispatch an unresolved provider-started request', async () => {
    const { tx, client } = fixture(request('PROVIDER_STARTED'))
    await expect(
      startApprovedCustomerInvitationAction(scope, client as never),
    ).resolves.toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
    })
    expect(tx.customerAccessRequest.updateMany).not.toHaveBeenCalled()
  })

  it('confirms exact provider evidence without creating local membership', async () => {
    const confirmed = request('INVITED', {
      providerInvitationId: 'invite-1',
      updatedAt: nextRevision,
    })
    const { tx, client } = fixture(request('PROVIDER_STARTED'), confirmed)
    await expect(
      confirmCustomerInvitationAction(
        { ...scope, providerInvitationId: 'invite-1', providerReplayed: false },
        client as never,
      ),
    ).resolves.toMatchObject({
      status: 'INVITED',
      providerInvitationId: 'invite-1',
      replayed: false,
    })
    expect(tx.customerAccessRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'INVITED', providerInvitationId: 'invite-1' } }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'customer-access.invitation-confirmed',
        afterState: expect.objectContaining({ membershipCreatedLocally: false }),
      }),
    })
    expect(tx.operationalEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'RESOLVED' }) }),
    )
  })

  it('maps provider evidence uniqueness races to a domain conflict', async () => {
    const { tx, client } = fixture(request('PROVIDER_STARTED'))
    tx.customerAccessRequest.updateMany.mockRejectedValueOnce({ code: 'P2002' })
    await expect(
      confirmCustomerInvitationAction(
        { ...scope, providerInvitationId: 'invite-claimed', providerReplayed: true },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<CustomerAccessExecutionError>)
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('retains ambiguous dispatch as explicit reconciliation state', async () => {
    const reconciled = request('RECONCILIATION_REQUIRED', { updatedAt: nextRevision })
    const { tx, client } = fixture(request('PROVIDER_STARTED'), reconciled)
    await expect(
      markCustomerInvitationReconciliationAction(
        { ...scope, failureClass: 'OUTCOME_AMBIGUOUS' },
        client as never,
      ),
    ).resolves.toMatchObject({ status: 'RECONCILIATION_REQUIRED', replayed: false })
    expect(tx.customerAccessRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'RECONCILIATION_REQUIRED' } }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'customer-access.reconciliation-required' }),
    })
    expect(tx.operationalEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          eventType: 'customer-access.reconciliation-required',
          actionRequired: true,
        }),
      }),
    )
  })
})
