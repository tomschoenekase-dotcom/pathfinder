import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  venue: vi.fn(),
  places: vi.fn(),
  knowledge: vi.fn(),
  createPlace: vi.fn(),
  updatePlace: vi.fn(),
  retirePlace: vi.fn(),
  createKnowledge: vi.fn(),
  updateKnowledge: vi.fn(),
  retireKnowledge: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  LegacyContentActionError: class LegacyContentActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  withTenantIsolationBypass: mocks.bypass,
  createLegacyPlaceAction: mocks.createPlace,
  updateLegacyPlaceAction: mocks.updatePlace,
  retireLegacyPlaceAction: mocks.retirePlace,
  createLegacyKnowledgeAction: mocks.createKnowledge,
  updateLegacyKnowledgeAction: mocks.updateKnowledge,
  retireLegacyKnowledgeAction: mocks.retireKnowledge,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminLegacyContentRouter } from './legacy-content'

const testRouter = router({ admin: adminLegacyContentRouter })
const db = {
  venue: { findFirst: mocks.venue },
  place: { findMany: mocks.places },
  venueKnowledgeEntry: { findMany: mocks.knowledge },
} as unknown as TRPCContext['db']

function context(admin = true): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: {
      userId: 'platform_admin_1',
      activeTenantId: 'attacker_tenant',
      role: 'STAFF',
      isPlatformAdmin: admin,
    },
  }
}

describe('admin legacy compatibility content', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.venue.mockResolvedValue({
      id: 'venue_1',
      name: 'Museum',
      slug: 'museum',
      tenant: { id: 'tenant_1', name: 'Client' },
    })
    mocks.places.mockResolvedValue([])
    mocks.knowledge.mockResolvedValue([])
  })

  it('rejects non-platform-admin access before any isolation bypass', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.listLegacyContent({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
  })

  it('lists only the exact requested tenant and venue with explicit compatibility selects', async () => {
    await testRouter.createCaller(context()).admin.listLegacyContent({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
    })
    expect(mocks.venue).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'venue_1', tenantId: 'tenant_1' } }),
    )
    expect(mocks.places).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', venueId: 'venue_1' },
        select: expect.not.objectContaining({ tenantId: expect.anything() }),
      }),
    )
    expect(mocks.knowledge).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant_1', venueId: 'venue_1' } }),
    )
  })

  it('fails a cross-tenant venue before reading compatibility records', async () => {
    mocks.venue.mockResolvedValueOnce(null)
    await expect(
      testRouter.createCaller(context()).admin.listLegacyContent({
        tenantId: 'victim_tenant',
        venueId: 'venue_1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.places).not.toHaveBeenCalled()
    expect(mocks.knowledge).not.toHaveBeenCalled()
  })

  it('passes exact scope, CAS revision, and platform-admin human actor to canonical actions', async () => {
    mocks.updatePlace.mockResolvedValue({ id: 'place_1' })
    const expectedUpdatedAt = new Date('2026-08-11T14:30:00.000Z')
    await testRouter.createCaller(context()).admin.updateLegacyPlace({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      id: 'place_1',
      expectedUpdatedAt,
      fields: { name: 'Updated' },
    })
    expect(mocks.updatePlace).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        id: 'place_1',
        expectedUpdatedAt,
        fields: { name: 'Updated' },
        actor: { type: 'HUMAN', id: 'platform_admin_1', role: 'PLATFORM_ADMIN' },
      },
      db,
    )
  })
})
