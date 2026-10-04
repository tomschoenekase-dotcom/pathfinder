import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  db,
  dispatchDueAgentRoutineAction,
  reserveAgentRoutineBudget,
  setAgentRoutineEnabledAction,
  withTenantIsolationBypass,
} from '../index'

/**
 * Reminder stop rules and dollar budgets against a real PostgreSQL. Not part of the default test
 * command: it needs RUN_AGENT_ROUTINE_GUARDS_DB_INTEGRATION=1 and a database named
 * pathfinder_disposable_*. All names are invented.
 */
const enabled =
  process.env.RUN_AGENT_ROUTINE_GUARDS_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

vi.setConfig({ testTimeout: 120_000 })

const MINUTE = 60_000
const base = new Date('2026-10-02T12:00:00.000Z')

type Fixture = Awaited<ReturnType<typeof fixture>>

async function fixture(label: string) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
  const tenantId = `rg-${label}-tenant-${suffix}`
  const venueId = `rg-${label}-venue-${suffix}`
  const identityId = `rg-${label}-agent-${suffix}`
  await db.tenant.create({ data: { id: tenantId, name: 'Example Museum Group', slug: tenantId } })
  await db.venue.create({ data: { id: venueId, tenantId, name: 'Example Museum', slug: venueId } })
  await db.agentIdentity.create({
    data: {
      id: identityId,
      tenantId,
      venueId,
      identityKey: `rg.${suffix}`,
      name: 'Example Reminder Agent',
      agentType: 'OPERATIONS',
      accessScope: 'VENUE',
      accessCapabilities: ['operations.read'],
      autonomyLevel: 'READ_ONLY',
      defaultProvider: 'codex-bridge',
      defaultModel: 'subscription-default',
      enabled: true,
      createdBy: 'integration',
    },
  })
  return { tenantId, venueId, identityId, suffix }
}

async function routineFor(
  fx: Fixture,
  data: Record<string, unknown> = {},
  createdAt = new Date(base.getTime() - 60 * MINUTE),
) {
  return db.agentRoutine.create({
    data: {
      tenantId: fx.tenantId,
      venueId: fx.venueId,
      routineKey: `follow-up-${randomUUID().slice(0, 8)}`,
      agentIdentityId: fx.identityId,
      requestedOperation: 'routine_monitor',
      prompt: 'Remind the client about the open request.',
      intervalSeconds: 3600,
      enabled: true,
      nextRunAt: new Date(base.getTime() - MINUTE),
      createdBy: 'integration',
      createdAt,
      ...data,
    },
  })
}

const dispatch = (routineId: string, now: Date) =>
  withTenantIsolationBypass(() => dispatchDueAgentRoutineAction({ routineId, now }))

const reload = (routineId: string) =>
  withTenantIsolationBypass(() => db.agentRoutine.findUniqueOrThrow({ where: { id: routineId } }))

const effects = (routineId: string) =>
  withTenantIsolationBypass(async () => ({
    runs: await db.agentRun.count({ where: { initiatedById: `agent-routine:${routineId}` } }),
    dispatches: await db.agentRoutineDispatch.count({ where: { routineId } }),
  }))

async function auditCount(fx: Fixture, routineId: string, action: string) {
  return withTenantIsolationBypass(() =>
    db.auditLog.count({ where: { tenantId: fx.tenantId, targetId: routineId, action } }),
  )
}

/** Finishes the run so the serial fence lets the next slot start, and makes the routine due again. */
async function finishAndMakeDue(routineId: string, due: Date) {
  await withTenantIsolationBypass(async () => {
    await db.agentRun.updateMany({
      where: { initiatedById: `agent-routine:${routineId}`, status: 'QUEUED' },
      data: { status: 'CANCELLED', startedAt: base, completedAt: base },
    })
    await db.agentRoutine.update({ where: { id: routineId }, data: { nextRunAt: due } })
  })
}

async function supportRequest(fx: Fixture, status: 'OPEN' | 'COMPLETED' | 'CANCELLED' = 'OPEN') {
  return db.supportRequest.create({
    data: {
      tenantId: fx.tenantId,
      venueId: fx.venueId,
      category: 'GENERAL',
      status,
      subject: 'Example request',
      createdByKind: 'OPERATOR',
      createdById: 'operator-user',
      updatedByKind: 'OPERATOR',
      updatedById: 'operator-user',
    },
  })
}

async function prospectContact(data: Record<string, unknown> = {}) {
  const suffix = randomUUID().replaceAll('-', '')
  const organization = await db.prospectOrganization.create({
    data: {
      canonicalName: `Example Org ${suffix}`,
      normalizedName: `example org ${suffix}`,
      createdBy: 'integration',
      updatedBy: 'integration',
    },
  })
  const contact = await db.prospectContact.create({
    data: {
      organizationId: organization.id,
      createdBy: 'integration',
      updatedBy: 'integration',
      ...data,
    },
  })
  return { organization, contact }
}

describe.skipIf(!enabled)('routine reminder stop rules (disposable PostgreSQL)', () => {
  afterAll(async () => db.$disconnect())

  it('keeps a routine with satisfied-looking-but-unmet rules running and dispatches once', async () => {
    const fx = await fixture('live')
    const request = await supportRequest(fx)
    const routine = await routineFor(fx, {
      stopRules: { subject: { kind: 'SUPPORT_REQUEST', id: request.id }, maxReminders: 3 },
    })
    await expect(dispatch(routine.id, base)).resolves.toMatchObject({ status: 'DISPATCHED' })
    expect(await effects(routine.id)).toEqual({ runs: 1, dispatches: 1 })
  })

  const stopCases: Array<{
    name: string
    reason: string
    arrange: (fx: Fixture) => Promise<Record<string, unknown>>
  }> = [
    {
      name: 'the client replied after the routine was created',
      reason: 'TARGET_REPLIED',
      arrange: async (fx) => {
        const request = await supportRequest(fx)
        await db.supportMessage.create({
          data: {
            tenantId: fx.tenantId,
            venueId: fx.venueId,
            supportRequestId: request.id,
            authorKind: 'CLIENT',
            authorId: 'client-user',
            body: 'Thanks, here is the answer.',
            clientVersion: 1,
          },
        })
        return { stopRules: { subject: { kind: 'SUPPORT_REQUEST', id: request.id } } }
      },
    },
    {
      name: 'the support request was resolved',
      reason: 'REQUEST_RESOLVED',
      arrange: async (fx) => ({
        stopRules: {
          subject: { kind: 'SUPPORT_REQUEST', id: (await supportRequest(fx, 'COMPLETED')).id },
        },
      }),
    },
    {
      name: 'the support request was cancelled',
      reason: 'REQUEST_CANCELLED',
      arrange: async (fx) => ({
        stopRules: {
          subject: { kind: 'SUPPORT_REQUEST', id: (await supportRequest(fx, 'CANCELLED')).id },
        },
      }),
    },
    {
      name: 'the support request is not in this tenant',
      reason: 'SUBJECT_MISSING',
      arrange: async () => ({
        stopRules: { subject: { kind: 'SUPPORT_REQUEST', id: 'request-that-does-not-exist' } },
      }),
    },
    {
      name: 'a platform prospect was bound without proven tenant scope',
      reason: 'SUBJECT_MISSING',
      arrange: async () => {
        const { contact } = await prospectContact({ suppressedAt: new Date(), doNotContact: true })
        return { stopRules: { subject: { kind: 'PROSPECT_CONTACT', id: contact.id } } }
      },
    },
    {
      name: 'the venue is being offboarded',
      reason: 'VENUE_OFFBOARDED',
      arrange: async (fx) => {
        const plan = await db.offboardingPlan.create({
          data: {
            tenantId: fx.tenantId,
            requestId: randomUUID(),
            requestHash: 'a'.repeat(64),
            status: 'REVOKING',
            revocationTargets: ['GUEST_LINKS'],
            requestedBy: 'integration',
          },
        })
        await db.offboardingVenueTarget.create({
          data: { tenantId: fx.tenantId, venueId: fx.venueId, planId: plan.id },
        })
        return {}
      },
    },
    {
      name: 'the customer is suspended',
      reason: 'TENANT_SUSPENDED',
      arrange: async (fx) => {
        await db.tenant.update({ where: { id: fx.tenantId }, data: { status: 'SUSPENDED' } })
        return {}
      },
    },
    {
      name: 'the customer churned',
      reason: 'CUSTOMER_CHURNED',
      arrange: async (fx) => {
        await db.billingAccount.create({
          data: {
            tenantId: fx.tenantId,
            displayNameSnapshot: 'Example Museum Group',
            billingMode: 'PILOT',
            status: 'CANCELED',
            createdBy: 'integration',
            updatedBy: 'integration',
          },
        })
        return {}
      },
    },
    {
      name: 'the end date passed',
      reason: 'END_DATE_REACHED',
      arrange: async () => ({
        stopRules: { endsAt: new Date(base.getTime() - MINUTE).toISOString() },
      }),
    },
  ]

  it.each(stopCases)('stops before any effect when $name', async ({ reason, arrange }) => {
    const fx = await fixture(reason.toLowerCase().slice(0, 12))
    const routine = await routineFor(fx, await arrange(fx))

    await expect(dispatch(routine.id, base)).resolves.toEqual({
      routineId: routine.id,
      status: 'STOPPED',
      reason,
    })

    const after = await reload(routine.id)
    expect(after).toMatchObject({
      enabled: false,
      nextRunAt: null,
      stopReason: reason,
      lastSkipReason: reason,
    })
    expect(after.stoppedAt).toEqual(base)
    // No stale effect: no run, no dispatch slot, no budget ledger.
    expect(await effects(routine.id)).toEqual({ runs: 0, dispatches: 0 })
    expect(await auditCount(fx, routine.id, 'agent-routine.stopped')).toBe(1)
  })

  it('stops after the maximum number of reminders, having dispatched exactly that many', async () => {
    const fx = await fixture('maxrem')
    const routine = await routineFor(fx, { stopRules: { maxReminders: 2 } })
    await expect(dispatch(routine.id, base)).resolves.toMatchObject({ status: 'DISPATCHED' })
    await finishAndMakeDue(routine.id, new Date(base.getTime() + MINUTE))
    await expect(
      dispatch(routine.id, new Date(base.getTime() + 2 * MINUTE)),
    ).resolves.toMatchObject({
      status: 'DISPATCHED',
    })
    await finishAndMakeDue(routine.id, new Date(base.getTime() + 3 * MINUTE))
    await expect(
      dispatch(routine.id, new Date(base.getTime() + 4 * MINUTE)),
    ).resolves.toMatchObject({
      status: 'STOPPED',
      reason: 'MAX_REMINDERS_REACHED',
    })
    expect(await effects(routine.id)).toEqual({ runs: 2, dispatches: 2 })
  })

  it('is idempotent: a re-run and concurrent runs record one stop and still create nothing', async () => {
    const fx = await fixture('idem')
    const routine = await routineFor(fx, {
      stopRules: {
        subject: { kind: 'SUPPORT_REQUEST', id: (await supportRequest(fx, 'COMPLETED')).id },
      },
    })
    const results = await Promise.all(Array.from({ length: 5 }, () => dispatch(routine.id, base)))
    const stopped = results.filter((result) => result.status === 'STOPPED')
    expect(stopped.length).toBeGreaterThanOrEqual(1)
    for (const result of results) {
      expect(['STOPPED', 'SKIPPED']).toContain(result.status)
    }
    // Later runs find the routine disabled and do nothing at all.
    await expect(dispatch(routine.id, new Date(base.getTime() + MINUTE))).resolves.toEqual({
      routineId: routine.id,
      status: 'SKIPPED',
      reason: 'NOT_DUE',
    })
    expect(await auditCount(fx, routine.id, 'agent-routine.stopped')).toBe(1)
    expect(await effects(routine.id)).toEqual({ runs: 0, dispatches: 0 })
    expect((await reload(routine.id)).stopReason).toBe('REQUEST_RESOLVED')
  })

  it('re-checks the rules when a person enables a stopped routine again', async () => {
    const fx = await fixture('reenable')
    const request = await supportRequest(fx, 'COMPLETED')
    const routine = await routineFor(fx, {
      stopRules: { subject: { kind: 'SUPPORT_REQUEST', id: request.id } },
    })
    await dispatch(routine.id, base)
    expect((await reload(routine.id)).stopReason).toBe('REQUEST_RESOLVED')

    await withTenantIsolationBypass(() =>
      setAgentRoutineEnabledAction(
        {
          operationId: randomUUID(),
          tenantId: fx.tenantId,
          venueId: fx.venueId,
          routineId: routine.id,
          enabled: true,
        },
        'integration-operator',
        { now: new Date(base.getTime() + MINUTE) },
      ),
    )
    const enabledAgain = await reload(routine.id)
    expect(enabledAgain).toMatchObject({ enabled: true, stoppedAt: null, stopReason: null })

    // The request is still resolved, so the very next run stops it again with nothing created.
    await expect(
      dispatch(routine.id, new Date(base.getTime() + 2 * MINUTE)),
    ).resolves.toMatchObject({
      status: 'STOPPED',
      reason: 'REQUEST_RESOLVED',
    })
    expect(await effects(routine.id)).toEqual({ runs: 0, dispatches: 0 })
  })
})

const budgetOf = (cents: number, estimate: number, period: 'DAY' | 'WEEK' | 'MONTH' = 'DAY') => ({
  budgetCents: cents,
  budgetCurrency: 'USD',
  budgetPeriod: period,
  estimatedRunCostCents: estimate,
})

const usageOf = (routineId: string) =>
  withTenantIsolationBypass(() =>
    db.agentRoutineBudgetUsage.findMany({ where: { routineId }, orderBy: { periodStart: 'asc' } }),
  )

describe.skipIf(!enabled)('routine dollar budgets (disposable PostgreSQL)', () => {
  afterAll(async () => db.$disconnect())

  it('reserves each run, then refuses with BUDGET_EXCEEDED and no partial effect', async () => {
    const fx = await fixture('budget')
    const routine = await routineFor(fx, budgetOf(100, 40))

    await expect(dispatch(routine.id, base)).resolves.toMatchObject({ status: 'DISPATCHED' })
    await finishAndMakeDue(routine.id, new Date(base.getTime() + MINUTE))
    await expect(
      dispatch(routine.id, new Date(base.getTime() + 2 * MINUTE)),
    ).resolves.toMatchObject({
      status: 'DISPATCHED',
    })
    await finishAndMakeDue(routine.id, new Date(base.getTime() + 3 * MINUTE))

    const refusedAt = new Date(base.getTime() + 4 * MINUTE)
    await expect(dispatch(routine.id, refusedAt)).resolves.toEqual({
      routineId: routine.id,
      status: 'SKIPPED',
      reason: 'BUDGET_EXCEEDED',
    })

    const [usage] = await usageOf(routine.id)
    expect(usage).toMatchObject({ spentCents: 80, runCount: 2, budgetCents: 100, currency: 'USD' })
    expect(await effects(routine.id)).toEqual({ runs: 2, dispatches: 2 })
    const after = await reload(routine.id)
    expect(after.lastSkipReason).toBe('BUDGET_EXCEEDED')
    expect(after.enabled).toBe(true)
    // The refused slot stays refused on retry and the audit is not repeated.
    await finishAndMakeDue(routine.id, new Date(base.getTime() + 5 * MINUTE))
    await dispatch(routine.id, new Date(base.getTime() + 6 * MINUTE))
    expect((await usageOf(routine.id))[0]!.spentCents).toBe(80)
    expect(await auditCount(fx, routine.id, 'agent-routine.budget-exceeded')).toBe(1)
    const reserved = await withTenantIsolationBypass(() =>
      db.agentRoutineDispatch.findMany({
        where: { routineId: routine.id },
        select: { reservedCostCents: true },
      }),
    )
    expect(reserved.map((row) => row.reservedCostCents)).toEqual([40, 40])
  })

  it('refuses a single run larger than what remains without touching the ledger total', async () => {
    const fx = await fixture('single')
    const routine = await routineFor(fx, budgetOf(100, 100))
    await expect(dispatch(routine.id, base)).resolves.toMatchObject({ status: 'DISPATCHED' })
    await finishAndMakeDue(routine.id, new Date(base.getTime() + MINUTE))
    await expect(
      dispatch(routine.id, new Date(base.getTime() + 2 * MINUTE)),
    ).resolves.toMatchObject({
      status: 'SKIPPED',
      reason: 'BUDGET_EXCEEDED',
    })
    expect((await usageOf(routine.id))[0]!.spentCents).toBe(100)
  })

  it('never double-spends when reservations race: the last slot goes to exactly one caller', async () => {
    const fx = await fixture('race')
    const routine = await routineFor(fx, budgetOf(100, 40))
    const target = {
      id: routine.id,
      tenantId: fx.tenantId,
      venueId: fx.venueId,
      ...budgetOf(100, 40),
      budgetPeriod: 'DAY' as const,
    }
    // Twelve independent transactions (no shared advisory lock) all try to reserve at once.
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        withTenantIsolationBypass(() =>
          db.$transaction((tx) => reserveAgentRoutineBudget(tx, target, base)),
        ),
      ),
    )
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(2)
    const usage = await usageOf(routine.id)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ spentCents: 80, runCount: 2 })
  })

  it('lets only one of many simultaneous dispatches of the same slot create a run', async () => {
    const fx = await fixture('slot')
    const routine = await routineFor(fx, budgetOf(1_000, 10))
    const results = await Promise.all(Array.from({ length: 3 }, () => dispatch(routine.id, base)))
    expect(results.filter((result) => result.status === 'DISPATCHED')).toHaveLength(1)
    expect(await effects(routine.id)).toEqual({ runs: 1, dispatches: 1 })
    expect((await usageOf(routine.id))[0]).toMatchObject({ spentCents: 10, runCount: 1 })
  })

  it('backs the application guard with a database CHECK that rejects overspend', async () => {
    const fx = await fixture('check')
    const routine = await routineFor(fx, budgetOf(100, 40))
    await dispatch(routine.id, base)
    const [usage] = await usageOf(routine.id)
    await expect(
      withTenantIsolationBypass(() =>
        db.agentRoutineBudgetUsage.update({ where: { id: usage!.id }, data: { spentCents: 101 } }),
      ),
    ).rejects.toThrow()
    await expect(
      withTenantIsolationBypass(() =>
        db.agentRoutineBudgetUsage.update({ where: { id: usage!.id }, data: { spentCents: -1 } }),
      ),
    ).rejects.toThrow()
    // Budgets are all-or-none on the routine itself.
    await expect(
      withTenantIsolationBypass(() =>
        db.agentRoutine.update({
          where: { id: routine.id },
          data: { estimatedRunCostCents: null },
        }),
      ),
    ).rejects.toThrow()
  })

  it('starts a fresh allowance each period (day rollover) and keeps the old ledger', async () => {
    const fx = await fixture('roll')
    const routine = await routineFor(fx, budgetOf(100, 60))
    const dayOne = new Date('2026-10-02T23:00:00.000Z')
    await expect(dispatch(routine.id, dayOne)).resolves.toMatchObject({ status: 'DISPATCHED' })
    await finishAndMakeDue(routine.id, new Date('2026-10-02T23:10:00.000Z'))
    await expect(dispatch(routine.id, new Date('2026-10-02T23:30:00.000Z'))).resolves.toMatchObject(
      {
        status: 'SKIPPED',
        reason: 'BUDGET_EXCEEDED',
      },
    )
    await finishAndMakeDue(routine.id, new Date('2026-10-03T00:05:00.000Z'))
    await expect(dispatch(routine.id, new Date('2026-10-03T00:10:00.000Z'))).resolves.toMatchObject(
      {
        status: 'DISPATCHED',
      },
    )
    const usage = await usageOf(routine.id)
    expect(usage.map((row) => [row.periodStart.toISOString(), row.spentCents])).toEqual([
      ['2026-10-02T00:00:00.000Z', 60],
      ['2026-10-03T00:00:00.000Z', 60],
    ])
  })

  it.each([
    ['WEEK', '2026-10-04T12:00:00.000Z', '2026-10-05T00:30:00.000Z'],
    ['MONTH', '2026-10-31T12:00:00.000Z', '2026-11-01T00:30:00.000Z'],
  ] as const)('rolls a %s budget over at the period boundary', async (period, before, after) => {
    const fx = await fixture(`roll${period.toLowerCase()}`)
    const routine = await routineFor(fx, budgetOf(100, 100, period))
    const target = {
      id: routine.id,
      tenantId: fx.tenantId,
      venueId: fx.venueId,
      ...budgetOf(100, 100, period),
      budgetPeriod: period,
    }
    const reserve = (at: string) =>
      withTenantIsolationBypass(() =>
        db.$transaction((tx) => reserveAgentRoutineBudget(tx, target, new Date(at))),
      )
    expect((await reserve(before)).ok).toBe(true)
    expect((await reserve(before)).ok).toBe(false)
    expect((await reserve(after)).ok).toBe(true)
    expect(await usageOf(routine.id)).toHaveLength(2)
  })

  it('honors a lowered budget even when the period row still holds the old, larger one', async () => {
    const fx = await fixture('lowered')
    const routine = await routineFor(fx, budgetOf(100, 40))
    await dispatch(routine.id, base)
    await finishAndMakeDue(routine.id, new Date(base.getTime() + MINUTE))
    // Lowered below what is already spent plus one more run: the next run must be refused.
    await withTenantIsolationBypass(() =>
      db.agentRoutine.update({ where: { id: routine.id }, data: budgetOf(60, 40) }),
    )
    await expect(
      dispatch(routine.id, new Date(base.getTime() + 2 * MINUTE)),
    ).resolves.toMatchObject({
      status: 'SKIPPED',
      reason: 'BUDGET_EXCEEDED',
    })
    expect((await usageOf(routine.id))[0]).toMatchObject({ spentCents: 40, budgetCents: 60 })
  })

  it('does not reinterpret prior spend after a mid-period currency change', async () => {
    const fx = await fixture('currency')
    const routine = await routineFor(fx, budgetOf(100, 40))
    await dispatch(routine.id, base)
    await finishAndMakeDue(routine.id, new Date(base.getTime() + MINUTE))
    await withTenantIsolationBypass(() =>
      db.agentRoutine.update({
        where: { id: routine.id },
        data: { budgetCurrency: 'EUR' },
      }),
    )
    await expect(
      dispatch(routine.id, new Date(base.getTime() + 2 * MINUTE)),
    ).resolves.toMatchObject({
      status: 'SKIPPED',
      reason: 'BUDGET_EXCEEDED',
    })
    expect((await usageOf(routine.id))[0]).toMatchObject({
      spentCents: 40,
      budgetCents: 100,
      currency: 'USD',
    })
  })

  it('leaves a routine without a budget unmetered', async () => {
    const fx = await fixture('nobudget')
    const routine = await routineFor(fx)
    await expect(dispatch(routine.id, base)).resolves.toMatchObject({ status: 'DISPATCHED' })
    expect(await usageOf(routine.id)).toHaveLength(0)
  })
})
