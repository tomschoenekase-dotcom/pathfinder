import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '../client'
import {
  adoptLegacyNullLeaseGenerationDispatches,
  failGenerationRequestDispatch,
  leaseGenerationRequestDispatches,
  settleProgressedGenerationRequestDispatch,
} from './generation-request-dispatches'

function isExplicitDisposableDatabase(): boolean {
  if (process.env.RUN_GENERATION_DISPATCH_DB_INTEGRATION !== '1') return false
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

integrationDescribe('generation request dispatches (disposable PostgreSQL integration)', () => {
  const runId = randomUUID()
  const tenantId = `generation-dispatch-tenant-${runId}`
  const venueId = `generation-dispatch-venue-${runId}`
  const rangeStart = new Date('2026-08-01T00:00:00.000Z')
  const rangeEnd = new Date('2026-08-08T00:00:00.000Z')

  async function createAnalysis(label: string) {
    const snapshotId = `generation-dispatch-analysis-${label}-${randomUUID()}`
    await db.answerAnalysisSnapshot.create({
      data: {
        id: snapshotId,
        tenantId,
        venueId,
        rangeStart,
        rangeEnd,
        status: 'GENERATING',
        createdBy: 'integration-test',
      },
    })
    return snapshotId
  }

  async function createReport(label: string) {
    const reportId = `generation-dispatch-report-${label}-${randomUUID()}`
    await db.weeklyReport.create({
      data: {
        id: reportId,
        tenantId,
        venueId,
        weekStart: rangeStart,
        weekEnd: rangeEnd,
        status: 'GENERATING',
        createdBy: 'integration-test',
      },
    })
    return reportId
  }

  beforeAll(async () => {
    await db.tenant.create({
      data: { id: tenantId, name: 'Generation dispatch integration', slug: tenantId },
    })
    await db.venue.create({
      data: { id: venueId, tenantId, name: 'Generation dispatch venue', slug: venueId },
    })
  })

  beforeEach(async () => {
    await db.generationRequestDispatch.deleteMany({ where: { tenantId } })
    await db.answerAnalysisSnapshot.deleteMany({ where: { tenantId } })
    await db.weeklyReport.deleteMany({ where: { tenantId } })
  })

  afterAll(async () => {
    await db.generationRequestDispatch.deleteMany({ where: { tenantId } })
    await db.answerAnalysisSnapshot.deleteMany({ where: { tenantId } })
    await db.weeklyReport.deleteMany({ where: { tenantId } })
    await db.venue.deleteMany({ where: { tenantId } })
    // ContentVersion is append-only and restricts tenant deletion. The unique
    // test tenant is intentionally retained until the disposable database exits.
    await db.$disconnect()
  })

  it('adopts at most the requested number of null-lease legacy rows per type', async () => {
    await Promise.all([
      ...Array.from({ length: 4 }, (_, index) => createAnalysis(`bounded-${index}`)),
      ...Array.from({ length: 4 }, (_, index) => createReport(`bounded-${index}`)),
    ])

    await expect(adoptLegacyNullLeaseGenerationDispatches({ limitPerType: 2 })).resolves.toEqual({
      answerAnalysis: 2,
      weeklyReports: 2,
    })

    const dispatches = await db.generationRequestDispatch.findMany({
      where: { tenantId },
      orderBy: { recordId: 'asc' },
    })
    expect(dispatches).toHaveLength(4)
    expect(dispatches.filter((row) => row.kind === 'ANSWER_ANALYSIS')).toHaveLength(2)
    expect(dispatches.filter((row) => row.kind === 'WEEKLY_REPORT')).toHaveLength(2)
    expect(dispatches.every((row) => row.status === 'PENDING' && row.attempts === 0)).toBe(true)
  })

  it('gives one owner the sole due receipt and increments attempts exactly once', async () => {
    const snapshotId = await createAnalysis('contention')
    await adoptLegacyNullLeaseGenerationDispatches({ limitPerType: 1 })

    const leases = await Promise.all(
      Array.from({ length: 16 }, () => leaseGenerationRequestDispatches({ limit: 1 })),
    )
    const owners = leases.flatMap(({ leaseToken, dispatches }) =>
      dispatches.filter((row) => row.recordId === snapshotId).map((row) => ({ leaseToken, row })),
    )
    expect(owners).toHaveLength(1)

    const persisted = await db.generationRequestDispatch.findFirstOrThrow({
      where: { tenantId, kind: 'ANSWER_ANALYSIS', recordId: snapshotId },
    })
    expect(persisted.attempts).toBe(1)
    expect(persisted.leaseToken).toBe(owners[0]!.leaseToken)
    expect(persisted.leaseExpiresAt).not.toBeNull()
  })

  it('fences the wrong token and applies bounded failure diagnostics with backoff', async () => {
    const snapshotId = await createAnalysis('failure')
    await adoptLegacyNullLeaseGenerationDispatches({ limitPerType: 1 })
    const leased = await leaseGenerationRequestDispatches({ limit: 1 })
    const dispatch = leased.dispatches.find((row) => row.recordId === snapshotId)
    expect(dispatch).toBeDefined()
    const exact = {
      id: dispatch!.id,
      tenantId,
      venueId,
      kind: dispatch!.kind,
      recordId: snapshotId,
    }

    await expect(
      failGenerationRequestDispatch({ ...exact, leaseToken: randomUUID(), error: 'wrong owner' }),
    ).resolves.toBe(false)

    await db.generationRequestDispatch.updateMany({
      where: { tenantId, id: dispatch!.id, leaseToken: leased.leaseToken },
      data: { attempts: 1_000_000 },
    })
    const beforeFailure = new Date()
    await expect(
      failGenerationRequestDispatch({
        ...exact,
        leaseToken: leased.leaseToken,
        error: 'x'.repeat(1_500),
      }),
    ).resolves.toBe(true)

    const failed = await db.generationRequestDispatch.findFirstOrThrow({
      where: { tenantId, id: dispatch!.id },
    })
    expect(failed.status).toBe('PENDING')
    expect(failed.leaseToken).toBeNull()
    expect(failed.leaseExpiresAt).toBeNull()
    expect(failed.lastError).toBe('x'.repeat(1_000))
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(beforeFailure.getTime())
    expect(failed.nextAttemptAt.getTime()).toBeLessThanOrEqual(beforeFailure.getTime() + 301_000)
  })

  it('settles only after the exact authoritative target has progressed', async () => {
    const snapshotId = await createAnalysis('progressed')
    await adoptLegacyNullLeaseGenerationDispatches({ limitPerType: 1 })
    const leased = await leaseGenerationRequestDispatches({ limit: 1 })
    const dispatch = leased.dispatches.find((row) => row.recordId === snapshotId)
    expect(dispatch).toBeDefined()
    const exact = {
      id: dispatch!.id,
      tenantId,
      venueId,
      kind: dispatch!.kind,
      recordId: snapshotId,
      leaseToken: leased.leaseToken,
    }

    await expect(settleProgressedGenerationRequestDispatch(exact)).resolves.toBe(false)
    await db.answerAnalysisSnapshot.updateMany({
      where: { id: snapshotId, tenantId, venueId },
      data: {
        executionLeaseToken: randomUUID(),
        executionLeaseExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
      },
    })
    await expect(settleProgressedGenerationRequestDispatch(exact)).resolves.toBe(true)

    const consumed = await db.generationRequestDispatch.findFirstOrThrow({
      where: { tenantId, id: dispatch!.id },
    })
    expect(consumed.status).toBe('CONSUMED')
    expect(consumed.consumedAt).not.toBeNull()
    expect(consumed.leaseToken).toBeNull()
    expect(consumed.leaseExpiresAt).toBeNull()
  })
})
