import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  event: vi.fn(),
  checkout: vi.fn(),
  override: vi.fn(),
  cancellation: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {},
  writeAuditLogStrict: mocks.audit,
  publishOperationalEvent: mocks.event,
}))

vi.mock('./service', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('./service')>()
  return {
    ...original,
    createTenantCheckout: mocks.checkout,
    createBillingAccessOverride: mocks.override,
  }
})

vi.mock('./customer-requests', () => ({ requestTenantCancellation: mocks.cancellation }))

import { executeApprovedBillingAgentCommand, proposeBillingAgentCommand } from './agent-commands'

const environment = {
  STRIPE_MODE: 'test',
  STRIPE_CANCELLATION_ENABLED: true,
} as never

describe('approval-gated agent billing commands', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates only a human approval proposal and never executes provider work', async () => {
    const approval = { id: 'approval-1' }
    const command = {
      id: 'command-1',
      action: 'CREATE_NEGOTIATED_CHECKOUT',
      approvalRequest: approval,
    }
    const tx = {
      billingAgentCommand: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(command),
      },
      venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-1' }) },
      agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent-1' }) },
      agentRun: { findFirst: vi.fn() },
      billingAccount: { findUnique: vi.fn().mockResolvedValue(null) },
      approvalRequest: { create: vi.fn().mockResolvedValue(approval) },
    }
    const client = { $transaction: (action: (value: typeof tx) => unknown) => action(tx) }

    const result = await proposeBillingAgentCommand({
      operationId: '44a1e58c-670c-47d5-b02d-24c56b0e7747',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      payload: {
        action: 'CREATE_NEGOTIATED_CHECKOUT',
        planKey: 'torchiko_pilot_test',
        venueIds: ['venue-1'],
        amountMinor: '4300',
        currency: 'usd',
        interval: 'month',
        reference: 'EMAIL-43',
        reason: 'Tom approved the negotiated monthly price.',
      },
      client: client as never,
    })

    expect(result).toMatchObject({ replayed: false, command: { id: 'command-1' } })
    expect(tx.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestedByType: 'AGENT',
          riskCategory: 'CRITICAL',
        }),
      }),
    )
    expect(mocks.checkout).not.toHaveBeenCalled()
    expect(mocks.override).not.toHaveBeenCalled()
    expect(mocks.cancellation).not.toHaveBeenCalled()
    expect(mocks.event).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ actionRequired: true, linkedObjectId: 'command-1' }),
      }),
    )
  })

  it('rejects a proposal that exceeds the exact verified venue scope', async () => {
    const tx = {
      billingAgentCommand: { findFirst: vi.fn().mockResolvedValue(null) },
      venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-1' }) },
      agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'agent-1' }) },
      billingAccount: { findUnique: vi.fn().mockResolvedValue(null) },
      approvalRequest: { create: vi.fn() },
    }
    const client = { $transaction: (action: (value: typeof tx) => unknown) => action(tx) }

    await expect(
      proposeBillingAgentCommand({
        operationId: '44a1e58c-670c-47d5-b02d-24c56b0e7747',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentIdentityId: 'agent-1',
        payload: {
          action: 'CREATE_NEGOTIATED_CHECKOUT',
          planKey: 'torchiko_pilot_test',
          venueIds: ['venue-other'],
          amountMinor: '4300',
          currency: 'usd',
          interval: 'month',
          reference: 'EMAIL-43',
          reason: 'Tom approved the negotiated monthly price.',
        },
        client: client as never,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(tx.approvalRequest.create).not.toHaveBeenCalled()
  })

  it('requires a current HUMAN approval before reserving execution', async () => {
    const tx = {
      billingAgentCommand: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'command-1',
          status: 'PENDING_APPROVAL',
          approvalRequest: {
            expiresAt: new Date(Date.now() + 60_000),
            decision: { decision: 'APPROVED', decidedByType: 'AGENT' },
          },
        }),
        update: vi.fn(),
      },
    }
    const client = { $transaction: (action: (value: typeof tx) => unknown) => action(tx) }
    await expect(
      executeApprovedBillingAgentCommand({
        tenantId: 'tenant-1',
        commandId: 'command-1',
        actorId: 'admin-1',
        provider: {} as never,
        environment,
        client: client as never,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(tx.billingAgentCommand.update).not.toHaveBeenCalled()
  })

  it('uses the immutable UUID operation id when executing an approved cancellation', async () => {
    const operationId = '44a1e58c-670c-47d5-b02d-24c56b0e7747'
    const command = {
      id: 'command-cuid',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      operationId,
      status: 'PENDING_APPROVAL',
      payload: { action: 'CANCEL_AT_PERIOD_END', reason: 'The venue is closing.' },
      approvalRequest: {
        expiresAt: new Date(Date.now() + 60_000),
        decision: { decision: 'APPROVED', decidedByType: 'HUMAN' },
      },
    }
    const tx = {
      billingAgentCommand: {
        findFirst: vi.fn().mockResolvedValue(command),
        update: vi.fn().mockResolvedValue({ ...command, status: 'EXECUTING' }),
      },
    }
    const client = {
      $transaction: (action: (value: typeof tx) => unknown) => action(tx),
      billingAgentCommand: {
        update: vi.fn().mockResolvedValue({ ...command, status: 'COMPLETED' }),
      },
    }
    mocks.cancellation.mockResolvedValue({ awaitingWebhook: true })

    await executeApprovedBillingAgentCommand({
      tenantId: 'tenant-1',
      commandId: 'command-cuid',
      actorId: 'admin-1',
      provider: {} as never,
      environment,
      client: client as never,
    })

    expect(mocks.cancellation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId, actorRole: 'PLATFORM_ADMIN' }),
    )
    expect(client.billingAgentCommand.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    )
  })
})
