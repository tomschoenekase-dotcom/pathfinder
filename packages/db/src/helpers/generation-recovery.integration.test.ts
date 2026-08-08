import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { discoverExpiredGenerationExecutions } from './generation-recovery'

function isExplicitDisposableDatabase(): boolean {
  if (process.env.RUN_GENERATION_RECOVERY_DB_INTEGRATION !== '1') return false
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

integrationDescribe('generation recovery discovery (disposable PostgreSQL integration)', () => {
  const runId = randomUUID()
  const tenantId = `generation-recovery-tenant-${runId}`
  const venueId = `generation-recovery-venue-${runId}`
  const rangeStart = new Date('2026-08-01T00:00:00.000Z')
  const rangeEnd = new Date('2026-08-08T00:00:00.000Z')
  const expiredAt = new Date('1900-01-01T00:00:00.000Z')
  const activeUntil = new Date('2999-01-01T00:00:00.000Z')
  const analysisIds = [
    `generation-recovery-analysis-1-${runId}`,
    `generation-recovery-analysis-2-${runId}`,
    `generation-recovery-analysis-3-${runId}`,
  ]
  const reportIds = [
    `generation-recovery-report-1-${runId}`,
    `generation-recovery-report-2-${runId}`,
    `generation-recovery-report-3-${runId}`,
  ]
  const analysisTokens = [randomUUID(), randomUUID(), randomUUID()]
  const reportTokens = [randomUUID(), randomUUID(), randomUUID()]

  beforeAll(async () => {
    await db.tenant.create({
      data: { id: tenantId, name: 'Generation recovery integration', slug: tenantId },
    })
    await db.venue.create({
      data: { id: venueId, tenantId, name: 'Generation recovery venue', slug: venueId },
    })

    await db.answerAnalysisSnapshot.createMany({
      data: [
        ...analysisIds.map((id, index) => ({
          id,
          tenantId,
          venueId,
          rangeStart,
          rangeEnd,
          status: 'GENERATING' as const,
          createdBy: 'integration-test',
          executionLeaseToken: analysisTokens[index]!,
          executionLeaseExpiresAt: expiredAt,
        })),
        {
          id: `generation-recovery-analysis-active-${runId}`,
          tenantId,
          venueId,
          rangeStart,
          rangeEnd,
          status: 'GENERATING' as const,
          createdBy: 'integration-test',
          executionLeaseToken: randomUUID(),
          executionLeaseExpiresAt: activeUntil,
        },
        {
          id: `generation-recovery-analysis-terminal-${runId}`,
          tenantId,
          venueId,
          rangeStart,
          rangeEnd,
          status: 'COMPLETE' as const,
          createdBy: 'integration-test',
          executionLeaseToken: randomUUID(),
          executionLeaseExpiresAt: new Date('1800-01-01T00:00:00.000Z'),
        },
        {
          id: `generation-recovery-analysis-null-${runId}`,
          tenantId,
          venueId,
          rangeStart,
          rangeEnd,
          status: 'GENERATING' as const,
          createdBy: 'integration-test',
          executionLeaseToken: null,
          executionLeaseExpiresAt: null,
        },
      ],
    })

    await db.weeklyReport.createMany({
      data: [
        ...reportIds.map((id, index) => ({
          id,
          tenantId,
          venueId,
          weekStart: rangeStart,
          weekEnd: rangeEnd,
          status: 'GENERATING' as const,
          createdBy: 'integration-test',
          executionLeaseToken: reportTokens[index]!,
          executionLeaseExpiresAt: expiredAt,
        })),
        {
          id: `generation-recovery-report-active-${runId}`,
          tenantId,
          venueId,
          weekStart: rangeStart,
          weekEnd: rangeEnd,
          status: 'GENERATING' as const,
          createdBy: 'integration-test',
          executionLeaseToken: randomUUID(),
          executionLeaseExpiresAt: activeUntil,
        },
        {
          id: `generation-recovery-report-terminal-${runId}`,
          tenantId,
          venueId,
          weekStart: rangeStart,
          weekEnd: rangeEnd,
          status: 'PUBLISHED' as const,
          createdBy: 'integration-test',
          executionLeaseToken: randomUUID(),
          executionLeaseExpiresAt: new Date('1800-01-01T00:00:00.000Z'),
        },
        {
          id: `generation-recovery-report-null-${runId}`,
          tenantId,
          venueId,
          weekStart: rangeStart,
          weekEnd: rangeEnd,
          status: 'GENERATING' as const,
          createdBy: 'integration-test',
          executionLeaseToken: null,
          executionLeaseExpiresAt: null,
        },
      ],
    })
  })

  afterAll(async () => {
    await db.answerAnalysisSnapshot.deleteMany({ where: { tenantId } })
    await db.weeklyReport.deleteMany({ where: { tenantId } })
    await db.venue.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it('selects both types in stable expiry/id order and enforces the per-type bound', async () => {
    const result = await discoverExpiredGenerationExecutions({ limitPerType: 2 })

    expect(result.answerAnalyses).toEqual(
      analysisIds.slice(0, 2).map((snapshotId, index) => ({
        snapshotId,
        tenantId,
        venueId,
        rangeStart,
        rangeEnd,
        executionLeaseToken: analysisTokens[index],
      })),
    )
    expect(result.weeklyReports).toEqual(
      reportIds.slice(0, 2).map((reportId, index) => ({
        reportId,
        tenantId,
        venueId,
        weekStart: rangeStart,
        weekEnd: rangeEnd,
        executionLeaseToken: reportTokens[index],
      })),
    )
  })

  it('returns all exact expired identities while excluding active, terminal, and null leases', async () => {
    const result = await discoverExpiredGenerationExecutions()
    const analyses = result.answerAnalyses.filter((row) => row.tenantId === tenantId)
    const reports = result.weeklyReports.filter((row) => row.tenantId === tenantId)

    expect(analyses).toHaveLength(3)
    expect(analyses.map((row) => row.snapshotId)).toEqual(analysisIds)
    expect(analyses.map((row) => row.executionLeaseToken)).toEqual(analysisTokens)
    expect(reports).toHaveLength(3)
    expect(reports.map((row) => row.reportId)).toEqual(reportIds)
    expect(reports.map((row) => row.executionLeaseToken)).toEqual(reportTokens)
  })
})
