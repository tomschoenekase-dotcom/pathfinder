import { beforeEach, describe, expect, it, vi } from 'vitest'

import { materializeDueFirstWeekAccountReviews } from './first-week-account-reviews'

const releaseAt = new Date('2026-08-20T00:00:00.000Z')
const release = {
  id: '11111111-1111-4111-8111-111111111111',
  occurredAt: releaseAt,
}

function fixture() {
  let createdIndex = 0
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue_1' }) },
    firstWeekAccountReview: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `22222222-2222-4222-8222-22222222222${createdIndex++}`,
        ...data,
        createdAt: new Date('2026-08-27T00:01:00.000Z'),
      })),
    },
    onboardingMilestoneEvent: { findFirst: vi.fn().mockResolvedValue(release) },
    visitorSession: { count: vi.fn().mockResolvedValue(4) },
    message: { count: vi.fn().mockResolvedValue(7) },
    conversationInsight: {
      count: vi
        .fn()
        .mockImplementation(({ where }: { where: { category: unknown } }) =>
          where.category === 'LOW_CONFIDENCE_ANSWER' ? 0 : 0,
        ),
    },
    messageFeedback: { count: vi.fn().mockResolvedValue(0) },
    supportRequestAuditEvent: { count: vi.fn().mockResolvedValue(0) },
    aiUsageEvent: {
      aggregate: vi.fn().mockResolvedValue({
        _count: { _all: 8 },
        _sum: { estimatedCostUsd: '0.03000000' },
      }),
      count: vi.fn().mockResolvedValue(0),
    },
    operationalEvent: { upsert: vi.fn().mockResolvedValue({ id: 'event_1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, client }
}

describe('materializeDueFirstWeekAccountReviews', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stays quiet until a venue has canonical release evidence', async () => {
    const { tx, client } = fixture()
    tx.onboardingMilestoneEvent.findFirst.mockResolvedValueOnce(null)

    await expect(
      materializeDueFirstWeekAccountReviews(
        { tenantId: 'tenant_1', venueId: 'venue_1', now: releaseAt },
        client as never,
      ),
    ).resolves.toEqual([])
    expect(tx.firstWeekAccountReview.create).not.toHaveBeenCalled()
    expect(tx.operationalEvent.upsert).not.toHaveBeenCalled()
  })

  it('materializes fixed day 1, 3, and 7 windows and suppresses empty early alerts', async () => {
    const { tx, client } = fixture()

    const reviews = await materializeDueFirstWeekAccountReviews(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        now: new Date('2026-08-27T00:00:00.000Z'),
        systemJobId: 'job_1',
      },
      client as never,
    )

    expect(reviews).toHaveLength(3)
    expect(tx.firstWeekAccountReview.create).toHaveBeenCalledTimes(3)
    expect(tx.firstWeekAccountReview.create.mock.calls.map((call) => call[0].data.dueAt)).toEqual([
      new Date('2026-08-21T00:00:00.000Z'),
      new Date('2026-08-23T00:00:00.000Z'),
      new Date('2026-08-27T00:00:00.000Z'),
    ])
    expect(
      tx.firstWeekAccountReview.create.mock.calls.map((call) => call[0].data.disposition),
    ).toEqual(['NO_ACTION', 'NO_ACTION', 'DRAFT_READY'])
    expect(tx.operationalEvent.upsert).toHaveBeenCalledTimes(1)
    expect(tx.operationalEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          eventType: 'customer-learning.first-week-draft-ready',
          actionRequired: true,
          linkedObjectType: 'FirstWeekAccountReview',
        }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(tx.firstWeekAccountReview.create.mock.calls)).not.toContain(
      'private visitor text',
    )
  })

  it('creates an early draft when aggregate quality signals need human attention', async () => {
    const { tx, client } = fixture()
    tx.conversationInsight.count.mockImplementation(
      async ({ where }: { where: { category: unknown } }) =>
        where.category === 'LOW_CONFIDENCE_ANSWER' ? 2 : 1,
    )

    await materializeDueFirstWeekAccountReviews(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        now: new Date('2026-08-21T00:00:00.000Z'),
      },
      client as never,
    )

    expect(tx.firstWeekAccountReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          milestone: 'DAY_1',
          disposition: 'DRAFT_READY',
          draftReason: expect.stringContaining('low-confidence'),
        }),
      }),
    )
    expect(tx.operationalEvent.upsert).toHaveBeenCalledTimes(1)
  })

  it('rejects cross-tenant venue scope before reading release evidence', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst.mockResolvedValueOnce(null)

    await expect(
      materializeDueFirstWeekAccountReviews(
        { tenantId: 'tenant_other', venueId: 'venue_1', now: releaseAt },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    expect(tx.onboardingMilestoneEvent.findFirst).not.toHaveBeenCalled()
  })
})
