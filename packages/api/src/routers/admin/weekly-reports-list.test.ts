import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  venue: vi.fn(),
  reports: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    venue: { findFirst: mocks.venue },
    weeklyReport: { findMany: mocks.reports },
  },
  withTenantIsolationBypass: mocks.bypass,
  lockVenueReportMutation: vi.fn(),
  publishWeeklyReportAction: vi.fn(),
  updateWeeklyReportDraftAction: vi.fn(),
  WeeklyReportActionError: class WeeklyReportActionError extends Error {},
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueGenerationDispatchKick: vi.fn() }))
vi.mock('../../lib/venue-report-configuration', () => ({
  findVenueReportConfiguration: vi.fn(),
}))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminWeeklyReportsRouter } from './weekly-reports'

const call = (isPlatformAdmin = true) =>
  router({ admin: adminWeeklyReportsRouter }).createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator-1',
      activeTenantId: null,
      role: 'STAFF',
      isPlatformAdmin,
    },
  })

const report = (id: string, weekStart: string) => ({
  id,
  weekStart: new Date(weekStart),
  weekEnd: new Date('2026-08-10T23:59:59.999Z'),
  status: 'FAILED' as const,
  title: 'Weekly report',
  publishedAt: null,
  updatedAt: new Date('2026-08-11T00:00:00.000Z'),
})

describe('admin weekly report list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.venue.mockResolvedValue({ id: 'venue-1' })
    mocks.reports.mockResolvedValue([])
  })

  it('rejects non-admin callers before the bypass', async () => {
    await expect(
      call(false).admin.listWeeklyReports({ tenantId: 'tenant-1', venueId: 'venue-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
  })

  it('fails closed when the venue is outside the exact tenant scope', async () => {
    mocks.venue.mockResolvedValue(null)
    await expect(
      call().admin.listWeeklyReports({ tenantId: 'tenant-1', venueId: 'venue-1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.reports).not.toHaveBeenCalled()
  })

  it('uses a bounded stable tuple cursor and omits report content', async () => {
    mocks.reports.mockResolvedValue([
      report('report-3', '2026-08-04T00:00:00.000Z'),
      report('report-2', '2026-07-28T00:00:00.000Z'),
      report('report-1', '2026-07-21T00:00:00.000Z'),
    ])
    const result = await call().admin.listWeeklyReports({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      limit: 2,
      cursorWeekStart: '2026-08-11T00:00:00.000Z',
      cursorId: 'report-4',
    })
    expect(mocks.reports).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        OR: [
          { weekStart: { lt: new Date('2026-08-11T00:00:00.000Z') } },
          {
            weekStart: new Date('2026-08-11T00:00:00.000Z'),
            id: { lt: 'report-4' },
          },
        ],
      },
      orderBy: [{ weekStart: 'desc' }, { id: 'desc' }],
      take: 3,
      select: {
        id: true,
        weekStart: true,
        weekEnd: true,
        status: true,
        title: true,
        publishedAt: true,
        updatedAt: true,
      },
    })
    expect(result.items).toHaveLength(2)
    expect(result.nextCursor).toEqual({
      weekStart: '2026-07-28T00:00:00.000Z',
      id: 'report-2',
    })
    expect(JSON.stringify(result)).not.toContain('content')
    expect(JSON.stringify(result)).not.toContain('error')
  })

  it('rejects half cursors before querying', async () => {
    await expect(
      call().admin.listWeeklyReports({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        cursorId: 'report-1',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.venue).not.toHaveBeenCalled()
  })
})
