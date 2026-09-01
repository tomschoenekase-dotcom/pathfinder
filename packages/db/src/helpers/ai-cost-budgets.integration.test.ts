import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '../client'
import {
  AI_COST_BUDGET_COVERAGE_VERSION,
  AiCostBudgetExceededError,
  AiCostBudgetInvariantError,
  AiCostBudgetUnavailableError,
  markAiCostAttemptDispatched,
  reconcileExpiredAiCostAttempts,
  releaseUndispatchedAiCostAttempt,
  reserveAiCostAttempt,
  settleAiCostAttemptAmbiguous,
  settleAiCostAttemptExact,
} from './ai-cost-budgets'

function isExplicitDisposableDatabase(): boolean {
  if (process.env.RUN_AI_COST_BUDGET_DB_INTEGRATION !== '1') return false
  try {
    const url = new URL(process.env.DATABASE_URL ?? '')
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const database = decodeURIComponent(url.pathname.slice(1))
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      ['127.0.0.1', '::1', 'localhost'].includes(host) &&
      url.port.length > 0 &&
      /^pathfinder_disposable_[a-z0-9_]+$/.test(database)
    )
  } catch {
    return false
  }
}

const integrationDescribe = isExplicitDisposableDatabase() ? describe : describe.skip

integrationDescribe('AI cost budgets (disposable PostgreSQL integration)', () => {
  const runId = randomUUID()
  const tenantId = `ai-budget-tenant-${runId}`
  const venueId = `ai-budget-venue-${runId}`
  const now = new Date('2026-08-08T12:00:00.000Z')

  const identity = (
    overrides: Partial<Parameters<typeof reserveAiCostAttempt>[0]['identity']> = {},
  ) => ({
    tenantId,
    venueId,
    invocationId: randomUUID(),
    attemptNumber: 1,
    feature: 'guest-chat',
    provider: 'anthropic',
    model: 'test-model',
    pricingVersion: 'test-pricing-v1',
    ...overrides,
  })

  async function createBudget(limitUnits = 1_000n) {
    return db.aiCostBudget.create({
      data: {
        tenantId,
        coverageVersion: AI_COST_BUDGET_COVERAGE_VERSION,
        enabled: true,
        startsAt: new Date(now.getTime() - 60_000),
        endsAt: new Date(now.getTime() + 60_000),
        limitUnits,
        remainingUnits: limitUnits,
        updatedBy: 'integration-test',
        reason: 'Disposable integration budget',
      },
    })
  }

  async function reserve(reservedUnits = 100n, attemptIdentity = identity()) {
    return reserveAiCostAttempt({
      db,
      identity: attemptIdentity,
      reservedUnits,
      reservationId: randomUUID(),
      now,
    })
  }

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, name: 'AI budget test', slug: tenantId } })
    await db.venue.create({
      data: { id: venueId, tenantId, name: 'AI budget venue', slug: venueId },
    })
  })

  beforeEach(async () => {
    await db.operationalEvent.deleteMany({ where: { tenantId } })
    await db.aiCostReservation.deleteMany({ where: { tenantId } })
    await db.aiCostBudget.deleteMany({ where: { tenantId } })
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it('leaves enforcement disabled when no explicit budget exists', async () => {
    await expect(reserve()).resolves.toBeNull()
  })

  it('reserves tenant-wide work without inventing a venue', async () => {
    await createBudget()
    const reservation = await reserve(100n, identity({ venueId: null, feature: 'weekly-digest' }))
    expect(reservation).toMatchObject({ tenantId, venueId: null, feature: 'weekly-digest' })
    const stored = await db.aiCostReservation.findFirstOrThrow({ where: { tenantId } })
    expect(stored).toMatchObject({ tenantId, venueId: null, feature: 'weekly-digest' })
  })

  it('admits exactly the concurrent capacity and never overspends', async () => {
    await createBudget()
    const results = await Promise.allSettled(Array.from({ length: 32 }, () => reserve(100n)))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10)
    expect(
      results.filter(
        (result) =>
          result.status === 'rejected' && result.reason instanceof AiCostBudgetExceededError,
      ),
    ).toHaveLength(22)
    const budget = await db.aiCostBudget.findFirstOrThrow({ where: { tenantId } })
    expect(budget).toMatchObject({ remainingUnits: 0n, reservedUnits: 1_000n, committedUnits: 0n })
    expect(await db.aiCostReservation.count({ where: { tenantId } })).toBe(10)
    const event = await db.operationalEvent.findFirstOrThrow({
      where: { tenantId, eventType: 'ai-cost-budget.request-denied' },
    })
    expect(event).toMatchObject({
      venueId,
      sourceSubsystem: 'ai-cost-control',
      severity: 'ERROR',
      actionRequired: true,
      linkedObjectType: 'AiCostBudget',
    })
  })

  it('settles observed cost exactly and replays without moving counters twice', async () => {
    await createBudget()
    const reservation = await reserve()
    if (!reservation) throw new Error('Expected an active reservation')
    await markAiCostAttemptDispatched({ db, reservation, now })
    await settleAiCostAttemptExact({ db, reservation, settledUnits: 40n, now })
    await settleAiCostAttemptExact({ db, reservation, settledUnits: 40n, now })

    const budget = await db.aiCostBudget.findFirstOrThrow({ where: { tenantId } })
    expect(budget).toMatchObject({ remainingUnits: 960n, reservedUnits: 0n, committedUnits: 40n })
    const stored = await db.aiCostReservation.findFirstOrThrow({ where: { tenantId } })
    expect(stored).toMatchObject({ status: 'SETTLED', settlementKind: 'EXACT', settledUnits: 40n })
  })

  it('releases only a reservation proven not to have dispatched', async () => {
    await createBudget()
    const first = await reserve()
    if (!first) throw new Error('Expected an active reservation')
    await releaseUndispatchedAiCostAttempt({ db, reservation: first, now })
    await releaseUndispatchedAiCostAttempt({ db, reservation: first, now })

    const second = await reserve()
    if (!second) throw new Error('Expected a second active reservation')
    await markAiCostAttemptDispatched({ db, reservation: second, now })
    await expect(
      releaseUndispatchedAiCostAttempt({ db, reservation: second, now }),
    ).rejects.toBeInstanceOf(AiCostBudgetInvariantError)
  })

  it('charges the full ceiling for an ambiguous dispatched attempt', async () => {
    await createBudget()
    const reservation = await reserve()
    if (!reservation) throw new Error('Expected an active reservation')
    await markAiCostAttemptDispatched({ db, reservation, now })
    await settleAiCostAttemptAmbiguous({ db, reservation, now })

    const budget = await db.aiCostBudget.findFirstOrThrow({ where: { tenantId } })
    expect(budget).toMatchObject({ remainingUnits: 900n, reservedUnits: 0n, committedUnits: 100n })
    const stored = await db.aiCostReservation.findFirstOrThrow({ where: { tenantId } })
    expect(stored).toMatchObject({
      status: 'SETTLED',
      settlementKind: 'AMBIGUOUS_MAX',
      settledUnits: 100n,
    })
  })

  it('conservatively settles expired reservations without reopening capacity', async () => {
    await createBudget()
    const reservation = await reserve()
    if (!reservation) throw new Error('Expected an active reservation')

    await expect(
      reconcileExpiredAiCostAttempts({
        db,
        tenantId,
        now: new Date(now.getTime() + 16 * 60_000),
      }),
    ).resolves.toEqual({ scanned: 1, settled: 1, raced: 0 })

    const budget = await db.aiCostBudget.findFirstOrThrow({ where: { tenantId } })
    expect(budget).toMatchObject({ remainingUnits: 900n, reservedUnits: 0n, committedUnits: 100n })
    const stored = await db.aiCostReservation.findFirstOrThrow({ where: { tenantId } })
    expect(stored).toMatchObject({
      status: 'SETTLED',
      settlementKind: 'EXPIRED_MAX',
      settledUnits: 100n,
    })
  })

  it('records an over-ceiling observation, breaches the budget, and blocks future calls', async () => {
    await createBudget()
    const reservation = await reserve()
    if (!reservation) throw new Error('Expected an active reservation')
    await markAiCostAttemptDispatched({ db, reservation, now })
    await settleAiCostAttemptExact({ db, reservation, settledUnits: 120n, now })

    const budget = await db.aiCostBudget.findFirstOrThrow({ where: { tenantId } })
    expect(budget).toMatchObject({ remainingUnits: 880n, reservedUnits: 0n, committedUnits: 120n })
    expect(budget.breachedAt).not.toBeNull()
    const event = await db.operationalEvent.findFirstOrThrow({
      where: { tenantId, eventType: 'ai-cost-budget.breached' },
    })
    expect(event).toMatchObject({
      venueId,
      sourceSubsystem: 'ai-cost-control',
      severity: 'ERROR',
      actionRequired: true,
      linkedObjectType: 'AiCostBudget',
    })
    await expect(reserve()).rejects.toBeInstanceOf(AiCostBudgetUnavailableError)
  })
})
