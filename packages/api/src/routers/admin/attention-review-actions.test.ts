import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    founderControlRoomReview: {
      findFirst: mocks.findFirst,
      findUnique: mocks.findUnique,
    },
    $transaction: mocks.transaction,
  },
}))

import { markFounderBriefingReviewed, readFounderBriefingReview } from './attention-review-actions'

const reviewedThrough = new Date('2026-08-22T12:00:00.000Z')
const row = {
  id: 'review_1',
  operationId: '11111111-1111-4111-8111-111111111111',
  operatorUserId: 'operator_1',
  reviewedThrough,
  previousReviewedThrough: null,
  briefingSchemaVersion: 1,
  createdAt: new Date('2026-08-22T12:00:01.000Z'),
}

const input = {
  operationId: row.operationId,
  reviewedThrough: reviewedThrough.toISOString(),
  expectedPreviousReviewedThrough: null,
  briefingSchemaVersion: 1 as const,
}

describe('founder briefing review actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findFirst.mockResolvedValue(null)
    mocks.findUnique.mockResolvedValue(null)
    mocks.create.mockResolvedValue(row)
    mocks.transaction.mockImplementation(async (operation) =>
      operation({
        founderControlRoomReview: {
          findFirst: mocks.findFirst,
          findUnique: mocks.findUnique,
          create: mocks.create,
        },
      }),
    )
  })

  it('reads only the latest checkpoint for the authenticated operator', async () => {
    mocks.findFirst.mockResolvedValue(row)

    await expect(readFounderBriefingReview('operator_1')).resolves.toEqual(row)
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { operatorUserId: 'operator_1' },
      orderBy: [{ reviewedThrough: 'desc' }, { createdAt: 'desc' }],
      select: expect.objectContaining({ operatorUserId: true, reviewedThrough: true }),
    })
  })

  it('appends an actor-scoped monotonic checkpoint without executing queue work', async () => {
    await expect(markFounderBriefingReviewed('operator_1', input)).resolves.toMatchObject({
      id: 'review_1',
      replayed: false,
      executionTriggered: false,
    })
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        operationId: input.operationId,
        operatorUserId: 'operator_1',
        reviewedThrough,
        previousReviewedThrough: null,
        briefingSchemaVersion: 1,
      },
      select: expect.any(Object),
    })
  })

  it('returns an exact idempotent replay and rejects operation-id rebinding', async () => {
    mocks.findUnique.mockResolvedValue(row)
    await expect(markFounderBriefingReviewed('operator_1', input)).resolves.toMatchObject({
      id: 'review_1',
      replayed: true,
    })

    await expect(markFounderBriefingReviewed('operator_2', input)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('fails closed when the expected prior cursor is stale or does not advance', async () => {
    mocks.findFirst.mockResolvedValue(row)
    await expect(markFounderBriefingReviewed('operator_1', input)).rejects.toMatchObject({
      code: 'CONFLICT',
    })

    await expect(
      markFounderBriefingReviewed('operator_1', {
        ...input,
        operationId: '22222222-2222-4222-8222-222222222222',
        expectedPreviousReviewedThrough: reviewedThrough.toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects a client timestamp materially ahead of server time', async () => {
    await expect(
      markFounderBriefingReviewed('operator_1', {
        ...input,
        reviewedThrough: '2099-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns an exact replay when a concurrent identical insert wins the race', async () => {
    mocks.transaction.mockRejectedValue({ code: 'P2002' })
    mocks.findUnique.mockResolvedValue(row)

    await expect(markFounderBriefingReviewed('operator_1', input)).resolves.toMatchObject({
      id: 'review_1',
      replayed: true,
      executionTriggered: false,
    })
  })
})
