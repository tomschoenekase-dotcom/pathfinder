import { describe, expect, it, vi } from 'vitest'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { portalRouter } from './portal'

const venueFindMany = vi.fn()
const intakeGroupBy = vi.fn()
const mediaGroupBy = vi.fn()
const packageGroupBy = vi.fn()
const packageFindMany = vi.fn()
const historyFindMany = vi.fn()
const offboardingFindMany = vi.fn()

const app = router({ portal: portalRouter })
const ctx = {
  db: {
    $transaction: vi.fn(async (callback: (db: unknown) => unknown) => callback(ctx.db)),
    venue: { findMany: venueFindMany },
    intakeRun: { groupBy: intakeGroupBy },
    mediaIngestionProject: { groupBy: mediaGroupBy },
    venuePackage: { groupBy: packageGroupBy, findMany: packageFindMany },
    contentVersion: { findMany: historyFindMany },
    offboardingVenueTarget: { findMany: offboardingFindMany },
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
