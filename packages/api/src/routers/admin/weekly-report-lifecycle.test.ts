import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  report: vi.fn(),
  configuration: vi.fn(),
  dispatch: vi.fn(),
  jobs: vi.fn(),
  audits: vi.fn(),
}))
vi.mock('@pathfinder/jobs', () => ({ WEEKLY_REPORT_QUEUE: 'test-weekly-report' }))
vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: mocks.bypass,
  db: {
    weeklyReport: { findFirst: mocks.report },
    venueReportConfiguration: { findFirst: mocks.configuration },
    generationRequestDispatch: { findFirst: mocks.dispatch },
    jobRecord: { findMany: mocks.jobs },
    auditLog: { findMany: mocks.audits },
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import {
  adminWeeklyReportLifecycleRouter,
  simpleWeeklyReportStatus,
} from './weekly-report-lifecycle'

const caller = (isPlatformAdmin = true) =>
  router({ admin: adminWeeklyReportLifecycleRouter }).createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'operator', activeTenantId: 'other', role: 'STAFF', isPlatformAdmin },
  })

describe('weekly report lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.report.mockResolvedValue({
      id: 'report-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      status: 'GENERATING',
      updatedAt: new Date('2026-08-11T12:00:00Z'),
      generatedAt: null,
      publishedAt: null,
      answerCount: 0,
      sessionCount: 0,
      error: null,
    })
    mocks.configuration.mockResolvedValue(null)
    mocks.dispatch.mockResolvedValue({ status: 'PENDING' })
    mocks.jobs.mockResolvedValue([])
    mocks.audits.mockResolvedValue([])
  })
  it.each([
    [{ reportStatus: 'GENERATING', dispatchStatus: 'PENDING', jobStatus: null }, 'QUEUED'],
    [{ reportStatus: 'GENERATING', dispatchStatus: 'CONSUMED', jobStatus: 'RUNNING' }, 'RUNNING'],
    [{ reportStatus: 'DRAFT', dispatchStatus: 'CONSUMED', jobStatus: 'COMPLETE' }, 'REVIEW'],
    [{ reportStatus: 'PUBLISHED', dispatchStatus: 'CONSUMED', jobStatus: 'COMPLETE' }, 'PUBLISHED'],
    [{ reportStatus: 'FAILED', dispatchStatus: 'CONSUMED', jobStatus: 'FAILED' }, 'FAILED'],
  ] as const)('maps %o to %s', (input, expected) =>
    expect(simpleWeeklyReportStatus(input)).toBe(expected),
  )
  it('returns default-off, versioned, exactly scoped evidence without raw payload/content', async () => {
    const result = await caller().admin.getWeeklyReportLifecycle({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      reportId: 'report-1',
    })
    expect(result).toMatchObject({
      status: 'QUEUED',
      executionEnabled: false,
      version: '2026-08-11T12:00:00.000Z',
      scope: { tenantId: 'tenant-1', venueId: 'venue-1', reportId: 'report-1' },
    })
    expect(mocks.report).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'report-1', tenantId: 'tenant-1', venueId: 'venue-1' },
        select: expect.not.objectContaining({ content: expect.anything() }),
      }),
    )
    expect(mocks.jobs).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          payload: { path: ['reportId'], equals: 'report-1' },
        }),
        select: expect.not.objectContaining({ payload: expect.anything() }),
      }),
    )
  })
  it('rejects non-admin access before evidence reads', async () => {
    await expect(
      caller(false).admin.getWeeklyReportLifecycle({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        reportId: 'report-1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
  })
})
