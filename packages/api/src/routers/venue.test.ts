import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { venueRouter } from './venue'

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const venueFindMany = vi.fn()
const venueFindFirst = vi.fn()
const venueCreate = vi.fn()
const venueUpdateMany = vi.fn()
const venueDeleteMany = vi.fn()
const dbQueryRaw = vi.fn()

const mockDb = {
  venue: {
    findMany: venueFindMany,
    findFirst: venueFindFirst,
    create: venueCreate,
    updateMany: venueUpdateMany,
    deleteMany: venueDeleteMany,
  },
  $queryRaw: dbQueryRaw,
} as unknown as TRPCContext['db']

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

const baseCtx = {
  db: mockDb,
  headers: new Headers(),
}

function ownerCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: { userId: 'user_1', activeTenantId: 'tenant_1', role: 'OWNER', isPlatformAdmin: false },
  }
}

function managerCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: { userId: 'user_1', activeTenantId: 'tenant_1', role: 'MANAGER', isPlatformAdmin: false },
  }
}

function staffCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: { userId: 'user_1', activeTenantId: 'tenant_1', role: 'STAFF', isPlatformAdmin: false },
  }
}

const testRouter = router({ venue: venueRouter })

const venueRow = {
  id: 'cuid1234567890abcdef',
  tenantId: 'tenant_1',
  name: 'City Zoo',
  slug: 'city-zoo',
  description: null,
  category: null,
  defaultCenterLat: null,
  defaultCenterLng: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('venue router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  // --- venue.list ---

  it('venue.list returns venues for active tenant', async () => {
    venueFindMany.mockResolvedValueOnce([venueRow])

    const caller = testRouter.createCaller(staffCtx())
    const result = await caller.venue.list()

    expect(result).toEqual([venueRow])
    expect(venueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant_1' } }),
    )
  })

  // --- venue.getById ---

  it('venue.getBySlug returns active public venue details', async () => {
    dbQueryRaw.mockResolvedValueOnce([{
      id: 'cuid1234567890abcdef',
      name: 'City Zoo',
      description: 'A great day out.',
      category: 'zoo',
      defaultCenterLat: 39.7684,
      defaultCenterLng: -86.1581,
    }])

    const caller = testRouter.createCaller({
      ...baseCtx,
      session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
    })

    const result = await caller.venue.getBySlug({ slug: 'city-zoo' })

    expect(result).toEqual({
      id: 'cuid1234567890abcdef',
      name: 'City Zoo',
      description: 'A great day out.',
      category: 'zoo',
      defaultCenterLat: 39.7684,
      defaultCenterLng: -86.1581,
    })
    expect(dbQueryRaw).toHaveBeenCalled()
  })

  it('venue.getBySlug throws NOT_FOUND when slug is missing', async () => {
    dbQueryRaw.mockResolvedValueOnce([])

    const caller = testRouter.createCaller({
      ...baseCtx,
      session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
    })

    await expect(caller.venue.getBySlug({ slug: 'missing-slug' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })

  it('venue.getById returns venue with place count', async () => {
    venueFindFirst.mockResolvedValueOnce({ ...venueRow, _count: { places: 3 } })

    const caller = testRouter.createCaller(staffCtx())
    const result = await caller.venue.getById({ id: 'cuid1234567890abcdef' })

    expect(result).toMatchObject({ id: 'cuid1234567890abcdef', _count: { places: 3 } })
  })

  it('venue.getById throws NOT_FOUND for wrong tenant', async () => {
    venueFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(staffCtx())

    await expect(caller.venue.getById({ id: 'cuid1234567890abcdef' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })

  // --- venue.create ---

  it('venue.create with OWNER role creates venue and auto-generates slug', async () => {
    venueFindFirst.mockResolvedValueOnce(null) // slug uniqueness check — no collision
    venueCreate.mockResolvedValueOnce(venueRow)

    const caller = testRouter.createCaller(ownerCtx())
    const result = await caller.venue.create({ name: 'City Zoo' })

    expect(result).toMatchObject({ name: 'City Zoo' })
    expect(venueCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: 'city-zoo', tenantId: 'tenant_1' }),
      }),
    )
  })

  it('venue.create with MANAGER role throws FORBIDDEN', async () => {
    const caller = testRouter.createCaller(managerCtx())

    await expect(caller.venue.create({ name: 'City Zoo' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }),
    )
  })

  it('venue.create with STAFF role throws FORBIDDEN', async () => {
    const caller = testRouter.createCaller(staffCtx())

    await expect(caller.venue.create({ name: 'City Zoo' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }),
    )
  })

  it('venue.create appends suffix on slug collision', async () => {
    // First call: collision; second call: free
    venueFindFirst
      .mockResolvedValueOnce({ id: 'other' }) // slug 'city-zoo' taken
      .mockResolvedValueOnce(null) // slug 'city-zoo-2' free
    venueCreate.mockResolvedValueOnce({ ...venueRow, slug: 'city-zoo-2' })

    const caller = testRouter.createCaller(ownerCtx())
    await caller.venue.create({ name: 'City Zoo' })

    expect(venueCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: 'city-zoo-2' }),
      }),
    )
  })

  // --- venue.update ---

  it('venue.update with MANAGER role updates venue', async () => {
    venueFindFirst
      .mockResolvedValueOnce(venueRow) // ownership check
      .mockResolvedValueOnce({ ...venueRow, name: 'Updated Zoo' }) // return updated row
    venueUpdateMany.mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.venue.update({ id: 'cuid1234567890abcdef', name: 'Updated Zoo' })

    expect(result).toMatchObject({ name: 'Updated Zoo' })
    expect(venueUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant_1' }) }),
    )
  })

  it('venue.update throws NOT_FOUND for wrong tenant', async () => {
    venueFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(managerCtx())

    await expect(
      caller.venue.update({ id: 'cuid1234567890abcdef', name: 'X' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
  })

  it('venue.update with STAFF role throws FORBIDDEN', async () => {
    const caller = testRouter.createCaller(staffCtx())

    await expect(
      caller.venue.update({ id: 'cuid1234567890abcdef', name: 'X' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
  })

  // --- venue.delete ---

  it('venue.delete removes venue with no places', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'cuid1234567890abcdef', _count: { places: 0 } })
    venueDeleteMany.mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(ownerCtx())
    const result = await caller.venue.delete({ id: 'cuid1234567890abcdef' })

    expect(result).toEqual({ id: 'cuid1234567890abcdef' })
    expect(venueDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant_1' }) }),
    )
  })

  it('venue.delete throws BAD_REQUEST when venue has places', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'cuid1234567890abcdef', _count: { places: 5 } })

    const caller = testRouter.createCaller(ownerCtx())

    await expect(caller.venue.delete({ id: 'cuid1234567890abcdef' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }),
    )
  })

  it('venue.delete with MANAGER role throws FORBIDDEN', async () => {
    const caller = testRouter.createCaller(managerCtx())

    await expect(caller.venue.delete({ id: 'cuid1234567890abcdef' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }),
    )
  })
})
