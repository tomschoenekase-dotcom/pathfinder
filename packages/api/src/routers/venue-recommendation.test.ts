import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { buildGuestRecommendationDecision } from '../lib/venue-recommendation-context'
import { catalogItemFactsSelect } from '../lib/venue-recommendation-context'
import { venueRecommendationRouter } from './venue-recommendation'

const venueFindFirst = vi.fn()
const placeFindFirst = vi.fn()
const itemFindMany = vi.fn()
const itemFindFirst = vi.fn()
const itemFindFirstOrThrow = vi.fn()
const itemCreate = vi.fn()
const itemUpdateMany = vi.fn()
const priorityFindMany = vi.fn()
const priorityFindFirst = vi.fn()
const priorityUpsert = vi.fn()
const policyFindFirst = vi.fn()
const policyFindFirstOrThrow = vi.fn()
const policyCreate = vi.fn()
const policyUpdateMany = vi.fn()
const eventFindMany = vi.fn()
const auditCreate = vi.fn().mockResolvedValue({ id: 'audit_1' })

const mockDb = {
  venue: { findFirst: venueFindFirst },
  place: { findFirst: placeFindFirst },
  venueCatalogItem: {
    findMany: itemFindMany,
    findFirst: itemFindFirst,
    findFirstOrThrow: itemFindFirstOrThrow,
    create: itemCreate,
    updateMany: itemUpdateMany,
  },
  venueCatalogItemPriority: {
    findMany: priorityFindMany,
    findFirst: priorityFindFirst,
    upsert: priorityUpsert,
  },
  venueRecommendationPolicy: {
    findFirst: policyFindFirst,
    findFirstOrThrow: policyFindFirstOrThrow,
    create: policyCreate,
    updateMany: policyUpdateMany,
  },
  analyticsEvent: { findMany: eventFindMany },
  auditLog: { create: auditCreate },
  $transaction: vi.fn(),
} as unknown as TRPCContext['db']

const ctxFor = (role: 'STAFF' | 'MANAGER', tenant = 'tenant_1'): TRPCContext => ({
  db: mockDb,
  headers: new Headers(),
  session: { userId: 'user_1', activeTenantId: tenant, role, isPlatformAdmin: false },
})

const testRouter = router({ venueRecommendation: venueRecommendationRouter })
const manager = () => testRouter.createCaller(ctxFor('MANAGER')).venueRecommendation
const staff = () => testRouter.createCaller(ctxFor('STAFF')).venueRecommendation

const VENUE_ID = 'cvenueabc123456789012'
const ITEM_ID = 'citemabc123456789012x'
const PLACE_ID = 'cplaceabc12345678901x'
const OBSERVED = new Date('2026-07-10T12:00:00.000Z')

const itemFields = {
  category: 'cold_drink' as const,
  name: 'Fresh Lemonade',
  priceMinor: 500,
  currency: 'USD',
  priceObservedAt: OBSERVED,
  availability: 'AVAILABLE' as const,
  availabilityObservedAt: OBSERVED,
  allergens: { status: 'known' as const, values: [] },
  ingredients: { status: 'unknown' as const, values: [] },
  lastVerifiedAt: OBSERVED,
}

const policyInput = {
  venueId: VENUE_ID,
  enabled: true,
  maxBoost: 3,
  ownerLabel: 'Cafe manager',
}

beforeEach(() => {
  vi.resetAllMocks()
  auditCreate.mockResolvedValue({ id: 'audit_1' })
  ;(mockDb.$transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (operation: (tx: TRPCContext['db']) => unknown) => operation(mockDb),
  )
  venueFindFirst.mockResolvedValue({ id: VENUE_ID, name: 'Garden Museum' })
})

describe('venueRecommendation authorization', () => {
  it.each([
    ['getOverview', { venueId: VENUE_ID }],
    ['upsertItem', { venueId: VENUE_ID, stableKey: 'lemonade', fields: itemFields }],
    ['archiveItem', { venueId: VENUE_ID, itemId: ITEM_ID, expectedVersion: 1 }],
    ['setItemPriority', { venueId: VENUE_ID, itemId: ITEM_ID, priority: 'HIGH' }],
    ['upsertPolicy', policyInput],
  ] as const)('%s is forbidden for STAFF before any database access', async (name, input) => {
    await expect(
      (staff() as unknown as Record<string, (i: unknown) => Promise<unknown>>)[name]!(input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it('scopes the venue lookup to the authenticated tenant, never to input', async () => {
    venueFindFirst.mockResolvedValue(null)
    await expect(manager().getOverview({ venueId: VENUE_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(venueFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: VENUE_ID, tenantId: 'tenant_1' } }),
    )
    await expect(
      manager().getOverview({ venueId: VENUE_ID, tenantId: 'tenant_evil' } as never),
    ).rejects.toBeInstanceOf(TRPCError)
  })
})

describe('venueRecommendation catalog', () => {
  it('creates an item with version 1, audits it, and defaults to unknown ingredients', async () => {
    itemCreate.mockResolvedValue({ id: ITEM_ID, stableKey: 'lemonade', version: 1 })
    await manager().upsertItem({
      venueId: VENUE_ID,
      stableKey: 'lemonade',
      fields: itemFields,
    })
    const data = itemCreate.mock.calls[0]![0].data
    expect(data).toMatchObject({
      tenantId: 'tenant_1',
      venueId: VENUE_ID,
      stableKey: 'lemonade',
      ingredients: { status: 'unknown', values: [] },
      hours: {},
    })
    // The commercial priority is never part of the item write.
    expect(Object.keys(data)).not.toContain('priority')
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        action: 'venue-catalog-item.created',
        targetId: ITEM_ID,
      }),
    })
  })

  it('rejects a price without an observation date and an unknown list carrying values', async () => {
    await expect(
      manager().upsertItem({
        venueId: VENUE_ID,
        stableKey: 'lemonade',
        fields: { ...itemFields, priceObservedAt: null },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      manager().upsertItem({
        venueId: VENUE_ID,
        stableKey: 'lemonade',
        fields: { ...itemFields, allergens: { status: 'unknown', values: ['milk'] } },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(itemCreate).not.toHaveBeenCalled()
  })

  it('rejects a route place from another venue', async () => {
    placeFindFirst.mockResolvedValue(null)
    await expect(
      manager().upsertItem({
        venueId: VENUE_ID,
        stableKey: 'lemonade',
        fields: { ...itemFields, placeId: PLACE_ID },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(placeFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PLACE_ID, tenantId: 'tenant_1', venueId: VENUE_ID },
      }),
    )
  })

  it('maps a duplicate stable key to CONFLICT', async () => {
    itemCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
    await expect(
      manager().upsertItem({ venueId: VENUE_ID, stableKey: 'lemonade', fields: itemFields }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('updates with optimistic concurrency and bumps the version', async () => {
    itemUpdateMany.mockResolvedValue({ count: 1 })
    itemFindFirstOrThrow.mockResolvedValue({ id: ITEM_ID, version: 4 })
    await manager().upsertItem({
      venueId: VENUE_ID,
      itemId: ITEM_ID,
      expectedVersion: 3,
      fields: itemFields,
    })
    expect(itemUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: ITEM_ID,
          tenantId: 'tenant_1',
          venueId: VENUE_ID,
          version: 3,
          archivedAt: null,
        },
        data: expect.objectContaining({ version: { increment: 1 } }),
      }),
    )
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'venue-catalog-item.updated' }),
    })
  })

  it('reports a stale item version as CONFLICT and a missing item as NOT_FOUND', async () => {
    itemUpdateMany.mockResolvedValue({ count: 0 })
    itemFindFirst.mockResolvedValue({ id: ITEM_ID, archivedAt: null })
    await expect(
      manager().upsertItem({
        venueId: VENUE_ID,
        itemId: ITEM_ID,
        expectedVersion: 1,
        fields: itemFields,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    itemFindFirst.mockResolvedValue(null)
    await expect(
      manager().upsertItem({
        venueId: VENUE_ID,
        itemId: ITEM_ID,
        expectedVersion: 1,
        fields: itemFields,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('archives with a version check and an audit entry', async () => {
    itemUpdateMany.mockResolvedValue({ count: 1 })
    await expect(
      manager().archiveItem({ venueId: VENUE_ID, itemId: ITEM_ID, expectedVersion: 2 }),
    ).resolves.toEqual({ archived: true })
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'venue-catalog-item.archived' }),
    })
    itemUpdateMany.mockResolvedValue({ count: 0 })
    await expect(
      manager().archiveItem({ venueId: VENUE_ID, itemId: ITEM_ID, expectedVersion: 2 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('venueRecommendation private priority', () => {
  it('stores the priority separately with the OPERATOR audience and audits the change', async () => {
    itemFindFirst.mockResolvedValue({ id: ITEM_ID })
    priorityFindFirst.mockResolvedValue({ priority: 'NORMAL' })
    priorityUpsert.mockResolvedValue({})
    await expect(
      manager().setItemPriority({ venueId: VENUE_ID, itemId: ITEM_ID, priority: 'HIGH' }),
    ).resolves.toEqual({ itemId: ITEM_ID, commercialPriority: 'HIGH' })
    expect(priorityUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tenantId: 'tenant_1',
          audience: 'OPERATOR',
          priority: 'HIGH',
        }),
      }),
    )
    expect(itemUpdateMany).not.toHaveBeenCalled()
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'venue-catalog-item.priority-changed',
        beforeState: { priority: 'NORMAL' },
        afterState: { priority: 'HIGH', audience: 'OPERATOR' },
      }),
    })
  })

  it('cannot set a priority for an item outside the tenant venue', async () => {
    itemFindFirst.mockResolvedValue(null)
    await expect(
      manager().setItemPriority({ venueId: VENUE_ID, itemId: ITEM_ID, priority: 'HIGH' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(itemFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ITEM_ID, tenantId: 'tenant_1', venueId: VENUE_ID, archivedAt: null },
      }),
    )
    expect(priorityUpsert).not.toHaveBeenCalled()
  })

  it('exposes the priority only through the manager overview', async () => {
    policyFindFirst.mockResolvedValue(null)
    itemFindMany.mockResolvedValue([{ id: ITEM_ID, name: 'Fresh Lemonade' }])
    priorityFindMany.mockResolvedValue([{ itemId: ITEM_ID, priority: 'HIGH' }])
    const overview = await manager().getOverview({ venueId: VENUE_ID })
    expect(overview.policy).toBeNull()
    expect(overview.items[0]).toMatchObject({ commercialPriority: 'HIGH' })
  })

  it('keeps the guest fact projection free of any priority column', () => {
    expect(Object.keys(catalogItemFactsSelect)).not.toContain('priority')
    expect(JSON.stringify(catalogItemFactsSelect)).not.toMatch(/priorit/iu)
  })
})

describe('venueRecommendation policy', () => {
  it('creates a disabled-by-default-capable policy at version 1 with a proposed cap of 1', async () => {
    policyFindFirst.mockResolvedValue(null)
    policyCreate.mockResolvedValue({ id: 'policy_1', version: 1 })
    await manager().upsertPolicy(policyInput)
    expect(policyCreate.mock.calls[0]![0].data).toMatchObject({
      tenantId: 'tenant_1',
      venueId: VENUE_ID,
      version: 1,
      maxUnsolicitedPerSession: 1,
      ownerUserId: 'user_1',
      ownerLabel: 'Cafe manager',
    })
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'venue-recommendation-policy.created' }),
    })
  })

  it('bounds the boost and the cap', async () => {
    await expect(manager().upsertPolicy({ ...policyInput, maxBoost: 11 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(
      manager().upsertPolicy({ ...policyInput, maxUnsolicitedPerSession: 4 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(policyCreate).not.toHaveBeenCalled()
  })

  it('updates under version control and audits before and after', async () => {
    policyFindFirst.mockResolvedValue({
      id: 'policy_1',
      version: 2,
      enabled: false,
      maxBoost: 1,
      maxUnsolicitedPerSession: 1,
      expiresAt: null,
    })
    policyUpdateMany.mockResolvedValue({ count: 1 })
    policyFindFirstOrThrow.mockResolvedValue({ id: 'policy_1', version: 3 })
    await manager().upsertPolicy({ ...policyInput, expectedVersion: 2 })
    expect(policyUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'policy_1', tenantId: 'tenant_1', venueId: VENUE_ID, version: 2 },
      }),
    )
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'venue-recommendation-policy.updated',
        beforeState: expect.objectContaining({ version: 2, enabled: false }),
      }),
    })
    await expect(
      manager().upsertPolicy({ ...policyInput, expectedVersion: 1 }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(manager().upsertPolicy(policyInput)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('venueRecommendation measurement', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 6, 15, 12, minutes))

  it('reports raw counts, a comparison group, and no sales attribution', async () => {
    itemFindMany.mockResolvedValue([
      { id: 'item_a', name: 'Fresh Lemonade', placeId: 'place_cafe' },
      { id: 'item_b', name: 'Water', placeId: null },
    ])
    eventFindMany.mockResolvedValue([
      {
        eventType: 'recommendation.candidate',
        sessionId: 's1',
        placeId: null,
        metadata: {},
        occurredAt: at(0),
      },
      {
        eventType: 'recommendation.shown',
        sessionId: 's1',
        placeId: null,
        metadata: { itemId: 'item_a' },
        occurredAt: at(0),
      },
      {
        eventType: 'place_card.clicked',
        sessionId: 's1',
        placeId: 'place_cafe',
        metadata: null,
        occurredAt: at(2),
      },
      // Same session click on an unrelated place does not count.
      {
        eventType: 'place_card.clicked',
        sessionId: 's1',
        placeId: 'place_other',
        metadata: null,
        occurredAt: at(3),
      },
      {
        eventType: 'recommendation.candidate',
        sessionId: 's2',
        placeId: null,
        metadata: {},
        occurredAt: at(5),
      },
      {
        eventType: 'recommendation.shown',
        sessionId: 's2',
        placeId: null,
        metadata: { itemId: 'item_a' },
        occurredAt: at(5),
      },
      {
        eventType: 'recommendation.declined',
        sessionId: 's2',
        placeId: null,
        metadata: {},
        occurredAt: at(6),
      },
      {
        eventType: 'recommendation.candidate',
        sessionId: 's3',
        placeId: null,
        metadata: {},
        occurredAt: at(10),
      },
      {
        eventType: 'directions.opened',
        sessionId: 's3',
        placeId: 'place_cafe',
        metadata: null,
        occurredAt: at(12),
      },
      {
        eventType: 'recommendation.candidate',
        sessionId: 's4',
        placeId: null,
        metadata: {},
        occurredAt: at(20),
      },
      // Click before any exposure in a shown session is not counted as a post-exposure click.
      {
        eventType: 'visitor.action.clicked',
        sessionId: 's5',
        placeId: null,
        metadata: { targetKind: 'PLACE_ID', targetId: 'place_cafe' },
        occurredAt: at(1),
      },
    ])
    const result = await manager().getMeasurement({ venueId: VENUE_ID, days: 30 })
    expect(result.counts).toEqual({
      eligibleSessions: 4,
      shownEvents: 2,
      shownSessions: 2,
      declinedSessions: 1,
      candidateNotShownSessions: 2,
      shownSessionsWithClick: 1,
      shownClickEvents: 1,
      candidateNotShownSessionsWithClick: 1,
    })
    expect(result.perItem.find((item) => item.itemId === 'item_a')).toMatchObject({
      shownEvents: 2,
      clickEvents: 1,
      hasRoutePlace: true,
    })
    expect(result.perItem.find((item) => item.itemId === 'item_b')?.hasRoutePlace).toBe(false)
    expect(result.salesAttribution).toBe('unavailable')
    expect(result.note).toMatch(/Sales attribution is unavailable/u)
    expect(JSON.stringify(result)).not.toMatch(/revenue\W*:|roi\W*:|lift\W*:|conversionRate/iu)
    expect(eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant_1', venueId: VENUE_ID }),
      }),
    )
  })

  it('is available to STAFF and flags truncation', async () => {
    itemFindMany.mockResolvedValue([])
    eventFindMany.mockResolvedValue([])
    const result = await staff().getMeasurement({ venueId: VENUE_ID, days: 7 })
    expect(result.truncated).toBe(false)
    expect(result.counts.eligibleSessions).toBe(0)
  })
})

describe('guest recommendation loader', () => {
  const client = {
    venueRecommendationPolicy: { findFirst: policyFindFirst },
    venueCatalogItem: { findMany: itemFindMany },
    venueCatalogItemPriority: { findMany: priorityFindMany },
    analyticsEvent: { findMany: eventFindMany },
  } as unknown as Parameters<typeof buildGuestRecommendationDecision>[0]['client']
  const base = {
    client,
    tenantId: 'tenant_1',
    venueId: VENUE_ID,
    venueName: 'Garden Museum',
    sessionId: 'session_1',
    message: "I'm thirsty",
    priorUserMessages: [] as string[],
  }

  it('is off without a policy or with a disabled one, and reads nothing else', async () => {
    policyFindFirst.mockResolvedValue(null)
    await expect(buildGuestRecommendationDecision(base)).resolves.toBeNull()
    policyFindFirst.mockResolvedValue({ id: 'p', enabled: false, venueId: VENUE_ID })
    await expect(buildGuestRecommendationDecision(base)).resolves.toBeNull()
    expect(itemFindMany).not.toHaveBeenCalled()
    expect(priorityFindMany).not.toHaveBeenCalled()
    expect(policyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant_1', venueId: VENUE_ID } }),
    )
  })

  it('treats unreadable stored lists as unknown, never as none', async () => {
    policyFindFirst.mockResolvedValue({
      id: 'p',
      venueId: VENUE_ID,
      version: 1,
      enabled: true,
      maxBoost: 3,
      maxUnsolicitedPerSession: 1,
      factMaxAgeDays: 30,
      availabilityMaxAgeHours: 24,
      expiresAt: null,
    })
    const recent = new Date(Date.now() - 3_600_000)
    itemFindMany.mockResolvedValue([
      {
        id: 'item_a',
        venueId: VENUE_ID,
        version: 1,
        category: 'cold_drink',
        name: 'Fresh Lemonade',
        description: null,
        placeId: null,
        routeNote: null,
        priceMinor: 500,
        currency: 'USD',
        sizeLabel: null,
        priceObservedAt: recent,
        effectiveFrom: null,
        effectiveUntil: null,
        availability: 'AVAILABLE',
        availabilityObservedAt: recent,
        hours: {},
        seasonalWindows: [],
        ingredients: 'garbage',
        allergens: { status: 'known', values: [], extra: true },
        dietary: {},
        lastVerifiedAt: recent,
        allowedClaims: [],
        archivedAt: null,
      },
    ])
    priorityFindMany.mockResolvedValue([{ itemId: 'item_a', priority: 'HIGH' }])
    eventFindMany.mockResolvedValue([])
    const decision = await buildGuestRecommendationDecision({
      ...base,
      message: "I'm thirsty and allergic to peanuts",
    })
    expect(decision?.exclusions[0]?.reasons).toContain('allergens_unknown')
    expect(decision?.mode).toBe('none')
    expect(priorityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', venueId: VENUE_ID, audience: 'OPERATOR' },
      }),
    )
  })
})
