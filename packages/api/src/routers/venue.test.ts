import { createHash } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { checkRateLimitMock } = vi.hoisted(() => ({ checkRateLimitMock: vi.fn() }))

vi.mock('../lib/rate-limit', () => ({ checkRateLimit: checkRateLimitMock }))

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

vi.mock('@pathfinder/jobs', () => ({
  enqueueEmbedKnowledgeEntry: vi.fn().mockResolvedValue(undefined),
  enqueueEmbedPlace: vi.fn().mockResolvedValue(undefined),
}))

import { enqueueEmbedKnowledgeEntry, enqueueEmbedPlace } from '@pathfinder/jobs'

import { router } from '../core'
import type { TRPCContext } from '../context'
import {
  canonicalVenueContentImportPayload,
  ImportVenueContentInput,
} from '../schemas/venue-content'
import { venueRouter } from './venue'

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const venueFindMany = vi.fn()
const venueFindFirst = vi.fn()
const venueCreate = vi.fn()
const venueUpdateMany = vi.fn()
const venueDeleteMany = vi.fn()
const auditLogCreate = vi.fn()
const placeCreateMany = vi.fn()
const knowledgeEntryCreateMany = vi.fn()
const importReceiptFindFirst = vi.fn()
const importReceiptCreateMany = vi.fn()
const dbQueryRaw = vi.fn()
const dbTransaction = vi.fn()
const dbExecuteRaw = vi.fn()

const mockDb = {
  venue: {
    findMany: venueFindMany,
    findFirst: venueFindFirst,
    create: venueCreate,
    updateMany: venueUpdateMany,
    deleteMany: venueDeleteMany,
  },
  place: { createMany: placeCreateMany },
  venueKnowledgeEntry: { createMany: knowledgeEntryCreateMany },
  venueContentImportReceipt: {
    findFirst: importReceiptFindFirst,
    createMany: importReceiptCreateMany,
  },
  auditLog: { create: auditLogCreate },
  $queryRaw: dbQueryRaw,
  $transaction: dbTransaction,
  $executeRaw: dbExecuteRaw,
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
const enqueueEmbedKnowledgeEntryMock = vi.mocked(enqueueEmbedKnowledgeEntry)
const enqueueEmbedPlaceMock = vi.mocked(enqueueEmbedPlace)
const IMPORT_KEY = '11111111-1111-4111-8111-111111111111'

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
    checkRateLimitMock.mockResolvedValue(true)
    importReceiptFindFirst.mockResolvedValue(null)
    importReceiptCreateMany.mockResolvedValue({ count: 1 })
    placeCreateMany.mockResolvedValue({ count: 1 })
    knowledgeEntryCreateMany.mockResolvedValue({ count: 1 })
    dbExecuteRaw.mockResolvedValue(1)
    auditLogCreate.mockResolvedValue({ id: 'audit_1' })
    dbTransaction.mockImplementation(async (callback: (tx: typeof mockDb) => unknown) =>
      callback(mockDb),
    )
  })

  it('venue.setAvailability is exact-revision, tenant-scoped, and strictly audited', async () => {
    const updatedAt = new Date('2026-08-08T12:00:00.000Z')
    venueFindFirst.mockResolvedValueOnce({
      id: 'cuid1234567890abcdef',
      isActive: true,
      updatedAt,
    })
    venueUpdateMany.mockResolvedValueOnce({ count: 1 })

    const result = await testRouter.createCaller(managerCtx()).venue.setAvailability({
      venueId: 'cuid1234567890abcdef',
      enabled: false,
      expectedUpdatedAt: updatedAt,
      reason: 'Provider incident',
    })

    expect(result).toMatchObject({ isActive: false, replayed: false })
    expect(venueUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'cuid1234567890abcdef',
          tenantId: 'tenant_1',
          isActive: true,
          updatedAt,
        }),
        data: expect.objectContaining({ isActive: false }),
      }),
    )
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        actorId: 'user_1',
        actorRole: 'MANAGER',
        action: 'venue.availability.disabled',
        afterState: { enabled: false, reason: 'Provider incident' },
      }),
    })
  })

  it('venue.setAvailability rejects a stale revision without mutation or audit', async () => {
    venueFindFirst.mockResolvedValueOnce({
      id: 'cuid1234567890abcdef',
      isActive: true,
      updatedAt: new Date('2026-08-08T12:00:01.000Z'),
    })

    await expect(
      testRouter.createCaller(managerCtx()).venue.setAvailability({
        venueId: 'cuid1234567890abcdef',
        enabled: false,
        expectedUpdatedAt: new Date('2026-08-08T12:00:00.000Z'),
        reason: 'Provider incident',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(venueUpdateMany).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
  })

  it('venue.setAvailability replays the current state without duplicate audit', async () => {
    const updatedAt = new Date('2026-08-08T12:00:00.000Z')
    venueFindFirst.mockResolvedValueOnce({
      id: 'cuid1234567890abcdef',
      isActive: false,
      updatedAt,
    })

    await expect(
      testRouter.createCaller(managerCtx()).venue.setAvailability({
        venueId: 'cuid1234567890abcdef',
        enabled: false,
        expectedUpdatedAt: updatedAt,
        reason: 'Provider incident',
      }),
    ).resolves.toMatchObject({ isActive: false, replayed: true })
    expect(venueUpdateMany).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
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
        isActive: true,
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
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      'ratelimit:venue-lookup:ingress:global',
      10_000,
      60,
    )
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
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      'ratelimit:venue-lookup:ingress:global',
      10_000,
      60,
    )
  })

  it('venue.getBySlug returns temporary unavailability for an inactive venue after fixed admission', async () => {
    dbQueryRaw.mockResolvedValueOnce([{ isActive: false }])

    const caller = testRouter.createCaller({
      ...baseCtx,
      session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
    })

    await expect(caller.venue.getBySlug({ slug: 'paused-venue' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      'ratelimit:venue-lookup:ingress:global',
      10_000,
      60,
    )
  })

  it('venue.getBySlug uses one fixed key when valid slugs rotate and denies before database work', async () => {
    checkRateLimitMock.mockResolvedValue(false)
    const caller = testRouter.createCaller({
      ...baseCtx,
      session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
    })

    for (const slug of ['museum', 'city-zoo', 'aquarium']) {
      await expect(caller.venue.getBySlug({ slug })).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
      })
    }

    expect(checkRateLimitMock.mock.calls).toEqual(
      Array.from({ length: 3 }, () => ['ratelimit:venue-lookup:ingress:global', 10_000, 60]),
    )
    expect(dbQueryRaw).not.toHaveBeenCalled()
  })

  it.each([{ slug: 'x'.repeat(201) }, { slug: 'city-zoo', unexpected: 'field' }])(
    'venue.getBySlug rejects invalid public input before database access',
    async (input) => {
      const caller = testRouter.createCaller({
        ...baseCtx,
        session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
      })

      await expect(caller.venue.getBySlug(input as { slug: string })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      expect(dbQueryRaw).not.toHaveBeenCalled()
      expect(checkRateLimitMock).not.toHaveBeenCalled()
    },
  )

  it('venue.getById returns place and enabled-knowledge counts', async () => {
    venueFindFirst.mockResolvedValueOnce({
      ...venueRow,
      _count: { places: 3, knowledgeEntries: 2 },
    })

    const caller = testRouter.createCaller(staffCtx())
    const result = await caller.venue.getById({ id: 'cuid1234567890abcdef' })

    expect(result).toMatchObject({
      id: 'cuid1234567890abcdef',
      _count: { places: 3, knowledgeEntries: 2 },
    })
    expect(venueFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          _count: {
            select: {
              places: true,
              knowledgeEntries: { where: { tenantId: 'tenant_1', isEnabled: true } },
            },
          },
        }),
      }),
    )
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
    venueCreate.mockResolvedValueOnce({ ...venueRow, places: [] })

    const caller = testRouter.createCaller(ownerCtx())
    const result = await caller.venue.create({ name: 'City Zoo' })

    expect(result).toMatchObject({ name: 'City Zoo' })
    expect(result).not.toHaveProperty('places')
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
    venueCreate.mockResolvedValueOnce({ ...venueRow, slug: 'city-zoo-2', places: [] })

    const caller = testRouter.createCaller(ownerCtx())
    await caller.venue.create({ name: 'City Zoo' })

    expect(venueCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: 'city-zoo-2' }),
      }),
    )
  })

  it('venue.create atomically nests a discriminated location-aware Place at the center', async () => {
    let transactionCommitted = false
    dbTransaction.mockImplementationOnce(async (callback: (tx: typeof mockDb) => unknown) => {
      const result = await callback(mockDb)
      transactionCommitted = true
      return result
    })
    enqueueEmbedPlaceMock.mockImplementationOnce(async () => {
      expect(transactionCommitted).toBe(true)
    })
    const placeUpdatedAt = new Date('2026-08-09T18:00:00.123Z')
    venueFindFirst.mockResolvedValueOnce(null)
    venueCreate.mockResolvedValueOnce({
      ...venueRow,
      places: [{ id: 'place_1', tenantId: 'tenant_1', updatedAt: placeUpdatedAt }],
    })

    await testRouter.createCaller(ownerCtx()).venue.create({
      name: 'City Zoo',
      guideMode: 'location_aware',
      defaultCenterLat: 40.7,
      defaultCenterLng: -74,
      initialContent: {
        kind: 'place',
        value: {
          name: 'Main entrance',
          type: 'ENTRANCE',
          shortDescription: 'The central visitor entrance.',
        },
      },
    })

    expect(dbTransaction).toHaveBeenCalledOnce()
    expect(venueCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          guideMode: 'location_aware',
          defaultCenterLat: 40.7,
          defaultCenterLng: -74,
          places: {
            create: expect.objectContaining({
              tenantId: 'tenant_1',
              name: 'Main entrance',
              lat: 40.7,
              lng: -74,
            }),
          },
        }),
      }),
    )
    expect(venueCreate.mock.calls[0]?.[0]?.data.places.create).not.toHaveProperty('itemType')
    expect(enqueueEmbedPlaceMock).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      placeId: 'place_1',
      contentUpdatedAt: placeUpdatedAt.toISOString(),
    })
  })

  it('venue.create nests a no-location initial item without coordinates', async () => {
    venueFindFirst.mockResolvedValueOnce(null)
    venueCreate.mockResolvedValueOnce({
      ...venueRow,
      places: [
        { id: 'place_1', tenantId: 'tenant_1', updatedAt: new Date('2026-08-09T18:00:00.123Z') },
      ],
    })

    await testRouter.createCaller(ownerCtx()).venue.create({
      name: 'City Zoo',
      guideMode: 'non_location',
      initialGuideItem: {
        name: 'Visitor policy',
        type: 'OTHER',
        shortDescription: 'General visitor information.',
      },
    })

    const createData = venueCreate.mock.calls[0]?.[0]?.data
    expect(createData).not.toHaveProperty('defaultCenterLat')
    expect(createData).not.toHaveProperty('defaultCenterLng')
    expect(createData.places.create).toMatchObject({
      tenantId: 'tenant_1',
    })
    expect(createData.places.create).not.toHaveProperty('itemType')
    expect(createData.places.create).not.toHaveProperty('lat')
    expect(createData.places.create).not.toHaveProperty('lng')
  })

  it.each([
    {
      guideMode: 'location_aware' as const,
      center: {},
    },
    { guideMode: 'non_location' as const, center: {} },
  ])('venue.create atomically nests $guideMode initial knowledge after commit', async (input) => {
    let transactionCommitted = false
    dbTransaction.mockImplementationOnce(async (callback: (tx: typeof mockDb) => unknown) => {
      const result = await callback(mockDb)
      transactionCommitted = true
      return result
    })
    enqueueEmbedKnowledgeEntryMock.mockImplementationOnce(async () => {
      expect(transactionCommitted).toBe(true)
    })
    const entryUpdatedAt = new Date('2026-08-09T19:00:00.123Z')
    venueFindFirst.mockResolvedValueOnce(null)
    venueCreate.mockResolvedValueOnce({
      ...venueRow,
      places: [],
      knowledgeEntries: [{ id: 'entry_1', tenantId: 'tenant_1', updatedAt: entryUpdatedAt }],
    })

    const result = await testRouter.createCaller(ownerCtx()).venue.create({
      name: 'City Zoo',
      guideMode: input.guideMode,
      ...input.center,
      initialContent: {
        kind: 'knowledge',
        value: {
          title: 'Visitor policy',
          category: 'POLICY',
          content: 'Bags are checked at the entrance.',
        },
      },
    })

    expect(venueCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          knowledgeEntries: {
            create: {
              tenantId: 'tenant_1',
              title: 'Visitor policy',
              category: 'POLICY',
              content: 'Bags are checked at the entrance.',
              isEnabled: true,
            },
          },
        }),
      }),
    )
    expect(venueCreate.mock.calls[0]?.[0]?.data).not.toHaveProperty('places')
    expect(enqueueEmbedKnowledgeEntryMock).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      entryId: 'entry_1',
      contentUpdatedAt: entryUpdatedAt.toISOString(),
    })
    expect(enqueueEmbedPlaceMock).not.toHaveBeenCalled()
    expect(result).not.toHaveProperty('places')
    expect(result).not.toHaveProperty('knowledgeEntries')
  })

  it('venue.create rejects ambiguous legacy and discriminated initial content before writes', async () => {
    await expect(
      testRouter.createCaller(ownerCtx()).venue.create({
        name: 'City Zoo',
        guideMode: 'non_location',
        initialGuideItem: {
          name: 'Visitor policy',
          type: 'OTHER',
          shortDescription: 'General visitor information.',
        },
        initialContent: {
          kind: 'knowledge',
          value: {
            title: 'Visitor policy',
            category: 'POLICY',
            content: 'General visitor information.',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    expect(dbTransaction).not.toHaveBeenCalled()
    expect(venueCreate).not.toHaveBeenCalled()
    expect(enqueueEmbedPlaceMock).not.toHaveBeenCalled()
    expect(enqueueEmbedKnowledgeEntryMock).not.toHaveBeenCalled()
  })

  it('venue.create replays exact initial knowledge without writes or enqueue', async () => {
    venueFindFirst.mockResolvedValueOnce({
      ...venueRow,
      description: null,
      guideNotes: null,
      category: null,
      guideMode: 'non_location',
      defaultCenterLat: null,
      defaultCenterLng: null,
      places: [],
      knowledgeEntries: [
        {
          id: 'entry_1',
          tenantId: 'tenant_1',
          title: 'Visitor policy',
          category: 'POLICY',
          content: 'Bags are checked at the entrance.',
          isEnabled: true,
          updatedAt: new Date('2026-08-09T19:00:00.123Z'),
        },
      ],
    })

    await expect(
      testRouter.createCaller(ownerCtx()).venue.create({
        name: 'City Zoo',
        slug: 'city-zoo',
        guideMode: 'non_location',
        initialContent: {
          kind: 'knowledge',
          value: {
            title: 'Visitor policy',
            category: 'POLICY',
            content: 'Bags are checked at the entrance.',
          },
        },
      }),
    ).resolves.toMatchObject({ id: venueRow.id, slug: 'city-zoo' })

    expect(venueCreate).not.toHaveBeenCalled()
    expect(enqueueEmbedPlaceMock).not.toHaveBeenCalled()
    expect(enqueueEmbedKnowledgeEntryMock).not.toHaveBeenCalled()
  })

  it('venue.create rejects replay when otherwise matching knowledge has extra content', async () => {
    venueFindFirst.mockResolvedValueOnce({
      ...venueRow,
      description: null,
      guideNotes: null,
      category: null,
      guideMode: 'non_location',
      defaultCenterLat: null,
      defaultCenterLng: null,
      places: [],
      knowledgeEntries: [
        {
          title: 'Visitor policy',
          category: 'POLICY',
          content: 'Bags are checked at the entrance.',
          isEnabled: true,
        },
        {
          title: 'Hours',
          category: 'HOURS',
          content: 'Open daily.',
          isEnabled: true,
        },
      ],
    })

    await expect(
      testRouter.createCaller(ownerCtx()).venue.create({
        name: 'City Zoo',
        slug: 'city-zoo',
        guideMode: 'non_location',
        initialContent: {
          kind: 'knowledge',
          value: {
            title: 'Visitor policy',
            category: 'POLICY',
            content: 'Bags are checked at the entrance.',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(venueCreate).not.toHaveBeenCalled()
    expect(enqueueEmbedKnowledgeEntryMock).not.toHaveBeenCalled()
  })

  it('venue.create rejects a cross-kind replay for an existing slug', async () => {
    venueFindFirst.mockResolvedValueOnce({
      ...venueRow,
      description: null,
      guideNotes: null,
      category: null,
      guideMode: 'non_location',
      defaultCenterLat: null,
      defaultCenterLng: null,
      places: [
        {
          name: 'Visitor policy',
          type: 'OTHER',
          itemType: null,
          shortDescription: 'General visitor information.',
          longDescription: null,
          lat: null,
          lng: null,
          tags: [],
          importanceScore: 0,
          areaName: null,
          hours: null,
          photoUrl: null,
        },
      ],
      knowledgeEntries: [],
    })

    await expect(
      testRouter.createCaller(ownerCtx()).venue.create({
        name: 'City Zoo',
        slug: 'city-zoo',
        guideMode: 'non_location',
        initialContent: {
          kind: 'knowledge',
          value: {
            title: 'Visitor policy',
            category: 'POLICY',
            content: 'General visitor information.',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(venueCreate).not.toHaveBeenCalled()
    expect(enqueueEmbedPlaceMock).not.toHaveBeenCalled()
    expect(enqueueEmbedKnowledgeEntryMock).not.toHaveBeenCalled()
  })

  it('venue.create rejects a discriminated location-aware Place without a center before writes', async () => {
    await expect(
      testRouter.createCaller(ownerCtx()).venue.create({
        name: 'City Zoo',
        guideMode: 'location_aware',
        initialContent: {
          kind: 'place',
          value: {
            name: 'Main entrance',
            type: 'ENTRANCE',
            shortDescription: 'The central visitor entrance.',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    expect(venueCreate).not.toHaveBeenCalled()
  })

  it('venue.create keeps a committed venue when the direct embedding enqueue fails', async () => {
    const placeUpdatedAt = new Date('2026-08-09T18:00:00.123Z')
    venueCreate.mockResolvedValueOnce({
      ...venueRow,
      places: [{ id: 'place_1', tenantId: 'tenant_1', updatedAt: placeUpdatedAt }],
    })
    enqueueEmbedPlaceMock.mockRejectedValueOnce(new Error('redis unavailable'))

    const replayed = await testRouter.createCaller(ownerCtx()).venue.create({
      name: 'City Zoo',
      slug: 'city-zoo',
      guideMode: 'non_location',
      initialGuideItem: {
        name: 'Visitor policy',
        type: 'OTHER',
        shortDescription: 'General visitor information.',
      },
    })

    expect(replayed).toMatchObject({ id: venueRow.id, slug: 'city-zoo' })
    expect(replayed).not.toHaveProperty('places')

    expect(enqueueEmbedPlaceMock).toHaveBeenCalledOnce()
  })

  it('venue.create keeps a committed venue when the knowledge embedding enqueue fails', async () => {
    const entryUpdatedAt = new Date('2026-08-09T19:00:00.123Z')
    venueCreate.mockResolvedValueOnce({
      ...venueRow,
      places: [],
      knowledgeEntries: [{ id: 'entry_1', tenantId: 'tenant_1', updatedAt: entryUpdatedAt }],
    })
    enqueueEmbedKnowledgeEntryMock.mockRejectedValueOnce(new Error('redis unavailable'))

    const created = await testRouter.createCaller(ownerCtx()).venue.create({
      name: 'City Zoo',
      slug: 'city-zoo',
      guideMode: 'non_location',
      initialContent: {
        kind: 'knowledge',
        value: {
          title: 'Visitor policy',
          category: 'POLICY',
          content: 'Bags are checked at the entrance.',
        },
      },
    })

    expect(created).toMatchObject({ id: venueRow.id, slug: 'city-zoo' })
    expect(created).not.toHaveProperty('knowledgeEntries')
    expect(enqueueEmbedKnowledgeEntryMock).toHaveBeenCalledOnce()
  })

  it('venue.create replays an exact caller-supplied slug without writes or enqueue', async () => {
    venueFindFirst.mockResolvedValueOnce({
      ...venueRow,
      description: null,
      guideNotes: null,
      category: null,
      guideMode: 'non_location',
      defaultCenterLat: null,
      defaultCenterLng: null,
      places: [
        {
          id: 'place_1',
          tenantId: 'tenant_1',
          name: 'Visitor policy',
          type: 'OTHER',
          itemType: null,
          shortDescription: 'General visitor information.',
          longDescription: null,
          lat: null,
          lng: null,
          tags: [],
          importanceScore: 0,
          areaName: null,
          hours: null,
          photoUrl: null,
          updatedAt: new Date('2026-08-09T18:00:00.123Z'),
        },
      ],
    })

    await expect(
      testRouter.createCaller(ownerCtx()).venue.create({
        name: 'City Zoo',
        slug: 'city-zoo',
        guideMode: 'non_location',
        initialContent: {
          kind: 'place',
          value: {
            name: 'Visitor policy',
            type: 'OTHER',
            shortDescription: 'General visitor information.',
          },
        },
      }),
    ).resolves.toMatchObject({ id: venueRow.id, slug: 'city-zoo' })

    expect(JSON.stringify(dbExecuteRaw.mock.calls)).toContain('pg_advisory_xact_lock')
    expect(JSON.stringify(dbExecuteRaw.mock.calls)).toContain(
      'pathfinder:venue-create:tenant_1:city-zoo',
    )
    expect(venueCreate).not.toHaveBeenCalled()
    expect(enqueueEmbedPlaceMock).not.toHaveBeenCalled()
  })

  it('venue.create rejects changed discriminated Place content for an existing slug', async () => {
    venueFindFirst.mockResolvedValueOnce({
      ...venueRow,
      description: null,
      guideNotes: null,
      category: null,
      guideMode: 'non_location',
      defaultCenterLat: null,
      defaultCenterLng: null,
      places: [
        {
          name: 'Visitor policy',
          type: 'OTHER',
          itemType: null,
          shortDescription: 'General visitor information.',
          longDescription: null,
          lat: null,
          lng: null,
          tags: [],
          importanceScore: 0,
          areaName: null,
          hours: null,
          photoUrl: null,
        },
      ],
      knowledgeEntries: [],
    })

    await expect(
      testRouter.createCaller(ownerCtx()).venue.create({
        name: 'City Zoo',
        slug: 'city-zoo',
        guideMode: 'non_location',
        initialContent: {
          kind: 'place',
          value: {
            name: 'Visitor policy',
            type: 'OTHER',
            shortDescription: 'Changed visitor information.',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(venueCreate).not.toHaveBeenCalled()
    expect(enqueueEmbedPlaceMock).not.toHaveBeenCalled()
  })

  it('venue.create rejects changed setup content for a caller-supplied slug', async () => {
    venueFindFirst.mockResolvedValueOnce({
      ...venueRow,
      name: 'Different Zoo',
      description: null,
      guideNotes: null,
      category: null,
      guideMode: 'non_location',
      defaultCenterLat: null,
      defaultCenterLng: null,
      places: [],
    })

    await expect(
      testRouter.createCaller(ownerCtx()).venue.create({
        name: 'City Zoo',
        slug: 'city-zoo',
        guideMode: 'non_location',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(venueCreate).not.toHaveBeenCalled()
    expect(enqueueEmbedPlaceMock).not.toHaveBeenCalled()
  })

  it('venue.create does not enqueue when the atomic write fails', async () => {
    venueCreate.mockRejectedValueOnce(new Error('atomic write failed'))

    await expect(
      testRouter.createCaller(ownerCtx()).venue.create({ name: 'City Zoo' }),
    ).rejects.toThrow('atomic write failed')
    expect(enqueueEmbedPlaceMock).not.toHaveBeenCalled()
    expect(enqueueEmbedKnowledgeEntryMock).not.toHaveBeenCalled()
  })

  it('venue.create fails closed if a caller-supplied slug races past the serialized lookup', async () => {
    venueCreate.mockRejectedValueOnce(new Error('venues_tenant_id_slug_key'))

    await expect(
      testRouter.createCaller(ownerCtx()).venue.create({ name: 'City Zoo', slug: 'city-zoo' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    expect(venueFindFirst).toHaveBeenCalledOnce()
    expect(venueCreate).toHaveBeenCalledOnce()
    expect(venueCreate.mock.calls[0]?.[0]?.data.slug).toBe('city-zoo')
  })

  it('venue.create rejects a center for a no-location venue before venue writes', async () => {
    await expect(
      testRouter.createCaller(ownerCtx()).venue.create({
        name: 'City Zoo',
        guideMode: 'non_location',
        defaultCenterLat: 40.7,
        defaultCenterLng: -74,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    expect(venueCreate).not.toHaveBeenCalled()
  })

  // --- venue.update ---

  it('venue.update with MANAGER role updates venue', async () => {
    venueFindFirst
      .mockResolvedValueOnce(venueRow) // ownership check
      .mockResolvedValueOnce({ ...venueRow, name: 'Updated Zoo' }) // return updated row
    venueUpdateMany.mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.venue.update({
      id: 'cuid1234567890abcdef',
      expectedUpdatedAt: venueRow.updatedAt,
      name: 'Updated Zoo',
    })

    expect(result).toMatchObject({ name: 'Updated Zoo' })
    expect(dbExecuteRaw).toHaveBeenCalled()
    expect(venueUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          updatedAt: venueRow.updatedAt,
        }),
        data: expect.objectContaining({ updatedAt: expect.any(Date) }),
      }),
    )
  })

  it('venue.update rejects a stale reviewed revision before writing', async () => {
    const reviewedRevision = new Date('2026-08-09T18:00:00.000Z')
    const currentRevision = new Date('2026-08-09T18:01:00.000Z')
    venueFindFirst.mockResolvedValueOnce({
      ...venueRow,
      updatedAt: currentRevision,
    })

    await expect(
      testRouter.createCaller(managerCtx()).venue.update({
        id: venueRow.id,
        expectedUpdatedAt: reviewedRevision,
        name: 'Stale edit',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Venue changed in another session. Refresh and try again.',
    })
    expect(venueUpdateMany).not.toHaveBeenCalled()
  })

  it('venue.update fails closed when the revision changes at compare-and-set', async () => {
    venueFindFirst.mockResolvedValueOnce(venueRow)
    venueUpdateMany.mockResolvedValueOnce({ count: 0 })

    await expect(
      testRouter.createCaller(managerCtx()).venue.update({
        id: venueRow.id,
        expectedUpdatedAt: venueRow.updatedAt,
        name: 'Racing edit',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(venueUpdateMany).toHaveBeenCalledWith({
      where: { id: venueRow.id, tenantId: 'tenant_1', updatedAt: venueRow.updatedAt },
      data: expect.objectContaining({ name: 'Racing edit', updatedAt: expect.any(Date) }),
    })
    expect(venueFindFirst).toHaveBeenCalledOnce()
  })

  it('venue.update clears stored centers when switching to non-location mode', async () => {
    venueFindFirst
      .mockResolvedValueOnce({
        id: venueRow.id,
        guideMode: 'location_aware',
        updatedAt: venueRow.updatedAt,
      })
      .mockResolvedValueOnce({
        ...venueRow,
        guideMode: 'non_location',
        defaultCenterLat: null,
        defaultCenterLng: null,
      })
    venueUpdateMany.mockResolvedValueOnce({ count: 1 })

    await testRouter.createCaller(managerCtx()).venue.update({
      id: venueRow.id,
      expectedUpdatedAt: venueRow.updatedAt,
      guideMode: 'non_location',
    })

    expect(venueUpdateMany).toHaveBeenCalledWith({
      where: { id: venueRow.id, tenantId: 'tenant_1', updatedAt: venueRow.updatedAt },
      data: expect.objectContaining({
        guideMode: 'non_location',
        defaultCenterLat: null,
        defaultCenterLng: null,
        updatedAt: expect.any(Date),
      }),
    })
  })

  it('venue.update rejects adding centers to an existing non-location venue', async () => {
    venueFindFirst.mockResolvedValueOnce({
      id: venueRow.id,
      guideMode: 'non_location',
      updatedAt: venueRow.updatedAt,
    })

    await expect(
      testRouter.createCaller(managerCtx()).venue.update({
        id: venueRow.id,
        expectedUpdatedAt: venueRow.updatedAt,
        defaultCenterLat: 41.5,
        defaultCenterLng: -81.7,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(venueUpdateMany).not.toHaveBeenCalled()
  })

  it.each([
    { defaultCenterLat: 41.5 },
    { defaultCenterLng: -81.7 },
    { defaultCenterLat: 91, defaultCenterLng: -81.7 },
    { defaultCenterLat: 41.5, defaultCenterLng: -181 },
    { guideMode: 'non_location' as const, defaultCenterLat: 41.5, defaultCenterLng: -81.7 },
  ])('venue.update rejects incoherent center input before venue access', async (location) => {
    await expect(
      testRouter
        .createCaller(managerCtx())
        .venue.update({ id: venueRow.id, expectedUpdatedAt: venueRow.updatedAt, ...location }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(venueUpdateMany).not.toHaveBeenCalled()
  })

  it('venue.update throws NOT_FOUND for wrong tenant', async () => {
    venueFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(managerCtx())

    await expect(
      caller.venue.update({
        id: 'cuid1234567890abcdef',
        expectedUpdatedAt: venueRow.updatedAt,
        name: 'X',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
  })

  it('venue.update with STAFF role throws FORBIDDEN', async () => {
    const caller = testRouter.createCaller(staffCtx())

    await expect(
      caller.venue.update({
        id: 'cuid1234567890abcdef',
        expectedUpdatedAt: venueRow.updatedAt,
        name: 'X',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
  })

  // --- venue.importContent ---

  it('venue.importContent creates places and knowledge in one transaction', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: venueRow.id, guideMode: 'location_aware' })

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.venue.importContent({
      venueId: venueRow.id,
      idempotencyKey: IMPORT_KEY,
      places: [{ name: 'Lobby', type: 'room', lat: 39.7, lng: -86.1 }],
      knowledgeEntries: [{ title: 'Policy', category: 'FAQ', content: 'Details' }],
    })

    expect(result).toEqual({ placeCount: 1, knowledgeEntryCount: 1, replayed: false })
    expect(dbTransaction).toHaveBeenCalledOnce()
    expect(importReceiptCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            tenantId: 'tenant_1',
            venueId: venueRow.id,
            idempotencyKey: IMPORT_KEY,
            payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            placeCount: 1,
            knowledgeEntryCount: 1,
          }),
        ],
        skipDuplicates: true,
      }),
    )
    expect(placeCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            tenantId: 'tenant_1',
            venueId: venueRow.id,
            name: 'Lobby',
          }),
        ],
      }),
    )
    expect(knowledgeEntryCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            tenantId: 'tenant_1',
            venueId: venueRow.id,
            title: 'Policy',
          }),
        ],
      }),
    )
  })

  it('venue.importContent returns a matching receipt without writing content', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: venueRow.id, guideMode: 'non_location' })
    const caller = testRouter.createCaller(managerCtx())
    const input = {
      venueId: venueRow.id,
      idempotencyKey: IMPORT_KEY,
      places: [{ name: 'Lobby', type: 'room' }],
      knowledgeEntries: [],
    }
    const payloadHash = createHash('sha256')
      .update(canonicalVenueContentImportPayload(ImportVenueContentInput.parse(input)))
      .digest('hex')
    importReceiptFindFirst.mockReset().mockResolvedValueOnce({
      payloadHash,
      placeCount: 7,
      knowledgeEntryCount: 3,
    })

    await expect(caller.venue.importContent(input)).resolves.toEqual({
      placeCount: 7,
      knowledgeEntryCount: 3,
      replayed: true,
    })
    expect(dbTransaction).not.toHaveBeenCalled()
    expect(placeCreateMany).not.toHaveBeenCalled()
  })

  it('venue.importContent rejects a reused key for different content', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: venueRow.id, guideMode: 'non_location' })
    importReceiptFindFirst.mockResolvedValueOnce({
      payloadHash: '0'.repeat(64),
      placeCount: 1,
      knowledgeEntryCount: 0,
    })

    const caller = testRouter.createCaller(managerCtx())
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        idempotencyKey: IMPORT_KEY,
        places: [{ name: 'Changed', type: 'room' }],
        knowledgeEntries: [],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(dbTransaction).not.toHaveBeenCalled()
  })

  it('venue.importContent fails closed when a skipped claim has no scoped receipt', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: venueRow.id, guideMode: 'non_location' })
    importReceiptCreateMany.mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(managerCtx())
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        idempotencyKey: IMPORT_KEY,
        places: [{ name: 'Lobby', type: 'room' }],
        knowledgeEntries: [],
      }),
    ).rejects.toThrow('receipt claim was lost')
    expect(placeCreateMany).not.toHaveBeenCalled()
  })

  it('venue.importContent propagates transaction failure without a partial result', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: venueRow.id, guideMode: 'non_location' })
    dbTransaction.mockRejectedValueOnce(new Error('transaction failed'))

    const caller = testRouter.createCaller(managerCtx())
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        idempotencyKey: IMPORT_KEY,
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
        idempotencyKey: IMPORT_KEY,
        places: [],
        knowledgeEntries: [{ title: 'Policy', category: 'FAQ', content: 'Details' }],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
    expect(placeCreateMany).not.toHaveBeenCalled()
    expect(knowledgeEntryCreateMany).not.toHaveBeenCalled()
    expect(dbTransaction).not.toHaveBeenCalled()
  })

  it('venue.importContent enforces location-aware coordinates on the server', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: venueRow.id, guideMode: 'location_aware' })

    const caller = testRouter.createCaller(managerCtx())
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        idempotencyKey: IMPORT_KEY,
        places: [{ name: 'Lobby', type: 'room' }],
        knowledgeEntries: [],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    expect(dbTransaction).not.toHaveBeenCalled()
  })

  it('venue.importContent allows omitted coordinates for a non-location venue', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: venueRow.id, guideMode: 'non_location' })
    const caller = testRouter.createCaller(managerCtx())
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        idempotencyKey: IMPORT_KEY,
        places: [{ name: 'Lobby', type: 'room' }],
        knowledgeEntries: [],
      }),
    ).resolves.toEqual({ placeCount: 1, knowledgeEntryCount: 0, replayed: false })
  })

  it('venue.importContent rejects unpaired and out-of-range coordinates before database access', async () => {
    const caller = testRouter.createCaller(managerCtx())

    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        idempotencyKey: IMPORT_KEY,
        places: [{ name: 'Lobby', type: 'room', lat: 39.7 }],
        knowledgeEntries: [],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        idempotencyKey: IMPORT_KEY,
        places: [{ name: 'Lobby', type: 'room', lat: 91, lng: -86.1 }],
        knowledgeEntries: [],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    expect(venueFindFirst).not.toHaveBeenCalled()
  })

  it('venue.importContent rejects empty and oversized payloads before database access', async () => {
    const caller = testRouter.createCaller(managerCtx())

    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        idempotencyKey: IMPORT_KEY,
        places: [],
        knowledgeEntries: [],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    await expect(
      caller.venue.importContent({
        venueId: venueRow.id,
        idempotencyKey: IMPORT_KEY,
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
        idempotencyKey: IMPORT_KEY,
        places: [],
        knowledgeEntries: [{ title: 'Policy', category: 'FAQ', content: 'Details' }],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    expect(venueFindFirst).not.toHaveBeenCalled()
  })

  // --- venue.updateAiConfig ---

  it('saves AI config and enqueues every scoped unembedded place', async () => {
    let transactionCommitted = false
    dbTransaction.mockImplementationOnce(async (callback: (tx: typeof mockDb) => unknown) => {
      const result = await callback(mockDb)
      transactionCommitted = true
      return result
    })
    enqueueEmbedPlaceMock.mockImplementation(async () => {
      expect(transactionCommitted).toBe(true)
    })
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

    expect(dbExecuteRaw).toHaveBeenCalled()
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

  it('persists a versioned tone preset and mirrors a safe legacy aiTone value', async () => {
    venueFindFirst
      .mockResolvedValueOnce({ id: venueRow.id, tenantId: 'tenant_1' })
      .mockResolvedValueOnce({
        aiGuideNotes: 'Hidden operator guidance',
        aiGuideName: 'Pip',
        aiTone: 'PROFESSIONAL',
        tonePreset: 'concise',
        tonePresetVersion: 1,
      })
    venueUpdateMany.mockResolvedValueOnce({ count: 1 })
    dbQueryRaw.mockResolvedValueOnce([])

    const caller = testRouter.createCaller(managerCtx())
    await caller.venue.updateAiConfig({ venueId: venueRow.id, tonePreset: 'concise' })

    expect(venueUpdateMany).toHaveBeenCalledWith({
      where: { id: venueRow.id, tenantId: 'tenant_1' },
      data: {
        tonePreset: 'concise',
        tonePresetVersion: 1,
        aiTone: 'PROFESSIONAL',
      },
    })
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
    expect(dbExecuteRaw).toHaveBeenCalled()
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
    expect(dbExecuteRaw).toHaveBeenCalled()
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

  it('venue.delete reports retained package history as a conflict', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'cuid1234567890abcdef', _count: { places: 0 } })
    venueDeleteMany.mockRejectedValueOnce({ code: 'P2003' })

    const caller = testRouter.createCaller(ownerCtx())

    await expect(caller.venue.delete({ id: 'cuid1234567890abcdef' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({
        code: 'CONFLICT',
        message: expect.stringContaining('dependent history'),
      }),
    )
  })

  it('venue.delete with MANAGER role throws FORBIDDEN', async () => {
    const caller = testRouter.createCaller(managerCtx())

    await expect(caller.venue.delete({ id: 'cuid1234567890abcdef' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }),
    )
  })
})
