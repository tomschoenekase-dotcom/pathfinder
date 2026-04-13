import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock embeddings so the OpenAI client and env schema are never loaded in tests
vi.mock('../lib/embeddings', () => ({ embedPlace: vi.fn().mockResolvedValue(undefined) }))

import { router } from '../core'
import type { TRPCContext } from '../context'
import { placeRouter } from './place'

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const venueFindFirst = vi.fn()
const placeFindMany = vi.fn()
const placeFindFirst = vi.fn()
const placeCreate = vi.fn()
const placeUpdateMany = vi.fn()
const placeDeleteMany = vi.fn()
const dbTransaction = vi.fn()

const mockDb = {
  venue: { findFirst: venueFindFirst },
  place: {
    findMany: placeFindMany,
    findFirst: placeFindFirst,
    create: placeCreate,
    updateMany: placeUpdateMany,
    deleteMany: placeDeleteMany,
  },
  $transaction: dbTransaction,
} as unknown as TRPCContext['db']

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

const baseCtx = { db: mockDb, headers: new Headers() }

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

const testRouter = router({ place: placeRouter })

const VENUE_ID = 'cvenueabc123456789012'
const PLACE_ID = 'cplace123456789012345'

const placeRow = {
  id: PLACE_ID,
  tenantId: 'tenant_1',
  venueId: VENUE_ID,
  name: 'Elephant Enclosure',
  type: 'attraction',
  shortDescription: null,
  longDescription: null,
  lat: 40.7128,
  lng: -74.006,
  tags: [],
  importanceScore: 10,
  areaName: null,
  hours: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const placeInput = {
  venueId: VENUE_ID,
  name: 'Elephant Enclosure',
  type: 'attraction',
  lat: 40.7128,
  lng: -74.006,
  tags: [],
  importanceScore: 10,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('place router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  // --- place.list ---

  it('place.list returns places for a valid venue', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: VENUE_ID }) // venue belongs to tenant
    placeFindMany.mockResolvedValueOnce([placeRow])

    const caller = testRouter.createCaller(staffCtx())
    const result = await caller.place.list({ venueId: VENUE_ID })

    expect(result).toEqual([placeRow])
    expect(placeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant_1', venueId: VENUE_ID } }),
    )
  })

  it('place.list returns empty array for venue with no places', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: VENUE_ID })
    placeFindMany.mockResolvedValueOnce([])

    const caller = testRouter.createCaller(staffCtx())
    const result = await caller.place.list({ venueId: VENUE_ID })

    expect(result).toEqual([])
  })

  it('place.list throws NOT_FOUND when venueId belongs to different tenant', async () => {
    venueFindFirst.mockResolvedValueOnce(null) // venue not found for this tenant

    const caller = testRouter.createCaller(staffCtx())

    await expect(caller.place.list({ venueId: VENUE_ID })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })

  // --- place.getById ---

  it('place.getById returns place detail', async () => {
    placeFindFirst.mockResolvedValueOnce(placeRow)

    const caller = testRouter.createCaller(staffCtx())
    const result = await caller.place.getById({ id: PLACE_ID })

    expect(result).toEqual(placeRow)
  })

  it('place.getById throws NOT_FOUND for wrong tenant', async () => {
    placeFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(staffCtx())

    await expect(caller.place.getById({ id: PLACE_ID })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })

  // --- place.create ---

  it('place.create with MANAGER role creates place', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: VENUE_ID })
    placeCreate.mockResolvedValueOnce(placeRow)

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.place.create(placeInput)

    expect(result).toEqual(placeRow)
    expect(placeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant_1', venueId: VENUE_ID }),
      }),
    )
  })

  it('place.create throws NOT_FOUND when venueId belongs to different tenant', async () => {
    venueFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(managerCtx())

    await expect(caller.place.create(placeInput)).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })

  it('place.create with STAFF role throws FORBIDDEN', async () => {
    const caller = testRouter.createCaller(staffCtx())

    await expect(caller.place.create(placeInput)).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }),
    )
  })

  // --- place.update ---

  it('place.update with MANAGER role updates place', async () => {
    placeFindFirst
      .mockResolvedValueOnce(placeRow) // ownership check
      .mockResolvedValueOnce({ ...placeRow, name: 'Updated' }) // return updated row
    placeUpdateMany.mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.place.update({ id: PLACE_ID, name: 'Updated' })

    expect(result).toMatchObject({ name: 'Updated' })
    expect(placeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant_1' }) }),
    )
  })

  it('place.update accepts lat/lng of 0 (valid coordinate)', async () => {
    placeFindFirst
      .mockResolvedValueOnce(placeRow) // ownership check
      .mockResolvedValueOnce({ ...placeRow, lat: 0, lng: 0 }) // return updated row
    placeUpdateMany.mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.place.update({ id: PLACE_ID, lat: 0, lng: 0 })

    expect(placeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lat: 0, lng: 0 }),
      }),
    )
    expect(result).toMatchObject({ lat: 0, lng: 0 })
  })

  it('place.update throws NOT_FOUND for wrong tenant', async () => {
    placeFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(managerCtx())

    await expect(caller.place.update({ id: PLACE_ID, name: 'X' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })

  it('place.update with STAFF role throws FORBIDDEN', async () => {
    const caller = testRouter.createCaller(staffCtx())

    await expect(caller.place.update({ id: PLACE_ID, name: 'X' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }),
    )
  })

  // --- place.delete ---

  it('place.delete with OWNER role deletes place', async () => {
    placeFindFirst.mockResolvedValueOnce(placeRow)
    placeDeleteMany.mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(ownerCtx())
    const result = await caller.place.delete({ id: PLACE_ID })

    expect(result).toEqual({ id: PLACE_ID })
    expect(placeDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant_1' }) }),
    )
  })

  it('place.delete with MANAGER role throws FORBIDDEN', async () => {
    const caller = testRouter.createCaller(managerCtx())

    await expect(caller.place.delete({ id: PLACE_ID })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }),
    )
  })

  // --- place.bulkCreate ---

  it('place.bulkCreate creates all places in a transaction', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: VENUE_ID })
    dbTransaction.mockResolvedValueOnce([placeRow, placeRow])

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.place.bulkCreate({
      venueId: VENUE_ID,
      places: [
        { name: 'A', type: 'attraction', lat: 1, lng: 1, tags: [], importanceScore: 0 },
        { name: 'B', type: 'amenity', lat: 2, lng: 2, tags: [], importanceScore: 0 },
      ],
    })

    expect(result.count).toBe(2)
    expect(dbTransaction).toHaveBeenCalled()
  })

  it('place.bulkCreate throws BAD_REQUEST when over 500 places', async () => {
    const caller = testRouter.createCaller(managerCtx())

    const places = Array.from({ length: 501 }, (_, i) => ({
      name: `Place ${i}`,
      type: 'attraction',
      lat: 0,
      lng: 0,
      tags: [] as string[],
      importanceScore: 0,
    }))

    await expect(caller.place.bulkCreate({ venueId: VENUE_ID, places })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }),
    )

    // Venue lookup and transaction should not have been called
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(dbTransaction).not.toHaveBeenCalled()
  })

  it('place.bulkCreate throws NOT_FOUND when venueId belongs to different tenant', async () => {
    venueFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(managerCtx())

    await expect(
      caller.place.bulkCreate({
        venueId: VENUE_ID,
        places: [{ name: 'A', type: 'attraction', lat: 1, lng: 1, tags: [], importanceScore: 0 }],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
  })

  it('place.bulkCreate with STAFF role throws FORBIDDEN', async () => {
    const caller = testRouter.createCaller(staffCtx())

    await expect(
      caller.place.bulkCreate({ venueId: VENUE_ID, places: [] }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
  })
})
