import { describe, expect, it, vi } from 'vitest'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { portalRouter } from './portal'

const venueFindMany = vi.fn()
const venueFindFirst = vi.fn()
const intakeGroupBy = vi.fn()
const intakeCount = vi.fn()
const uploadCount = vi.fn()
const mediaGroupBy = vi.fn()
const packageGroupBy = vi.fn()
const packageFindMany = vi.fn()
const historyFindMany = vi.fn()
const offboardingFindMany = vi.fn()
const supportFindMany = vi.fn()
const reportConfigurationFindFirst = vi.fn()
const weeklyReportFindFirst = vi.fn()
const visitorSessionCount = vi.fn()
const messageFeedbackGroupBy = vi.fn()

const app = router({ portal: portalRouter })
const ctx = {
  db: {
    $transaction: vi.fn(async (callback: (db: unknown) => unknown) => callback(ctx.db)),
    venue: { findMany: venueFindMany, findFirst: venueFindFirst },
    intakeRun: { groupBy: intakeGroupBy, count: intakeCount },
    intakeUpload: { count: uploadCount },
    mediaIngestionProject: { groupBy: mediaGroupBy },
    venuePackage: { groupBy: packageGroupBy, findMany: packageFindMany },
    contentVersion: { findMany: historyFindMany },
    offboardingVenueTarget: { findMany: offboardingFindMany },
    supportRequest: { findMany: supportFindMany },
    venueReportConfiguration: { findFirst: reportConfigurationFindFirst },
    weeklyReport: { findFirst: weeklyReportFindFirst },
    visitorSession: { count: visitorSessionCount },
    messageFeedback: { groupBy: messageFeedbackGroupBy },
  } as unknown as TRPCContext['db'],
  headers: new Headers(),
  session: {
    userId: 'user-1',
    activeTenantId: 'tenant-1',
    role: 'STAFF' as const,
    isPlatformAdmin: false,
  },
}

describe('client portal lifecycle read model', () => {
  it('returns only exact-ACL, bounded client task evidence without request bodies or internals', async () => {
    venueFindFirst.mockResolvedValue({ id: 'venue-1' })
    supportFindMany.mockResolvedValue([
      {
        id: 'request-1',
        subject: 'Updated admission details',
        missingInformation: ['Current price', 'Effective date', 'Source link'],
      },
      {
        id: 'request-2',
        subject: 'Entrance accessibility',
        missingInformation: ['Ramp dimensions'],
      },
    ])
    intakeCount.mockResolvedValue(1)
    uploadCount.mockResolvedValue(2)
    reportConfigurationFindFirst.mockResolvedValue({ id: 'configuration-1' })
    weeklyReportFindFirst.mockResolvedValue({
      id: 'report-1',
      title: 'July review',
      publishedAt: new Date('2026-08-01T12:00:00.000Z'),
    })

    const result = await app.createCaller(ctx).portal.getVenueTaskEvidence({ venueId: 'venue-1' })

    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue-1', tenantId: 'tenant-1' },
      select: { id: true },
    })
    expect(supportFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          OR: expect.arrayContaining([
            expect.objectContaining({
              createdByKind: 'CLIENT',
              requesterUserId: 'user-1',
            }),
            expect.objectContaining({ participants: expect.any(Object) }),
          ]),
        }),
        take: 4,
        select: { id: true, subject: true, missingInformation: true },
      }),
    )
    expect(result).toEqual({
      missingInformation: [
        {
          requestId: 'request-1',
          subject: 'Updated admission details',
          items: ['Current price', 'Effective date', 'Source link'],
          additionalItemCount: 0,
        },
        {
          requestId: 'request-2',
          subject: 'Entrance accessibility',
          items: ['Ramp dimensions'],
          additionalItemCount: 0,
        },
      ],
      additionalMissingRequest: false,
      hasSharedInformation: true,
      latestReport: {
        id: 'report-1',
        title: 'July review',
        publishedAt: new Date('2026-08-01T12:00:00.000Z'),
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/body|participant|requester|package|hash|status/iu)
  })

  it('fails nondisclosingly before task reads for a missing or cross-tenant venue', async () => {
    venueFindFirst.mockResolvedValue(null)
    supportFindMany.mockClear()
    intakeCount.mockClear()
    uploadCount.mockClear()

    await expect(
      app.createCaller(ctx).portal.getVenueTaskEvidence({ venueId: 'foreign-venue' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(supportFindMany).not.toHaveBeenCalled()
    expect(intakeCount).not.toHaveBeenCalled()
    expect(uploadCount).not.toHaveBeenCalled()
  })

  it('returns a venue-scoped aggregate visitor pulse without conversation or identity data', async () => {
    venueFindFirst.mockResolvedValue({ id: 'venue-1' })
    visitorSessionCount.mockResolvedValue(12)
    messageFeedbackGroupBy.mockResolvedValue([
      { rating: 'HELPFUL', _count: { _all: 7 } },
      { rating: 'NOT_HELPFUL', _count: { _all: 2 } },
    ])

    const result = await app.createCaller(ctx).portal.getVenueVisitorPulse({ venueId: 'venue-1' })

    expect(visitorSessionCount).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        experienceScope: 'PUBLIC',
        startedAt: { gte: expect.any(Date) },
      },
    })
    expect(messageFeedbackGroupBy).toHaveBeenCalledWith({
      by: ['rating'],
      where: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        createdAt: { gte: expect.any(Date) },
      },
      _count: { _all: true },
    })
    expect(result).toEqual({
      windowDays: 30,
      conversationCount: 12,
      feedback: { helpful: 7, notHelpful: 2 },
    })
    expect(JSON.stringify(result)).not.toMatch(/message|identity|location|transcript|reason/iu)
  })

  it('fails closed before visitor pulse aggregation for a missing or cross-tenant venue', async () => {
    venueFindFirst.mockResolvedValue(null)
    visitorSessionCount.mockClear()
    messageFeedbackGroupBy.mockClear()

    await expect(
      app.createCaller(ctx).portal.getVenueVisitorPulse({ venueId: 'foreign-venue' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(visitorSessionCount).not.toHaveBeenCalled()
    expect(messageFeedbackGroupBy).not.toHaveBeenCalled()
  })

  it('bounds missing-information evidence and keeps reports fail-closed when disabled', async () => {
    venueFindFirst.mockResolvedValue({ id: 'venue-1' })
    supportFindMany.mockResolvedValue(
      Array.from({ length: 4 }, (_, index) => ({
        id: `request-${index}`,
        subject: `Question ${index}`,
        missingInformation: Array.from({ length: 7 }, (_item, item) => `Detail ${index}-${item}`),
      })),
    )
    intakeCount.mockResolvedValue(0)
    uploadCount.mockResolvedValue(0)
    reportConfigurationFindFirst.mockResolvedValue(null)
    weeklyReportFindFirst.mockClear()

    const result = await app.createCaller(ctx).portal.getVenueTaskEvidence({ venueId: 'venue-1' })

    expect(result.missingInformation).toHaveLength(3)
    expect(result.missingInformation[0]).toMatchObject({
      items: ['Detail 0-0', 'Detail 0-1', 'Detail 0-2', 'Detail 0-3', 'Detail 0-4'],
      additionalItemCount: 2,
    })
    expect(result.additionalMissingRequest).toBe(true)
    expect(result.hasSharedInformation).toBe(false)
    expect(result.latestReport).toBeNull()
    expect(weeklyReportFindFirst).not.toHaveBeenCalled()
  })

  it('uses UNAVAILABLE rather than false staleness when CLIENT_PREVIEW has no eligible candidate', async () => {
    venueFindMany.mockResolvedValue([
      {
        id: 'venue-1',
        name: 'Museum',
        isActive: false,
        _count: { places: 0, knowledgeEntries: 0 },
      },
    ])
    intakeGroupBy.mockResolvedValue([])
    mediaGroupBy.mockResolvedValue([])
    packageGroupBy.mockResolvedValue([
      { venueId: 'venue-1', status: 'APPROVED', _count: { _all: 1 } },
    ])
    packageFindMany.mockResolvedValue([])
    historyFindMany.mockResolvedValue([])
    offboardingFindMany.mockResolvedValue([])
    await expect(app.createCaller(ctx).portal.getVenueLifecycles()).resolves.toMatchObject([
      { lifecycle: { state: 'CLIENT_PREVIEW' }, clientPreview: { state: 'UNAVAILABLE', id: null } },
    ])
  })

  it('derives per-venue milestones with exact tenant filters and no internal evidence payload', async () => {
    venueFindMany.mockResolvedValue([
      { id: 'venue-1', name: 'Museum', isActive: true, _count: { places: 2, knowledgeEntries: 1 } },
      { id: 'venue-2', name: 'Park', isActive: false, _count: { places: 0, knowledgeEntries: 0 } },
    ])
    intakeGroupBy.mockResolvedValue([])
    mediaGroupBy.mockResolvedValue([
      { venueId: 'venue-2', status: 'ANALYZING', _count: { _all: 1 } },
    ])
    packageGroupBy.mockResolvedValue([])
    packageFindMany.mockResolvedValue([])
    historyFindMany.mockResolvedValue([])
    offboardingFindMany.mockResolvedValue([])

    const result = await app.createCaller(ctx).portal.getVenueLifecycles()
    expect(ctx.db.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    })
    expect(result.map(({ venueId, lifecycle }) => [venueId, lifecycle.state])).toEqual([
      ['venue-1', 'LIVE'],
      ['venue-2', 'PROCESSING'],
    ])
    expect(JSON.stringify(result)).not.toMatch(/ANALYZING|packageCounts|worker|analytics/iu)
    for (const call of [
      venueFindMany,
      intakeGroupBy,
      mediaGroupBy,
      packageGroupBy,
      historyFindMany,
      offboardingFindMany,
    ]) {
      expect(call.mock.calls[0]?.[0]).toMatchObject({ where: { tenantId: 'tenant-1' } })
    }
  })

  it('uses explicit offboarding evidence ahead of otherwise-live venue state', async () => {
    venueFindMany.mockResolvedValue([
      { id: 'venue-1', name: 'Museum', isActive: true, _count: { places: 1, knowledgeEntries: 0 } },
    ])
    intakeGroupBy.mockResolvedValue([])
    mediaGroupBy.mockResolvedValue([])
    packageGroupBy.mockResolvedValue([])
    packageFindMany.mockResolvedValue([])
    historyFindMany.mockResolvedValue([])
    offboardingFindMany.mockResolvedValue([{ venueId: 'venue-1' }])

    await expect(app.createCaller(ctx).portal.getVenueLifecycles()).resolves.toMatchObject([
      { lifecycle: { state: 'OFFBOARDING', clientActionRequired: false } },
    ])
  })
})
