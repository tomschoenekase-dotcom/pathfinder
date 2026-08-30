import { describe, expect, it, vi } from 'vitest'

import {
  CustomerAccessRequestActionError,
  prepareCustomerAccessRequestAction,
} from './customer-access-request-actions'

const operationId = '11111111-1111-4111-8111-111111111111'
const actor = {
  type: 'AGENT' as const,
  actorId: 'agent-1',
  role: 'AGENT' as const,
  agentIdentityId: 'agent-1',
  agentRunId: 'run-1',
  workerId: 'worker-1',
  credentialId: 'credential-1',
  capability: 'customer-access:prepare',
  modelProvider: 'openai',
  modelName: 'gpt-test',
  idempotencyKey: operationId,
}

function input() {
  return {
    operationId,
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    supportRequestId: 'support-1',
    sourceSupportMessageId: 'message-1',
    emailAddress: ' New.Member@Example.com ',
    requestedRole: 'MEMBER' as const,
    reason: 'The organization owner asked to add this teammate.',
    actor,
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'access-1',
    operationId,
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    agentIdentityId: 'agent-1',
    agentRunId: 'run-1',
    supportRequestId: 'support-1',
    sourceSupportMessageId: 'message-1',
    approvalRequestId: 'approval-1',
    targetEmail: 'new.member@example.com',
    requestedRole: 'MEMBER',
    reason: 'The organization owner asked to add this teammate.',
    status: 'AWAITING_APPROVAL',
    providerInvitationId: null,
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

function harness() {
  const tx = {
    customerAccessRequest: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(request()),
    },
    agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent-1' }) },
    agentRun: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'run-1', requestedOperation: 'customer-access.invite' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    supportMessage: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'message-1',
        authorId: 'owner-1',
        body: 'Please invite new.member@example.com as a team member.',
        supportRequest: { id: 'support-1', version: 3, subject: 'Add a teammate' },
      }),
    },
    tenantMembership: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({ id: 'membership-1', userId: 'owner-1' })
        .mockResolvedValueOnce(null),
    },
    approvalRequest: { create: vi.fn().mockResolvedValue({ id: 'approval-1' }) },
    agentAction: { create: vi.fn().mockResolvedValue({ id: 'action-1' }) },
    agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'timeline-1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  }
  const transaction = vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx))
  return { tx, client: { $transaction: transaction }, transaction }
}

describe('prepareCustomerAccessRequestAction', () => {
  it('creates review, run, action, timeline, and audit evidence without an external effect', async () => {
    const h = harness()

    const result = await prepareCustomerAccessRequestAction(input(), h.client as never)

    expect(result).toEqual({ request: request(), replayed: false })
    expect(h.tx.supportMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'message-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          supportRequestId: 'support-1',
          authorKind: 'CLIENT',
          visibility: 'CLIENT_VISIBLE',
        }),
      }),
    )
    expect(h.tx.tenantMembership.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { tenantId: 'tenant-1', userId: 'owner-1', role: 'OWNER', status: 'ACTIVE' },
      }),
    )
    expect(h.tx.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          proposedAction: 'torchiko.customer_access.invite_member',
          riskCategory: 'HIGH',
          scopeSnapshot: expect.objectContaining({
            targetEmail: 'new.member@example.com',
            requestedRole: 'MEMBER',
            authorizedRequesterUserId: 'owner-1',
            externalEffectsExecuted: false,
          }),
        }),
      }),
    )
    expect(h.tx.customerAccessRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetEmail: 'new.member@example.com' }),
      }),
    )
    expect(h.tx.agentRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', tenantId: 'tenant-1', venueId: 'venue-1', status: 'RUNNING' },
      data: { status: 'AWAITING_APPROVAL' },
    })
    expect(h.tx.agentAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          modelProvider: 'openai',
          modelName: 'gpt-test',
          inputReference: 'SupportMessage:message-1',
          beforeVersionRef: 'SupportRequest:support-1:v3',
          afterVersionRef: 'CustomerAccessRequest:access-1:AWAITING_APPROVAL',
          output: expect.objectContaining({ externalEffectsExecuted: false }),
        }),
      }),
    )
    expect(h.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'customer-access.invitation-prepared',
          capability: 'customer-access:prepare',
          idempotencyKey: operationId,
          afterState: expect.objectContaining({ invitationSent: false, membershipChanged: false }),
        }),
      }),
    )
    expect(h.tx).not.toHaveProperty('clerk')
  })

  it('replays the exact operation without creating duplicate approval or action evidence', async () => {
    const h = harness()
    h.tx.customerAccessRequest.findUnique.mockResolvedValueOnce(request())

    await expect(prepareCustomerAccessRequestAction(input(), h.client as never)).resolves.toEqual({
      request: request(),
      replayed: true,
    })
    expect(h.tx.approvalRequest.create).not.toHaveBeenCalled()
    expect(h.tx.agentAction.create).not.toHaveBeenCalled()
  })

  it('rejects reuse of an operation ID for a different target', async () => {
    const h = harness()
    h.tx.customerAccessRequest.findUnique.mockResolvedValueOnce(
      request({ targetEmail: 'different@example.com' }),
    )

    await expect(
      prepareCustomerAccessRequestAction(input(), h.client as never),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    } satisfies Partial<CustomerAccessRequestActionError>)
    expect(h.tx.approvalRequest.create).not.toHaveBeenCalled()
  })

  it('fails closed when the evidence author is not an active organization owner', async () => {
    const h = harness()
    h.tx.tenantMembership.findFirst.mockReset().mockResolvedValue(null)

    await expect(
      prepareCustomerAccessRequestAction(input(), h.client as never),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    } satisfies Partial<CustomerAccessRequestActionError>)
    expect(h.tx.approvalRequest.create).not.toHaveBeenCalled()
  })

  it('rejects a target email not present in the exact owner-authored message', async () => {
    const h = harness()
    h.tx.supportMessage.findFirst.mockResolvedValueOnce({
      id: 'message-1',
      authorId: 'owner-1',
      body: 'Please help me with our venue hours.',
      supportRequest: { id: 'support-1', version: 3, subject: 'General support' },
    })

    await expect(
      prepareCustomerAccessRequestAction(input(), h.client as never),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    } satisfies Partial<CustomerAccessRequestActionError>)
    expect(h.tx.approvalRequest.create).not.toHaveBeenCalled()
  })

  it('rejects an existing member and an already-active request', async () => {
    const existingMember = harness()
    existingMember.tx.tenantMembership.findFirst
      .mockReset()
      .mockResolvedValueOnce({ id: 'membership-1', userId: 'owner-1' })
      .mockResolvedValueOnce({ id: 'membership-2' })
    await expect(
      prepareCustomerAccessRequestAction(input(), existingMember.client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const duplicate = harness()
    duplicate.tx.customerAccessRequest.findFirst.mockResolvedValueOnce({ id: 'access-existing' })
    await expect(
      prepareCustomerAccessRequestAction(input(), duplicate.client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('requires the exact machine capability before opening a transaction', async () => {
    const h = harness()
    await expect(
      prepareCustomerAccessRequestAction(
        { ...input(), actor: { ...actor, capability: 'support:draft' } },
        h.client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(h.transaction).not.toHaveBeenCalled()
  })
})
