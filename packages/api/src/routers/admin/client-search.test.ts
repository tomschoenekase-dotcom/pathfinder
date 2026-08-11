import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  tenant: vi.fn(),
  venue: vi.fn(),
  content: vi.fn(),
  support: vi.fn(),
  agents: vi.fn(),
  jobs: vi.fn(),
  packages: vi.fn(),
  evaluations: vi.fn(),
}))
vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: mocks.bypass,
  db: {
    tenant: { findMany: mocks.tenant },
    venue: { findMany: mocks.venue },
    contentModuleRevision: { findMany: mocks.content },
    supportRequest: { findMany: mocks.support },
    agentRun: { findMany: mocks.agents },
    jobRecord: { findMany: mocks.jobs },
    venuePackage: { findMany: mocks.packages },
    evalRun: { findMany: mocks.evaluations },
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminClientSearchRouter } from './client-search'

const caller = (admin = true) =>
  router({ admin: adminClientSearchRouter }).createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'operator', activeTenantId: null, role: 'STAFF', isPlatformAdmin: admin },
  })
const date = new Date('2026-08-11T12:00:00Z')

describe('admin OS search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const mock of [
      mocks.tenant,
      mocks.venue,
      mocks.content,
      mocks.support,
      mocks.agents,
      mocks.jobs,
      mocks.packages,
      mocks.evaluations,
    ])
      mock.mockResolvedValue([])
  })
  it('rejects non-admin access before the bypass', async () => {
    await expect(caller(false).admin.searchAdminOs({ query: 'museum' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(mocks.bypass).not.toHaveBeenCalled()
  })
  it('returns grouped exact-scope routes and omits raw/sensitive fields', async () => {
    mocks.venue.mockResolvedValue([
      {
        id: 'v1',
        tenantId: 't1',
        name: 'Museum',
        slug: 'museum',
        category: 'ART',
        isActive: true,
        createdAt: date,
      },
    ])
    mocks.support.mockResolvedValue([
      {
        id: 's1',
        tenantId: 't1',
        venueId: 'v1',
        subject: 'Museum hours',
        category: 'CONTENT_CORRECTION',
        status: 'OPEN',
        createdAt: date,
      },
    ])
    const result = await caller().admin.searchAdminOs({ query: 'museum', limitPerGroup: 2 })
    expect(result.groups.find((group) => group.name === 'venues')?.items[0]).toMatchObject({
      tenantId: 't1',
      venueId: 'v1',
      route: '/admin/clients/t1/venues/v1',
    })
    expect(result.groups.find((group) => group.name === 'support')?.items[0]?.route).toBe(
      '/admin/clients/t1/venues/v1/support-operations',
    )
    expect(mocks.content).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        select: expect.not.objectContaining({
          evidence: expect.anything(),
          createdBy: expect.anything(),
        }),
      }),
    )
    expect(mocks.jobs).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ payload: expect.anything() }),
      }),
    )
    expect(mocks.packages).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({
          payload: expect.anything(),
          validationReport: expect.anything(),
        }),
      }),
    )
  })
  it('supports bounded pagination of one group without querying others', async () => {
    mocks.tenant.mockResolvedValue([
      { id: 't2', name: 'Two', slug: 'two', status: 'ACTIVE', createdAt: date },
      { id: 't1', name: 'One', slug: 'one', status: 'ACTIVE', createdAt: date },
    ])
    const result = await caller().admin.searchAdminOs({
      query: 'o',
      group: 'clients',
      limitPerGroup: 1,
    })
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]?.nextCursor).toEqual({ createdAt: date.toISOString(), id: 't2' })
    expect(mocks.tenant).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }))
    expect(mocks.venue).not.toHaveBeenCalled()
  })
})
