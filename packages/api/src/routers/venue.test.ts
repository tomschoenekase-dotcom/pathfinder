import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { OPENAI_API_KEY: 'test-key' },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('@pathfinder/analytics', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@pathfinder/jobs', () => ({ enqueueEmbedPlace: vi.fn().mockResolvedValue(undefined) }))

import { enqueueEmbedPlace } from '@pathfinder/jobs'

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
const placeCreate = vi.fn()
const knowledgeEntryCreate = vi.fn()
const dbQueryRaw = vi.fn()
const dbTransaction = vi.fn()

const mockDb = {
  venue: {
    findMany: venueFindMany,
    findFirst: venueFindFirst,
    create: venueCreate,
    updateMany: venueUpdateMany,
    deleteMany: venueDeleteMany,
  },
  place: { create: placeCreate },
  venueKnowledgeEntry: { create: knowledgeEntryCreate },
  $queryRaw: dbQueryRaw,
  $transaction: dbTransaction,
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
    session: {
      userId: 'user_1',
      activeTenantId: 'tenant_1',
      role: 'OWNER',
      isPlatformAdmin: false,
    },
  }
}

function managerCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_1',
      activeTenantId: 'tenant_1',
      role: 'MANAGER',
      isPlatformAdmin: false,
    },
  }
}

function staffCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_1',
      activeTenantId: 'tenant_1',
      role: 'STAFF',
      isPlatformAdmin: false,
    },
  }
}

const testRouter = router({ venue: venueRouter })
const enqueueEmbedPlaceMock = vi.mocked(enqueueEmbedPlace)

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
    dbQueryRaw.mockResolvedValueOnce([
      {
        id: 'cuid1234567890abcdef',
        name: 'City Zoo',
        description: 'A great day out.',
        category: 'zoo',
        defaultCenterLat: 39.7684,
        defaultCenterLng: -86.1581,
        aiGuideName: null,
        chatTheme: 'default',
        chatAccentColor: null,
        chatLogoUrl: null,
        chatBannerUrl: null,
      },
    ])

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
      aiGuideName: null,
      chatTheme: 'default',
      chatAccentColor: null,
      chatLogoUrl: null,
      chatBannerUrl: null,
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

  // --- venue.importContent ---

  it('venue.importContent creates places and knowledge in one transaction', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: venueRow.id, guideMode: 'location_aware' })
    placeCreate.mockReturnValueOnce(Promise.resolve({ id: 'place_1' }))
    knowledgeEntryCreate.mockReturnValueOnce(Promise.resolve({ id: 'knowledge_1' }))
    dbTransaction.mockResolvedValueOnce([{ id: 'place_1' }, { id: 'knowledge_1' }])

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.venue.importContent({
      venueId: venueRow.id,
      places: [{ name: 'Lobby', type: 'room', lat: 39.7, lng: -86.1 }],
      knowledgeEntries: [{ title: 'Policy', category: 'FAQ', content: 'Details' }],
    })

    expect(result).toEqual({ placeCount: 1, knowledgeEntryCount: 1 })
    expect(dbTransaction).toHaveBeenCalledOnce()
    expect(dbTransaction).toHaveBeenCalledWith([expect.any(Promise), expect.any(Promise)])
    expect(placeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: venueRow.id,
          name: 'Lobby',
        }),
      }),
    )
    expect(knowledgeEntryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: venueRow.id,
          title: 'Policy',
        }),
      }),
    )
  })

  it('venue.importContent propagates transaction failure without a partial result', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: venueRow.id, guideMode: 'non_location' })
    placeCreate.mockReturnValueOnce(Promise.resolve({ id: 'place_1' }))
    knowledgeEntryCreate.mockReturnValueOnce(Promise.resolve({ id: 'knowledge_1' }))
    dbTransaction.mockRejectedValueOnce(new Error('transaction failed'))

    const caller = testRouter.createCaller(managerCtx())
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        places: [{ name: 'Lobby', type: 'room' }],
        knowledgeEntries: [{ title: 'Policy', category: 'FAQ', content: 'Details' }],
      }),
    ).rejects.toThrow('transaction failed')
  })

  it('venue.importContent rejects a foreign venue before creating records', async () => {
    venueFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(managerCtx())
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        places: [],
        knowledgeEntries: [{ title: 'Policy', category: 'FAQ', content: 'Details' }],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
    expect(placeCreate).not.toHaveBeenCalled()
    expect(knowledgeEntryCreate).not.toHaveBeenCalled()
    expect(dbTransaction).not.toHaveBeenCalled()
  })

  it('venue.importContent enforces location-aware coordinates on the server', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: venueRow.id, guideMode: 'location_aware' })

    const caller = testRouter.createCaller(managerCtx())
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        places: [{ name: 'Lobby', type: 'room' }],
        knowledgeEntries: [],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    expect(dbTransaction).not.toHaveBeenCalled()
  })

  it('venue.importContent allows omitted coordinates for a non-location venue', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: venueRow.id, guideMode: 'non_location' })
    placeCreate.mockReturnValueOnce(Promise.resolve({ id: 'place_1' }))
    dbTransaction.mockResolvedValueOnce([{ id: 'place_1' }])

    const caller = testRouter.createCaller(managerCtx())
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        places: [{ name: 'Lobby', type: 'room' }],
        knowledgeEntries: [],
      }),
    ).resolves.toEqual({ placeCount: 1, knowledgeEntryCount: 0 })
  })

  it('venue.importContent rejects unpaired and out-of-range coordinates before database access', async () => {
    const caller = testRouter.createCaller(managerCtx())

    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        places: [{ name: 'Lobby', type: 'room', lat: 39.7 }],
        knowledgeEntries: [],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        places: [{ name: 'Lobby', type: 'room', lat: 91, lng: -86.1 }],
        knowledgeEntries: [],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    expect(venueFindFirst).not.toHaveBeenCalled()
  })

  it('venue.importContent rejects empty and oversized payloads before database access', async () => {
    const caller = testRouter.createCaller(managerCtx())

    await expect(
      caller.venue.importContent({ venueId: venueRow.id, places: [], knowledgeEntries: [] }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        places: Array.from({ length: 501 }, (_, index) => ({
          name: `Place ${index}`,
          type: 'room',
        })),
        knowledgeEntries: [],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    expect(venueFindFirst).not.toHaveBeenCalled()
  })

  it('venue.importContent with STAFF role throws FORBIDDEN without database access', async () => {
    const caller = testRouter.createCaller(staffCtx())

    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        places: [],
        knowledgeEntries: [{ title: 'Policy', category: 'FAQ', content: 'Details' }],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    expect(venueFindFirst).not.toHaveBeenCalled()
  })

  // --- venue.updateAiConfig ---

  it('saves AI config and enqueues every scoped unembedded place', async () => {
    const place1UpdatedAt = new Date('2026-08-07T18:00:00.123Z')
    const place2UpdatedAt = new Date('2026-08-07T18:00:00.456Z')
    venueFindFirst
      .mockResolvedValueOnce({ id: venueRow.id, tenantId: 'tenant_1' })
      .mockResolvedValueOnce({
        aiGuideNotes: 'Keep it concise',
        aiGuideName: 'Pip',
        aiTone: 'FRIENDLY',
      })
    venueUpdateMany.mockResolvedValueOnce({ count: 1 })
    dbQueryRaw.mockResolvedValueOnce([
      { id: 'place_1', updatedAt: place1UpdatedAt },
      { id: 'place_2', updatedAt: place2UpdatedAt },
    ])

    const caller = testRouter.createCaller(managerCtx())
    await caller.venue.updateAiConfig({ venueId: venueRow.id, aiGuideNotes: 'Keep it concise' })

    expect(dbQueryRaw).toHaveBeenCalledOnce()
    expect(enqueueEmbedPlaceMock).toHaveBeenCalledTimes(2)
    expect(enqueueEmbedPlaceMock).toHaveBeenNthCalledWith(1, {
      tenantId: 'tenant_1',
      placeId: 'place_1',
      contentUpdatedAt: place1UpdatedAt.toISOString(),
    })
    expect(enqueueEmbedPlaceMock).toHaveBeenNthCalledWith(2, {
      tenantId: 'tenant_1',
      placeId: 'place_2',
      contentUpdatedAt: place2UpdatedAt.toISOString(),
    })
  })

  it('returns saved AI config when an embedding enqueue fails', async () => {
    const updated = { aiGuideNotes: 'Keep it concise', aiGuideName: 'Pip', aiTone: 'FRIENDLY' }
    venueFindFirst
      .mockResolvedValueOnce({ id: venueRow.id, tenantId: 'tenant_1' })
      .mockResolvedValueOnce(updated)
    venueUpdateMany.mockResolvedValueOnce({ count: 1 })
    dbQueryRaw.mockResolvedValueOnce([
      { id: 'place_1', updatedAt: new Date('2026-08-07T18:00:00.123Z') },
    ])
    enqueueEmbedPlaceMock.mockRejectedValueOnce(new Error('redis unavailable'))

    const caller = testRouter.createCaller(managerCtx())
    await expect(
      caller.venue.updateAiConfig({ venueId: venueRow.id, aiGuideNotes: 'Keep it concise' }),
    ).resolves.toEqual(updated)
  })

  it('does not enqueue when every active scoped place already has an embedding', async () => {
    venueFindFirst
      .mockResolvedValueOnce({ id: venueRow.id, tenantId: 'tenant_1' })
      .mockResolvedValueOnce({ aiGuideNotes: null, aiGuideName: null, aiTone: 'FRIENDLY' })
    venueUpdateMany.mockResolvedValueOnce({ count: 1 })
    dbQueryRaw.mockResolvedValueOnce([])

    const caller = testRouter.createCaller(managerCtx())
    await caller.venue.updateAiConfig({ venueId: venueRow.id, aiGuideNotes: null })
    expect(enqueueEmbedPlaceMock).not.toHaveBeenCalled()
  })

  // --- venue.updateChatDesign ---

  it('venue.updateChatDesign accepts the dark theme and a valid font', async () => {
    venueFindFirst
      .mockResolvedValueOnce({ id: 'cuid1234567890abcdef' }) // ownership check
      .mockResolvedValueOnce({
        chatTheme: 'dark',
        chatAccentColor: '#3A7BD5',
        chatFont: 'inter',
        chatLogoUrl: null,
        chatBannerUrl: null,
      })
    venueUpdateMany.mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.venue.updateChatDesign({
      venueId: 'cuid1234567890abcdef',
      chatTheme: 'dark',
      chatAccentColor: '#3A7BD5',
      chatFont: 'inter',
    })

    expect(result).toMatchObject({ chatTheme: 'dark', chatFont: 'inter' })
    expect(venueUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ chatTheme: 'dark', chatFont: 'inter' }),
      }),
    )
  })

  it('venue.updateChatDesign rejects an invalid font value', async () => {
    const caller = testRouter.createCaller(managerCtx())

    await expect(
      caller.venue.updateChatDesign({
        venueId: 'cuid1234567890abcdef',
        chatFont: 'comic-sans' as never,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
  })

  it('venue.updateChatDesign with STAFF role throws FORBIDDEN', async () => {
    const caller = testRouter.createCaller(staffCtx())

    await expect(
      caller.venue.updateChatDesign({ venueId: 'cuid1234567890abcdef', chatTheme: 'dark' }),
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
