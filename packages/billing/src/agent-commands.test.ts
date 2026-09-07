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

  function recoveryFixture(action = 'SET_GRACE_PERIOD') {
    const payload =
      action === 'SET_GRACE_PERIOD'
        ? {
            action,
            agreementId: 'agreement-1',
            expiresAt: '2026-12-01T00:00:00Z',
            reference: 'fixture',
            reason: 'Synthetic grace recovery',
          }
        : action === 'CREATE_NEGOTIATED_CHECKOUT'
          ? {
              action,
              planKey: 'torchiko_pilot_test',
              venueIds: ['venue-1'],
              amountMinor: '4300',
              currency: 'usd',
              interval: 'month',
              reference: 'fixture',
              reason: 'Synthetic checkout recovery',
            }
          : { action, reason: 'Synthetic cancellation recovery' }
    let row = {
      id: 'recover-command',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      action,
      operationId: '44a1e58c-670c-47d5-b02d-24c56b0e7747',
      status: 'PENDING_APPROVAL',
      failureCode: 'EXECUTION_CLAIM_V2',
      updatedAt: new Date(Date.now() - 600_000),
      payload,
      approvalRequest: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestedByType: 'AGENT',
        proposedAction: `billing.${action.toLowerCase()}`,
        scopeSnapshot: { tenantId: 'tenant-1', venueId: 'venue-1', payload },
        expiresAt: new Date(Date.now() + 60_000),
        decision: { decision: 'APPROVED', decidedByType: 'HUMAN' },
      },
    }
    let failCompletion = false
    let loseLeaseOnCompletion = false
    const model = {
      findFirst: vi.fn(async () => ({ ...row })),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.status !== row.status || where.updatedAt.getTime() !== row.updatedAt.getTime())
          return { count: 0 }
        if (data.status === 'COMPLETED' && failCompletion) {
          failCompletion = false
          throw new Error('completion database unavailable')
        }
        if (data.status === 'COMPLETED' && loseLeaseOnCompletion) {
          row = { ...row, updatedAt: new Date(row.updatedAt.getTime() + 1) }
          return { count: 0 }
        }
        row = { ...row, ...data }
        return { count: 1 }
      }),
    }
    const request = vi.fn()
    const checkoutAttempt = vi.fn()
    const client = {
      $transaction: (fn: (tx: unknown) => unknown) => fn({ billingAgentCommand: model }),
      billingAgentCommand: model,
      billingCustomerRequest: { findFirst: request },
      billingCheckoutAttempt: { findFirst: checkoutAttempt },
    }
    return {
      client,
      request,
      checkoutAttempt,
      row: () => row,
      setStatus: (status: string) => {
        row.status = status
      },
      failCompletion: () => {
        failCompletion = true
      },
      loseLeaseOnCompletion: () => {
        loseLeaseOnCompletion = true
      },
      invoke: () =>
        executeApprovedBillingAgentCommand({
          tenantId: 'tenant-1',
          commandId: row.id,
          actorId: 'admin-1',
          provider: {} as never,
          environment,
          client: client as never,
        }),
    }
  }

  it('retains a stable grace effect identity through completion-write failure and restart', async () => {
    const fixture = recoveryFixture()
    mocks.override.mockResolvedValue({ id: 'persisted-override' })
    fixture.failCompletion()
    await expect(fixture.invoke()).rejects.toThrow('completion database unavailable')
    expect(fixture.row()).toMatchObject({
      status: 'FAILED',
      failureCode: 'RECONCILIATION_REQUIRED_V2',
    })
    await fixture.invoke()
    expect(mocks.override.mock.calls.map(([args]) => args.idempotencyKey)).toEqual([
      'agent-command:recover-command',
      'agent-command:recover-command',
    ])
    expect(fixture.row().status).toBe('COMPLETED')
    await fixture.invoke()
    expect(mocks.override).toHaveBeenCalledTimes(2)
  })

  it('recovers an expired grace claim, but cannot reclaim a live claim', async () => {
    const fixture = recoveryFixture()
    fixture.setStatus('EXECUTING')
    mocks.override.mockResolvedValue({ id: 'persisted-override' })
    await fixture.invoke()
    expect(fixture.row().status).toBe('COMPLETED')
    fixture.setStatus('EXECUTING')
    await expect(fixture.invoke()).rejects.toThrow('already executing')
  })

  it('does not repeat an ambiguous provider cancellation, and reconciles its durable success', async () => {
    const fixture = recoveryFixture('CANCEL_AT_PERIOD_END')
    fixture.setStatus('FAILED')
    fixture.request.mockResolvedValue({
      id: 'request-1',
      status: 'PROCESSING',
      providerActionAt: null,
    })
    await expect(fixture.invoke()).rejects.toThrow('requires provider reconciliation')
    expect(mocks.cancellation).not.toHaveBeenCalled()
    fixture.request.mockResolvedValue({
      id: 'request-1',
      status: 'COMPLETED',
      providerActionAt: new Date(),
    })
    await fixture.invoke()
    expect(fixture.row().status).toBe('COMPLETED')
    expect(mocks.cancellation).not.toHaveBeenCalled()
  })

  it('admits only one effect when two callers read the same approved revision', async () => {
    const command = {
      id: 'command-race',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      operationId: '44a1e58c-670c-47d5-b02d-24c56b0e7747',
      action: 'SET_GRACE_PERIOD',
      status: 'PENDING_APPROVAL',
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      payload: {
        action: 'SET_GRACE_PERIOD',
        agreementId: 'agreement-1',
        expiresAt: '2026-10-01T00:00:00Z',
        reference: 'fixture',
        reason: 'Synthetic approved grace',
      },
      approvalRequest: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestedByType: 'AGENT',
        proposedAction: 'billing.set_grace_period',
        scopeSnapshot: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          payload: {
            action: 'SET_GRACE_PERIOD',
            agreementId: 'agreement-1',
            expiresAt: '2026-10-01T00:00:00Z',
            reference: 'fixture',
            reason: 'Synthetic approved grace',
          },
        },
        expiresAt: new Date(Date.now() + 60_000),
        decision: { decision: 'APPROVED', decidedByType: 'HUMAN' },
      },
    }
    let reads = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let claimed = false
    const model = {
      findFirst: vi.fn(async () => {
        if (++reads === 2) release()
        await barrier
        return { ...command }
      }),
      update: vi.fn(async ({ data }) => ({ ...command, ...data })),
      updateMany: vi.fn(async ({ data }) => {
        if (data.status !== 'EXECUTING') return { count: 1 }
        if (claimed) return { count: 0 }
        claimed = true
        return { count: 1 }
      }),
    }
    const client = {
      $transaction: (fn: (tx: unknown) => unknown) => fn({ billingAgentCommand: model }),
      billingAgentCommand: model,
    }
    mocks.override.mockResolvedValue({ id: 'one-effect' })
    const invoke = () =>
      executeApprovedBillingAgentCommand({
        tenantId: 'tenant-1',
        commandId: command.id,
        actorId: 'admin-1',
        provider: {} as never,
        environment,
        client: client as never,
      })
    const results = await Promise.allSettled([invoke(), invoke()])
    expect(mocks.override).toHaveBeenCalledTimes(1)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  })

  it('rejects a human approval whose action snapshot no longer matches the command', async () => {
    const fixture = recoveryFixture()
    fixture.row().approvalRequest.scopeSnapshot = {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      payload: { ...fixture.row().payload, reason: 'Changed after human approval' },
    }
    await expect(fixture.invoke()).rejects.toThrow('does not match the exact command')
    expect(mocks.override).not.toHaveBeenCalled()
  })

  it('does not treat a partial checkout child row as reconciled provider success', async () => {
    const fixture = recoveryFixture('CREATE_NEGOTIATED_CHECKOUT')
    fixture.setStatus('FAILED')
    fixture.checkoutAttempt.mockResolvedValue({
      id: 'attempt-1',
      status: 'PENDING',
      providerCreatedAt: null,
      stripeCheckoutSessionId: 'cs_unproved',
      stripeCheckoutUrl: 'https://checkout.example/unproved',
    })
    await expect(fixture.invoke()).rejects.toThrow('requires provider reconciliation')
    expect(mocks.checkout).not.toHaveBeenCalled()
  })

  it('does not let stale completion or its catch overwrite a newer lease revision', async () => {
    const fixture = recoveryFixture()
    mocks.override.mockResolvedValue({ id: 'effect-created-before-lease-loss' })
    fixture.loseLeaseOnCompletion()
    await expect(fixture.invoke()).rejects.toThrow('execution lease was lost')
    expect(fixture.row()).toMatchObject({
      status: 'EXECUTING',
      failureCode: 'EXECUTION_CLAIM_V2',
    })
  })

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
      action: 'CANCEL_AT_PERIOD_END',
      status: 'PENDING_APPROVAL',
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      payload: { action: 'CANCEL_AT_PERIOD_END', reason: 'The venue is closing.' },
      approvalRequest: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestedByType: 'AGENT',
        proposedAction: 'billing.cancel_at_period_end',
        scopeSnapshot: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          payload: { action: 'CANCEL_AT_PERIOD_END', reason: 'The venue is closing.' },
        },
        expiresAt: new Date(Date.now() + 60_000),
        decision: { decision: 'APPROVED', decidedByType: 'HUMAN' },
      },
    }
    const tx = {
      billingAgentCommand: {
        findFirst: vi.fn().mockResolvedValue(command),
        update: vi.fn().mockResolvedValue({ ...command, status: 'EXECUTING' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const client = {
      $transaction: (action: (value: typeof tx) => unknown) => action(tx),
      billingAgentCommand: {
        update: vi.fn().mockResolvedValue({ ...command, status: 'COMPLETED' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue({ ...command, status: 'COMPLETED' }),
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
    expect(client.billingAgentCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    )
  })
})
