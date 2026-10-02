import { describe, expect, it, vi } from 'vitest'

import {
  budgetPeriodBounds,
  evaluateRoutineStopRules,
  recordRoutineStop,
  reserveAgentRoutineBudget,
  routineBudgetOf,
} from './agent-routine-guards'

const now = new Date('2026-10-02T12:00:00.000Z')
const routine = {
  id: 'routine-1',
  tenantId: 'tenant_a',
  venueId: 'venue_a',
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  stopRules: {} as unknown,
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    tenant: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    billingAccount: { findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    offboardingPlan: { findFirst: vi.fn().mockResolvedValue(null) },
    supportRequest: { findFirst: vi.fn().mockResolvedValue({ status: 'WAITING_FOR_CLIENT' }) },
    supportMessage: { findFirst: vi.fn().mockResolvedValue(null) },
    prospectContact: { findUnique: vi.fn().mockResolvedValue({}) },
    prospectEmailMessage: { findFirst: vi.fn().mockResolvedValue(null) },
    agentRoutineDispatch: { count: vi.fn().mockResolvedValue(0) },
    ...overrides,
  } as never
}

const supportRules = { subject: { kind: 'SUPPORT_REQUEST', id: 'req_1' } }
const contactRules = { subject: { kind: 'PROSPECT_CONTACT', id: 'contact_1' } }

describe('evaluateRoutineStopRules', () => {
  it('keeps a healthy routine with no rules running', async () => {
    await expect(evaluateRoutineStopRules(client(), routine, now)).resolves.toBeNull()
  })

  it.each([
    [
      { tenant: { findUnique: vi.fn().mockResolvedValue({ status: 'SUSPENDED' }) } },
      'TENANT_SUSPENDED',
    ],
    [{ tenant: { findUnique: vi.fn().mockResolvedValue(null) } }, 'TENANT_SUSPENDED'],
    [
      { billingAccount: { findFirst: vi.fn().mockResolvedValue({ status: 'CANCELED' }) } },
      'CUSTOMER_CHURNED',
    ],
    [
      { billingAccount: { findFirst: vi.fn().mockResolvedValue({ status: 'ENDED' }) } },
      'CUSTOMER_CHURNED',
    ],
    [
      { offboardingPlan: { findFirst: vi.fn().mockResolvedValue({ id: 'plan' }) } },
      'VENUE_OFFBOARDED',
    ],
  ])('stops for customer-level reasons without any rules (%#)', async (overrides, reason) => {
    await expect(evaluateRoutineStopRules(client(overrides), routine, now)).resolves.toBe(reason)
  })

  it('looks for offboarding only in this tenant and venue and only in revoking-or-later states', async () => {
    const offboardingPlan = { findFirst: vi.fn().mockResolvedValue(null) }
    await evaluateRoutineStopRules(client({ offboardingPlan }), routine, now)
    expect(offboardingPlan.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant_a',
        status: { in: ['REVOKING', 'EXPORT_READY', 'COMPLETED'] },
        venueTargets: { some: { tenantId: 'tenant_a', venueId: 'venue_a' } },
      },
      select: { id: true },
    })
  })

  it('stops at the end date and not before it', async () => {
    const rules = { ...routine, stopRules: { endsAt: '2026-10-02T12:00:00.000Z' } }
    await expect(evaluateRoutineStopRules(client(), rules, now)).resolves.toBe('END_DATE_REACHED')
    await expect(
      evaluateRoutineStopRules(client(), rules, new Date(now.getTime() - 1)),
    ).resolves.toBeNull()
  })

  it('stops once the reminder count is reached', async () => {
    const rules = { ...routine, stopRules: { maxReminders: 3 } }
    const at = (count: number) =>
      client({ agentRoutineDispatch: { count: vi.fn().mockResolvedValue(count) } })
    await expect(evaluateRoutineStopRules(at(2), rules, now)).resolves.toBeNull()
    await expect(evaluateRoutineStopRules(at(3), rules, now)).resolves.toBe('MAX_REMINDERS_REACHED')
  })

  it.each([
    ['COMPLETED', 'REQUEST_RESOLVED'],
    ['CANCELLED', 'REQUEST_CANCELLED'],
  ])('stops when the support request is %s', async (status, reason) => {
    const supportRequest = { findFirst: vi.fn().mockResolvedValue({ status }) }
    await expect(
      evaluateRoutineStopRules(
        client({ supportRequest }),
        { ...routine, stopRules: supportRules },
        now,
      ),
    ).resolves.toBe(reason)
    // The request is looked up inside the routine's own tenant and venue.
    expect(supportRequest.findFirst).toHaveBeenCalledWith({
      where: { id: 'req_1', tenantId: 'tenant_a', venueId: 'venue_a' },
      select: { status: true },
    })
  })

  it('stops when the client replied after the routine was created, and not for older messages', async () => {
    const supportMessage = { findFirst: vi.fn().mockResolvedValue({ id: 'm1' }) }
    await expect(
      evaluateRoutineStopRules(
        client({ supportMessage }),
        { ...routine, stopRules: supportRules },
        now,
      ),
    ).resolves.toBe('TARGET_REPLIED')
    expect(supportMessage.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant_a',
        venueId: 'venue_a',
        supportRequestId: 'req_1',
        authorKind: 'CLIENT',
        createdAt: { gt: routine.createdAt },
      },
      select: { id: true },
    })
    await expect(
      evaluateRoutineStopRules(client(), { ...routine, stopRules: supportRules }, now),
    ).resolves.toBeNull()
  })

  it('stops when the subject no longer exists in scope', async () => {
    const supportRequest = { findFirst: vi.fn().mockResolvedValue(null) }
    await expect(
      evaluateRoutineStopRules(
        client({ supportRequest }),
        { ...routine, stopRules: supportRules },
        now,
      ),
    ).resolves.toBe('SUBJECT_MISSING')
  })

  it('stops an unscoped prospect subject without reading global CRM state', async () => {
    const prospectContact = { findUnique: vi.fn() }
    const prospectEmailMessage = { findFirst: vi.fn() }
    await expect(
      evaluateRoutineStopRules(
        client({ prospectContact, prospectEmailMessage }),
        { ...routine, stopRules: contactRules },
        now,
      ),
    ).resolves.toBe('SUBJECT_MISSING')
    expect(prospectContact.findUnique).not.toHaveBeenCalled()
    expect(prospectEmailMessage.findFirst).not.toHaveBeenCalled()
  })

  it('fails closed when the stored rules cannot be read', async () => {
    await expect(
      evaluateRoutineStopRules(client(), { ...routine, stopRules: { maxReminders: 'many' } }, now),
    ).resolves.toBe('INVALID_STOP_RULES')
  })
})

describe('recordRoutineStop', () => {
  it('disables the routine, clears its schedule and only reports a recording once', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
    const agentRoutine = { updateMany } as never
    const target = { id: 'routine-1', tenantId: 'tenant_a', venueId: 'venue_a' }
    await expect(
      recordRoutineStop({ agentRoutine }, target, 'TARGET_REPLIED', now),
    ).resolves.toEqual({ recorded: true })
    await expect(
      recordRoutineStop({ agentRoutine }, target, 'TARGET_REPLIED', now),
    ).resolves.toEqual({ recorded: false })
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'routine-1', tenantId: 'tenant_a', venueId: 'venue_a', stoppedAt: null },
      data: {
        enabled: false,
        nextRunAt: null,
        stoppedAt: now,
        stopReason: 'TARGET_REPLIED',
        lastSkipReason: 'TARGET_REPLIED',
      },
    })
  })
})

describe('budget periods', () => {
  it('uses UTC day, Monday-start week and calendar month bounds', () => {
    const wednesday = new Date('2026-10-07T23:59:59.000Z')
    expect(budgetPeriodBounds('DAY', wednesday)).toEqual({
      start: new Date('2026-10-07T00:00:00.000Z'),
      end: new Date('2026-10-08T00:00:00.000Z'),
    })
    expect(budgetPeriodBounds('WEEK', wednesday)).toEqual({
      start: new Date('2026-10-05T00:00:00.000Z'),
      end: new Date('2026-10-12T00:00:00.000Z'),
    })
    expect(budgetPeriodBounds('WEEK', new Date('2026-10-04T10:00:00.000Z'))).toEqual({
      start: new Date('2026-09-28T00:00:00.000Z'),
      end: new Date('2026-10-05T00:00:00.000Z'),
    })
    expect(budgetPeriodBounds('MONTH', new Date('2026-12-31T23:00:00.000Z'))).toEqual({
      start: new Date('2026-12-01T00:00:00.000Z'),
      end: new Date('2027-01-01T00:00:00.000Z'),
    })
  })
})

describe('routineBudgetOf', () => {
  it('is null unless every budget column is set', () => {
    const none = {
      budgetCents: null,
      budgetCurrency: null,
      budgetPeriod: null,
      estimatedRunCostCents: null,
    }
    expect(routineBudgetOf(none)).toBeNull()
    expect(routineBudgetOf({ ...none, budgetCents: 100 })).toBeNull()
    expect(
      routineBudgetOf({
        budgetCents: 100,
        budgetCurrency: 'USD',
        budgetPeriod: 'DAY',
        estimatedRunCostCents: 25,
      }),
    ).toEqual({
      budgetCents: 100,
      budgetCurrency: 'USD',
      budgetPeriod: 'DAY',
      estimatedRunCostCents: 25,
    })
  })
})

describe('reserveAgentRoutineBudget', () => {
  const target = {
    id: 'routine-1',
    tenantId: 'tenant_a',
    venueId: 'venue_a',
    budgetCents: 100,
    budgetCurrency: 'USD',
    budgetPeriod: 'DAY' as const,
    estimatedRunCostCents: 40,
  }

  it('reserves with one conditional update and reports what remains', async () => {
    const agentRoutineBudgetUsage = {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue({ spentCents: 40, currency: 'USD' }),
    }
    await expect(
      reserveAgentRoutineBudget({ agentRoutineBudgetUsage } as never, target, now),
    ).resolves.toEqual({ ok: true, reservedCents: 40, remainingCents: 60 })
    expect(agentRoutineBudgetUsage.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    )
    // The last updateMany is the reservation: it only matches while spend leaves room for the estimate.
    expect(agentRoutineBudgetUsage.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        tenantId: 'tenant_a',
        routineId: 'routine-1',
        spentCents: { lte: 60 },
        currency: 'USD',
      }),
      data: { spentCents: { increment: 40 }, runCount: { increment: 1 } },
    })
  })

  it('refuses when the update matches nothing, and writes nothing else', async () => {
    const agentRoutineBudgetUsage = {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue({ spentCents: 80, currency: 'USD' }),
    }
    await expect(
      reserveAgentRoutineBudget({ agentRoutineBudgetUsage } as never, target, now),
    ).resolves.toEqual({ ok: false, reason: 'BUDGET_EXCEEDED', remainingCents: 20 })
  })

  it('refuses to reinterpret this period’s spend after a currency change', async () => {
    const agentRoutineBudgetUsage = {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue({ spentCents: 40, currency: 'EUR' }),
    }
    await expect(
      reserveAgentRoutineBudget({ agentRoutineBudgetUsage } as never, target, now),
    ).resolves.toEqual({ ok: false, reason: 'BUDGET_EXCEEDED', remainingCents: 0 })
    expect(agentRoutineBudgetUsage.updateMany).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({ currency: 'USD' }),
      data: { budgetCents: 100 },
    })
  })
})
