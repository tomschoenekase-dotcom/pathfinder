import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import { db } from '@pathfinder/db'
import { WEEKLY_REPORT_QUEUE } from '@pathfinder/jobs'

import { createSafeOperationalMcpRegistry } from './composition'

const enabled =
  process.env.RUN_REPORT_LIFECYCLE_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('weekly report lifecycle MCP disposable integration', () => {
  afterAll(async () => db.$disconnect())

  it('returns exact-scope lifecycle evidence while excluding raw content, errors, sources, and actor identity', async () => {
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `report-lifecycle-${suffix}`
    const venueId = `report-lifecycle-venue-${suffix}`
    const reportId = `report-lifecycle-report-${suffix}`
    const requestId = randomUUID()
    const privateMarker = `private-${suffix}`
    await db.tenant.create({
      data: { id: tenantId, name: 'Report lifecycle proof', slug: tenantId },
    })
    await db.venue.create({
      data: { id: venueId, tenantId, name: 'Report lifecycle venue', slug: venueId },
    })
    await db.venueReportConfiguration.create({
      data: { tenantId, venueId, enabled: true, updatedBy: privateMarker },
    })
    await db.weeklyReport.create({
      data: {
        id: reportId,
        tenantId,
        venueId,
        weekStart: new Date('2026-08-10T00:00:00.000Z'),
        weekEnd: new Date('2026-08-16T23:59:59.000Z'),
        status: 'DRAFT',
        title: 'Bounded lifecycle proof',
        content: `${privateMarker}-content`,
        answerCount: 7,
        sessionCount: 11,
        error: `${privateMarker}-report-error`,
        generatedAt: new Date('2026-08-17T10:00:00.000Z'),
        createdBy: privateMarker,
      },
    })
    await db.generationRequestDispatch.create({
      data: {
        tenantId,
        venueId,
        kind: 'WEEKLY_REPORT',
        requestId,
        requestHash: 'a'.repeat(64),
        recordId: reportId,
        rangeStart: new Date('2026-08-10T00:00:00.000Z'),
        rangeEnd: new Date('2026-08-16T23:59:59.000Z'),
        weeklyReportId: reportId,
        status: 'CONSUMED',
        attempts: 2,
        lastError: `${privateMarker}-dispatch-error`,
        consumedAt: new Date('2026-08-17T09:50:00.000Z'),
      },
    })
    await db.jobRecord.create({
      data: {
        queue: WEEKLY_REPORT_QUEUE,
        jobName: 'weekly-report.process',
        tenantId,
        status: 'COMPLETE',
        payload: { reportId, privateSource: `${privateMarker}-payload` },
        error: `${privateMarker}-job-error`,
        attemptNumber: 2,
        maxAttempts: 3,
        startedAt: new Date('2026-08-17T09:50:00.000Z'),
        completedAt: new Date('2026-08-17T10:00:00.000Z'),
      },
    })
    await db.auditLog.create({
      data: {
        tenantId,
        actorId: privateMarker,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.report.requested',
        targetType: 'WeeklyReport',
        targetId: reportId,
        afterState: { privateSource: `${privateMarker}-audit` },
      },
    })

    const credential: VerifiedMcpCredentialScope = {
      credentialId: `credential-${suffix}`,
      tenantId,
      clientId: tenantId,
      venueIds: [venueId],
      capabilities: ['reports:read'],
    }
    const registry = createSafeOperationalMcpRegistry(db)
    const result = await registry.callTool(
      'torchiko.reports.get_lifecycle',
      { clientId: tenantId, venueId, reportId },
      { credential },
    )
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.weekly-report-lifecycle',
      data: {
        status: 'REVIEW',
        report: {
          sourceEvidence: { capturedAnswerCount: 7, publicSessionCount: 11 },
          failurePresent: true,
        },
        generation: {
          dispatch: { state: 'CONSUMED', attempts: 2, failurePresent: true },
          jobs: { count: 1, latest: { status: 'COMPLETE', failurePresent: true } },
        },
        publication: { state: 'NOT_PUBLISHED', clientVisible: false },
        audit: { count: 1, recent: [{ action: 'admin.report.requested' }] },
      },
    })
    expect(JSON.stringify(result)).not.toContain(privateMarker)
    await expect(
      registry.callTool(
        'torchiko.reports.get_lifecycle',
        { clientId: tenantId, venueId, reportId: `missing-${reportId}` },
        { credential },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' })
  })
})
