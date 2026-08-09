import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import {
  acquireAnswerAnalysisExecution,
  acquireAnswerAnalysisRecoveryExecution,
  acquireWeeklyReportExecution,
  acquireWeeklyReportRecoveryExecution,
  deferAnswerAnalysisExecution,
  deferWeeklyReportExecution,
} from './generation-execution-claims'

function isExplicitDisposableDatabase(): boolean {
  if (process.env.RUN_GENERATION_EXECUTION_DB_INTEGRATION !== '1') return false
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

integrationDescribe('generation execution claims (disposable PostgreSQL integration)', () => {
  const runId = randomUUID()
  const tenantId = `generation-lease-tenant-${runId}`
  const venueId = `generation-lease-venue-${runId}`
  const rangeStart = new Date('2026-08-01T00:00:00.000Z')
  const rangeEnd = new Date('2026-08-08T00:00:00.000Z')

  async function createAnalysis(status: 'GENERATING' | 'COMPLETE' | 'FAILED' = 'GENERATING') {
    const snapshotId = randomUUID()
    await db.answerAnalysisSnapshot.create({
      data: {
        id: snapshotId,
        tenantId,
        venueId,
        rangeStart,
        rangeEnd,
        status,
        ...(status === 'FAILED' ? { error: 'prior analysis failure' } : {}),
        createdBy: 'integration-test',
      },
    })
    return { snapshotId, tenantId, venueId, rangeStart, rangeEnd }
  }

  async function createReport(
    status: 'GENERATING' | 'DRAFT' | 'PUBLISHED' | 'FAILED' = 'GENERATING',
  ) {
    const reportId = randomUUID()
    await db.weeklyReport.create({
      data: {
        id: reportId,
        tenantId,
        venueId,
        weekStart: rangeStart,
        weekEnd: rangeEnd,
        status,
        ...(status === 'FAILED' ? { error: 'prior report failure' } : {}),
        createdBy: 'integration-test',
      },
    })
    return { reportId, tenantId, venueId, weekStart: rangeStart, weekEnd: rangeEnd }
  }

  beforeAll(async () => {
    await db.tenant.create({
      data: { id: tenantId, name: 'Generation lease integration', slug: tenantId },
    })
    await db.venue.create({
      data: { id: venueId, tenantId, name: 'Generation lease venue', slug: venueId },
    })
  })

  afterAll(async () => {
    await db.generationRequestDispatch.deleteMany({ where: { tenantId } })
    await db.answerAnalysisSnapshot.deleteMany({ where: { tenantId } })
    await db.weeklyReport.deleteMany({ where: { tenantId } })
    await db.venue.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it('grants exactly one of 32 answer-analysis callers and blocks an active lease', async () => {
    const identity = await createAnalysis()
    const results = await Promise.all(
      Array.from({ length: 32 }, () => acquireAnswerAnalysisExecution(identity)),
    )

    expect(results.filter((result) => result.state === 'acquired')).toHaveLength(1)
    expect(results.filter((result) => result.state === 'leased')).toHaveLength(31)
    await expect(acquireAnswerAnalysisExecution(identity)).resolves.toEqual({ state: 'leased' })
  })

  it('takes over an expired answer-analysis lease with a new token', async () => {
    const identity = await createAnalysis()
    const first = await acquireAnswerAnalysisExecution(identity)
    if (first.state !== 'acquired') throw new Error('Expected initial answer-analysis lease')

    await db.answerAnalysisSnapshot.updateMany({
      where: { id: identity.snapshotId, tenantId, venueId },
      data: { executionLeaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') },
    })
    const second = await acquireAnswerAnalysisExecution(identity)

    expect(second).toMatchObject({ state: 'acquired' })
    if (second.state !== 'acquired') throw new Error('Expected answer-analysis takeover')
    expect(second.leaseToken).not.toBe(first.leaseToken)

    await expect(
      db.answerAnalysisSnapshot.updateMany({
        where: {
          id: identity.snapshotId,
          tenantId,
          venueId,
          status: 'GENERATING',
          executionLeaseToken: first.leaseToken,
        },
        data: {
          status: 'COMPLETE',
          executionLeaseToken: null,
          executionLeaseExpiresAt: null,
        },
      }),
    ).resolves.toEqual({ count: 0 })
    await expect(
      db.answerAnalysisSnapshot.updateMany({
        where: {
          id: identity.snapshotId,
          tenantId,
          venueId,
          status: 'GENERATING',
          executionLeaseToken: second.leaseToken,
        },
        data: {
          status: 'COMPLETE',
          executionLeaseToken: null,
          executionLeaseExpiresAt: null,
        },
      }),
    ).resolves.toEqual({ count: 1 })
  })

  it('immediately reacquires an answer-analysis lease after fenced incident deferral', async () => {
    const identity = await createAnalysis()
    const first = await acquireAnswerAnalysisExecution(identity)
    if (first.state !== 'acquired') throw new Error('Expected initial answer-analysis lease')

    await expect(
      deferAnswerAnalysisExecution({ ...identity, leaseToken: first.leaseToken }),
    ).resolves.toBe(true)
    const second = await acquireAnswerAnalysisExecution(identity)

    expect(second).toMatchObject({ state: 'acquired' })
    if (second.state !== 'acquired') throw new Error('Expected reacquisition after deferral')
    expect(second.leaseToken).not.toBe(first.leaseToken)
  })

  it('reacquires a deferred answer-analysis recovery with the same observed lineage', async () => {
    const identity = await createAnalysis()
    const original = await acquireAnswerAnalysisExecution(identity)
    if (original.state !== 'acquired') throw new Error('Expected initial answer-analysis lease')
    await db.answerAnalysisSnapshot.updateMany({
      where: { id: identity.snapshotId, tenantId, venueId },
      data: { executionLeaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') },
    })
    const recovery = await acquireAnswerAnalysisRecoveryExecution({
      ...identity,
      observedLeaseToken: original.leaseToken,
    })
    if (recovery.state !== 'acquired') throw new Error('Expected recovery lease')

    await expect(
      deferAnswerAnalysisExecution({ ...identity, leaseToken: recovery.leaseToken }),
    ).resolves.toBe(true)
    const resumed = await acquireAnswerAnalysisRecoveryExecution({
      ...identity,
      observedLeaseToken: original.leaseToken,
    })

    expect(resumed).toMatchObject({ state: 'acquired' })
  })

  it('reacquires FAILED answer analysis and clears the prior error', async () => {
    const identity = await createAnalysis('FAILED')
    await db.answerAnalysisSnapshot.updateMany({
      where: { id: identity.snapshotId, tenantId, venueId },
      data: { recoveryLineageToken: randomUUID() },
    })
    const acquired = await acquireAnswerAnalysisExecution(identity)
    expect(acquired).toMatchObject({ state: 'acquired' })
    expect(
      await db.answerAnalysisSnapshot.findFirstOrThrow({
        where: { id: identity.snapshotId, tenantId, venueId },
      }),
    ).toMatchObject({ status: 'GENERATING', error: null, recoveryLineageToken: null })
  })

  it('rejects a half-present answer-analysis lease at the database boundary', async () => {
    const identity = await createAnalysis()

    await expect(
      db.answerAnalysisSnapshot.updateMany({
        where: { id: identity.snapshotId, tenantId, venueId },
        data: { executionLeaseToken: randomUUID() },
      }),
    ).rejects.toThrow()

    await expect(
      db.answerAnalysisSnapshot.findFirstOrThrow({
        where: { id: identity.snapshotId, tenantId, venueId },
        select: { executionLeaseToken: true, executionLeaseExpiresAt: true },
      }),
    ).resolves.toEqual({ executionLeaseToken: null, executionLeaseExpiresAt: null })
  })

  it('never claims terminal answer analysis and treats scope/range mismatch as missing', async () => {
    const terminal = await createAnalysis('COMPLETE')
    await expect(acquireAnswerAnalysisExecution(terminal)).resolves.toEqual({ state: 'terminal' })

    const identity = await createAnalysis()
    await expect(
      acquireAnswerAnalysisExecution({ ...identity, tenantId: `${tenantId}-wrong` }),
    ).resolves.toEqual({ state: 'missing' })
    await expect(
      acquireAnswerAnalysisExecution({
        ...identity,
        rangeEnd: new Date(rangeEnd.getTime() + 1),
      }),
    ).resolves.toEqual({ state: 'missing' })
  })

  it('grants exactly one of 32 weekly-report callers and blocks an active lease', async () => {
    const identity = await createReport()
    const results = await Promise.all(
      Array.from({ length: 32 }, () => acquireWeeklyReportExecution(identity)),
    )

    expect(results.filter((result) => result.state === 'acquired')).toHaveLength(1)
    expect(results.filter((result) => result.state === 'leased')).toHaveLength(31)
    await expect(acquireWeeklyReportExecution(identity)).resolves.toEqual({ state: 'leased' })
  })

  it('takes over an expired weekly-report lease with a new token', async () => {
    const identity = await createReport()
    const first = await acquireWeeklyReportExecution(identity)
    if (first.state !== 'acquired') throw new Error('Expected initial weekly-report lease')

    await db.weeklyReport.updateMany({
      where: { id: identity.reportId, tenantId, venueId },
      data: { executionLeaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') },
    })
    const second = await acquireWeeklyReportExecution(identity)

    expect(second).toMatchObject({ state: 'acquired' })
    if (second.state !== 'acquired') throw new Error('Expected weekly-report takeover')
    expect(second.leaseToken).not.toBe(first.leaseToken)

    await expect(
      db.weeklyReport.updateMany({
        where: {
          id: identity.reportId,
          tenantId,
          venueId,
          status: 'GENERATING',
          executionLeaseToken: first.leaseToken,
        },
        data: { status: 'DRAFT', executionLeaseToken: null, executionLeaseExpiresAt: null },
      }),
    ).resolves.toEqual({ count: 0 })
    await expect(
      db.weeklyReport.updateMany({
        where: {
          id: identity.reportId,
          tenantId,
          venueId,
          status: 'GENERATING',
          executionLeaseToken: second.leaseToken,
        },
        data: { status: 'DRAFT', executionLeaseToken: null, executionLeaseExpiresAt: null },
      }),
    ).resolves.toEqual({ count: 1 })
  })

  it('immediately reacquires a weekly-report lease after fenced incident deferral', async () => {
    const identity = await createReport()
    const first = await acquireWeeklyReportExecution(identity)
    if (first.state !== 'acquired') throw new Error('Expected initial weekly-report lease')

    await expect(
      deferWeeklyReportExecution({ ...identity, leaseToken: first.leaseToken }),
    ).resolves.toBe(true)
    const second = await acquireWeeklyReportExecution(identity)

    expect(second).toMatchObject({ state: 'acquired' })
    if (second.state !== 'acquired') throw new Error('Expected reacquisition after deferral')
    expect(second.leaseToken).not.toBe(first.leaseToken)
  })

  it('reacquires a deferred weekly-report recovery with the same observed lineage', async () => {
    const identity = await createReport()
    const original = await acquireWeeklyReportExecution(identity)
    if (original.state !== 'acquired') throw new Error('Expected initial weekly-report lease')
    await db.weeklyReport.updateMany({
      where: { id: identity.reportId, tenantId, venueId },
      data: { executionLeaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') },
    })
    const recovery = await acquireWeeklyReportRecoveryExecution({
      ...identity,
      observedLeaseToken: original.leaseToken,
    })
    if (recovery.state !== 'acquired') throw new Error('Expected recovery lease')

    await expect(
      deferWeeklyReportExecution({ ...identity, leaseToken: recovery.leaseToken }),
    ).resolves.toBe(true)
    const resumed = await acquireWeeklyReportRecoveryExecution({
      ...identity,
      observedLeaseToken: original.leaseToken,
    })

    expect(resumed).toMatchObject({ state: 'acquired' })
  })

  it('reacquires a FAILED weekly report and clears the prior error', async () => {
    const identity = await createReport('FAILED')
    await db.weeklyReport.updateMany({
      where: { id: identity.reportId, tenantId, venueId },
      data: { recoveryLineageToken: randomUUID() },
    })
    const acquired = await acquireWeeklyReportExecution(identity)
    expect(acquired).toMatchObject({ state: 'acquired' })
    expect(
      await db.weeklyReport.findFirstOrThrow({
        where: { id: identity.reportId, tenantId, venueId },
      }),
    ).toMatchObject({ status: 'GENERATING', error: null, recoveryLineageToken: null })
  })

  it('rejects a half-present weekly-report lease at the database boundary', async () => {
    const identity = await createReport()

    await expect(
      db.weeklyReport.updateMany({
        where: { id: identity.reportId, tenantId, venueId },
        data: { executionLeaseExpiresAt: new Date('2026-08-08T00:05:00.000Z') },
      }),
    ).rejects.toThrow()

    await expect(
      db.weeklyReport.findFirstOrThrow({
        where: { id: identity.reportId, tenantId, venueId },
        select: { executionLeaseToken: true, executionLeaseExpiresAt: true },
      }),
    ).resolves.toEqual({ executionLeaseToken: null, executionLeaseExpiresAt: null })
  })

  it('installs the two lease-expiry claim indexes', async () => {
    const rows = await db.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'answer_analysis_snapshots_status_execution_lease_expires_at_idx',
          'weekly_reports_status_execution_lease_expires_at_idx'
        )
      ORDER BY indexname
    `

    expect(rows.map((row) => row.indexname)).toEqual([
      'answer_analysis_snapshots_status_execution_lease_expires_at_idx',
      'weekly_reports_status_execution_lease_expires_at_idx',
    ])
  })

  it('rejects either half of a durable request identity at the database boundary', async () => {
    const identity = await createAnalysis()
    const base = {
      tenantId,
      venueId,
      kind: 'ANSWER_ANALYSIS' as const,
      recordId: identity.snapshotId,
      rangeStart,
      rangeEnd,
      answerAnalysisSnapshotId: identity.snapshotId,
    }

    await expect(
      db.generationRequestDispatch.create({
        data: {
          id: randomUUID(),
          ...base,
          requestId: randomUUID(),
          requestHash: null,
        },
      }),
    ).rejects.toThrow()
    await expect(
      db.generationRequestDispatch.create({
        data: {
          id: randomUUID(),
          ...base,
          requestId: null,
          requestHash: 'a'.repeat(64),
        },
      }),
    ).rejects.toThrow()
    await expect(
      db.generationRequestDispatch.count({
        where: { tenantId, recordId: identity.snapshotId },
      }),
    ).resolves.toBe(0)
  })

  it.each(['DRAFT', 'PUBLISHED'] as const)(
    'never claims terminal weekly-report status %s',
    async (status) => {
      const identity = await createReport(status)
      await expect(acquireWeeklyReportExecution(identity)).resolves.toEqual({ state: 'terminal' })
    },
  )

  it('treats weekly-report scope and range mismatch as missing', async () => {
    const identity = await createReport()
    await expect(
      acquireWeeklyReportExecution({ ...identity, venueId: `${venueId}-wrong` }),
    ).resolves.toEqual({ state: 'missing' })
    await expect(
      acquireWeeklyReportExecution({
        ...identity,
        weekStart: new Date(rangeStart.getTime() - 1),
      }),
    ).resolves.toEqual({ state: 'missing' })
  })

  it('grants exactly one of 32 same-token answer-analysis recovery callers', async () => {
    const identity = await createAnalysis()
    const observedLeaseToken = randomUUID()
    await db.answerAnalysisSnapshot.updateMany({
      where: { id: identity.snapshotId, tenantId, venueId },
      data: {
        executionLeaseToken: observedLeaseToken,
        executionLeaseExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
      },
    })

    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        acquireAnswerAnalysisRecoveryExecution({ ...identity, observedLeaseToken }),
      ),
    )
    const acquired = results.filter((result) => result.state === 'acquired')
    expect(acquired).toHaveLength(1)
    expect(results.filter((result) => result.state === 'ineligible')).toHaveLength(31)
    expect(acquired[0]).toMatchObject({ state: 'acquired' })
    if (acquired[0]?.state !== 'acquired') throw new Error('Expected recovery owner')
    expect(acquired[0].leaseToken).not.toBe(observedLeaseToken)
  })

  it('grants exactly one of 32 same-token weekly-report recovery callers', async () => {
    const identity = await createReport()
    const observedLeaseToken = randomUUID()
    await db.weeklyReport.updateMany({
      where: { id: identity.reportId, tenantId, venueId },
      data: {
        executionLeaseToken: observedLeaseToken,
        executionLeaseExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
      },
    })

    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        acquireWeeklyReportRecoveryExecution({ ...identity, observedLeaseToken }),
      ),
    )
    const acquired = results.filter((result) => result.state === 'acquired')
    expect(acquired).toHaveLength(1)
    expect(results.filter((result) => result.state === 'ineligible')).toHaveLength(31)
    expect(acquired[0]).toMatchObject({ state: 'acquired' })
    if (acquired[0]?.state !== 'acquired') throw new Error('Expected recovery owner')
    expect(acquired[0].leaseToken).not.toBe(observedLeaseToken)
  })

  it('allows only token B lineage after chained answer-analysis recovery owner C fails', async () => {
    const identity = await createAnalysis()
    const tokenA = randomUUID()
    await db.answerAnalysisSnapshot.updateMany({
      where: { id: identity.snapshotId, tenantId, venueId },
      data: {
        executionLeaseToken: tokenA,
        executionLeaseExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
      },
    })
    const tokenBTakeover = await acquireAnswerAnalysisRecoveryExecution({
      ...identity,
      observedLeaseToken: tokenA,
    })
    if (tokenBTakeover.state !== 'acquired') throw new Error('Expected token B recovery takeover')
    const tokenB = tokenBTakeover.leaseToken
    await db.answerAnalysisSnapshot.updateMany({
      where: { id: identity.snapshotId, tenantId, venueId },
      data: { executionLeaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') },
    })
    const tokenCTakeover = await acquireAnswerAnalysisRecoveryExecution({
      ...identity,
      observedLeaseToken: tokenB,
    })
    if (tokenCTakeover.state !== 'acquired') throw new Error('Expected token C recovery takeover')
    const tokenC = tokenCTakeover.leaseToken
    await expect(
      db.answerAnalysisSnapshot.updateMany({
        where: {
          id: identity.snapshotId,
          tenantId,
          venueId,
          status: 'GENERATING',
          executionLeaseToken: tokenC,
        },
        data: {
          status: 'FAILED',
          error: 'synthetic recovery owner C failure',
          executionLeaseToken: null,
          executionLeaseExpiresAt: null,
        },
      }),
    ).resolves.toEqual({ count: 1 })
    await expect(
      db.answerAnalysisSnapshot.findFirstOrThrow({
        where: { id: identity.snapshotId, tenantId, venueId },
        select: { status: true, executionLeaseToken: true, recoveryLineageToken: true },
      }),
    ).resolves.toEqual({
      status: 'FAILED',
      executionLeaseToken: null,
      recoveryLineageToken: tokenB,
    })

    await expect(
      acquireAnswerAnalysisRecoveryExecution({
        ...identity,
        observedLeaseToken: tokenA,
      }),
    ).resolves.toEqual({ state: 'ineligible' })
    await expect(
      acquireAnswerAnalysisRecoveryExecution({
        ...identity,
        observedLeaseToken: tokenB,
      }),
    ).resolves.toMatchObject({ state: 'acquired' })
  })

  it('allows only token B lineage after chained weekly-report recovery owner C fails', async () => {
    const identity = await createReport()
    const tokenA = randomUUID()
    await db.weeklyReport.updateMany({
      where: { id: identity.reportId, tenantId, venueId },
      data: {
        executionLeaseToken: tokenA,
        executionLeaseExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
      },
    })
    const tokenBTakeover = await acquireWeeklyReportRecoveryExecution({
      ...identity,
      observedLeaseToken: tokenA,
    })
    if (tokenBTakeover.state !== 'acquired') throw new Error('Expected token B recovery takeover')
    const tokenB = tokenBTakeover.leaseToken
    await db.weeklyReport.updateMany({
      where: { id: identity.reportId, tenantId, venueId },
      data: { executionLeaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') },
    })
    const tokenCTakeover = await acquireWeeklyReportRecoveryExecution({
      ...identity,
      observedLeaseToken: tokenB,
    })
    if (tokenCTakeover.state !== 'acquired') throw new Error('Expected token C recovery takeover')
    const tokenC = tokenCTakeover.leaseToken
    await expect(
      db.weeklyReport.updateMany({
        where: {
          id: identity.reportId,
          tenantId,
          venueId,
          status: 'GENERATING',
          executionLeaseToken: tokenC,
        },
        data: {
          status: 'FAILED',
          error: 'synthetic recovery owner C failure',
          executionLeaseToken: null,
          executionLeaseExpiresAt: null,
        },
      }),
    ).resolves.toEqual({ count: 1 })
    await expect(
      db.weeklyReport.findFirstOrThrow({
        where: { id: identity.reportId, tenantId, venueId },
        select: { status: true, executionLeaseToken: true, recoveryLineageToken: true },
      }),
    ).resolves.toEqual({
      status: 'FAILED',
      executionLeaseToken: null,
      recoveryLineageToken: tokenB,
    })

    await expect(
      acquireWeeklyReportRecoveryExecution({
        ...identity,
        observedLeaseToken: tokenA,
      }),
    ).resolves.toEqual({ state: 'ineligible' })
    await expect(
      acquireWeeklyReportRecoveryExecution({
        ...identity,
        observedLeaseToken: tokenB,
      }),
    ).resolves.toMatchObject({ state: 'acquired' })
  })

  it('recovers a FAILED/null answer analysis exactly once under contention', async () => {
    const failed = await createAnalysis('FAILED')
    const matchingLineage = randomUUID()
    await db.answerAnalysisSnapshot.updateMany({
      where: { id: failed.snapshotId, tenantId, venueId },
      data: { recoveryLineageToken: matchingLineage },
    })
    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        acquireAnswerAnalysisRecoveryExecution({ ...failed, observedLeaseToken: matchingLineage }),
      ),
    )
    expect(results.filter((result) => result.state === 'acquired')).toHaveLength(1)
    expect(results.filter((result) => result.state === 'ineligible')).toHaveLength(31)
  })

  it('does no answer-analysis recovery work for active, null, terminal, missing, or range mismatch', async () => {
    const active = await createAnalysis()
    const activeToken = randomUUID()
    await db.answerAnalysisSnapshot.updateMany({
      where: { id: active.snapshotId, tenantId, venueId },
      data: {
        executionLeaseToken: activeToken,
        executionLeaseExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
      },
    })
    await expect(
      acquireAnswerAnalysisRecoveryExecution({ ...active, observedLeaseToken: activeToken }),
    ).resolves.toEqual({ state: 'ineligible' })

    const noLease = await createAnalysis()
    await expect(
      acquireAnswerAnalysisRecoveryExecution({ ...noLease, observedLeaseToken: randomUUID() }),
    ).resolves.toEqual({ state: 'ineligible' })
    const terminal = await createAnalysis('COMPLETE')
    await expect(
      acquireAnswerAnalysisRecoveryExecution({ ...terminal, observedLeaseToken: randomUUID() }),
    ).resolves.toEqual({ state: 'terminal' })
    await expect(
      acquireAnswerAnalysisRecoveryExecution({
        ...active,
        snapshotId: randomUUID(),
        observedLeaseToken: activeToken,
      }),
    ).resolves.toEqual({ state: 'missing' })
    await expect(
      acquireAnswerAnalysisRecoveryExecution({
        ...active,
        rangeEnd: new Date(rangeEnd.getTime() + 1),
        observedLeaseToken: activeToken,
      }),
    ).resolves.toEqual({ state: 'missing' })
  })

  it('recovers a FAILED/null weekly report exactly once under contention', async () => {
    const failed = await createReport('FAILED')
    const matchingLineage = randomUUID()
    await db.weeklyReport.updateMany({
      where: { id: failed.reportId, tenantId, venueId },
      data: { recoveryLineageToken: matchingLineage },
    })
    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        acquireWeeklyReportRecoveryExecution({ ...failed, observedLeaseToken: matchingLineage }),
      ),
    )
    expect(results.filter((result) => result.state === 'acquired')).toHaveLength(1)
    expect(results.filter((result) => result.state === 'ineligible')).toHaveLength(31)
  })

  it('does no weekly-report recovery work for active, null, terminal, missing, or range mismatch', async () => {
    const active = await createReport()
    const activeToken = randomUUID()
    await db.weeklyReport.updateMany({
      where: { id: active.reportId, tenantId, venueId },
      data: {
        executionLeaseToken: activeToken,
        executionLeaseExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
      },
    })
    await expect(
      acquireWeeklyReportRecoveryExecution({ ...active, observedLeaseToken: activeToken }),
    ).resolves.toEqual({ state: 'ineligible' })

    const noLease = await createReport()
    await expect(
      acquireWeeklyReportRecoveryExecution({ ...noLease, observedLeaseToken: randomUUID() }),
    ).resolves.toEqual({ state: 'ineligible' })
    const terminal = await createReport('DRAFT')
    await expect(
      acquireWeeklyReportRecoveryExecution({ ...terminal, observedLeaseToken: randomUUID() }),
    ).resolves.toEqual({ state: 'terminal' })
    await expect(
      acquireWeeklyReportRecoveryExecution({
        ...active,
        reportId: randomUUID(),
        observedLeaseToken: activeToken,
      }),
    ).resolves.toEqual({ state: 'missing' })
    await expect(
      acquireWeeklyReportRecoveryExecution({
        ...active,
        weekStart: new Date(rangeStart.getTime() - 1),
        observedLeaseToken: activeToken,
      }),
    ).resolves.toEqual({ state: 'missing' })
  })
})
