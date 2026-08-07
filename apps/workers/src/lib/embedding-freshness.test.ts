import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  buildKnowledgeEntryText: vi.fn(() => 'knowledge text'),
  buildPlaceText: vi.fn(() => 'place text'),
  embeddingSourceHash: vi.fn((_type: string, text: string) =>
    text === 'place text' ? 'place-hash' : 'knowledge-hash',
  ),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@pathfinder/ai', () => ({
  AI_EMBEDDING_MODEL_KEYS: {
    PLACE_CONTENT: 'place-content-embedding',
    KNOWLEDGE_CONTENT: 'knowledge-content-embedding',
  },
  getAiEmbeddingProfile: vi.fn((key: string) => `profile:${key}`),
}))

vi.mock('@pathfinder/db', () => ({
  buildKnowledgeEntryText: mocks.buildKnowledgeEntryText,
  buildPlaceText: mocks.buildPlaceText,
  db: { $transaction: mocks.transaction },
  embeddingSourceHash: mocks.embeddingSourceHash,
}))

import { auditEmbeddingFreshness, classifyEmbeddingFreshness } from './embedding-freshness'

const observedAt = new Date('2026-08-07T20:00:00.000Z')
const updatedAt = new Date('2026-08-07T19:00:00.000Z')

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'place_1',
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    updatedAt,
    hasEmbedding: true,
    claimStatus: 'COMPLETE' as const,
    claimUpdatedAt: updatedAt,
    claimSourceHash: 'expected-hash',
    claimEmbeddingProfile: 'expected-profile',
    claimLeaseExpiresAt: null,
    dispatchId: null,
    dispatchNextAttemptAt: null,
    dispatchLeaseToken: null,
    dispatchLeaseExpiresAt: null,
    observedAt,
    ...overrides,
  }
}

describe('embedding freshness classification', () => {
  it.each([
    [{}, 'current-complete', false],
    [
      {
        claimStatus: null,
        claimUpdatedAt: null,
        claimSourceHash: null,
        claimEmbeddingProfile: null,
      },
      'legacy-vector-no-claim',
      true,
    ],
    [
      {
        claimStatus: null,
        claimUpdatedAt: null,
        claimSourceHash: null,
        claimEmbeddingProfile: null,
        hasEmbedding: false,
      },
      'missing-vector-no-claim',
      true,
    ],
    [{ claimEmbeddingProfile: 'old-profile' }, 'complete-profile-mismatch', true],
    [{ claimSourceHash: 'old-hash' }, 'complete-source-mismatch', true],
    [{ claimUpdatedAt: new Date(0) }, 'current-complete-revision-drift', false],
    [{ hasEmbedding: false }, 'complete-claim-missing-vector-invariant-breach', false],
    [
      { dispatchId: 'dispatch_1', dispatchNextAttemptAt: new Date(observedAt.getTime() + 1_000) },
      'dispatch-backoff',
      false,
    ],
  ] as const)('classifies %s as %s', (overrides, reason, actionable) => {
    expect(
      classifyEmbeddingFreshness({
        row: row(overrides),
        entityType: 'PLACE',
        expectedSourceHash: 'expected-hash',
        expectedProfile: 'expected-profile',
      }),
    ).toMatchObject({ primaryReason: reason, actionable })
  })

  it('reports overlapping mismatch signals while choosing one primary reason', () => {
    expect(
      classifyEmbeddingFreshness({
        row: row({ claimUpdatedAt: new Date(0), claimSourceHash: 'old', hasEmbedding: false }),
        entityType: 'PLACE',
        expectedSourceHash: 'expected-hash',
        expectedProfile: 'expected-profile',
      }),
    ).toMatchObject({
      primaryReason: 'complete-source-mismatch',
      signals: ['revision-mismatch', 'source-mismatch', 'missing-vector'],
    })
  })
})

describe('auditEmbeddingFreshness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(async (run) => run({ $queryRaw: mocks.queryRaw }))
  })

  it('is read-only, tenant scoped, and groups place and knowledge results', async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([
        {
          ...row({
            claimStatus: null,
            claimUpdatedAt: null,
            claimSourceHash: null,
            claimEmbeddingProfile: null,
            hasEmbedding: false,
          }),
          name: 'Place',
          type: 'exhibit',
          itemType: null,
          shortDescription: null,
          longDescription: null,
          tags: [],
          areaName: null,
          hours: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          ...row({
            id: 'entry_1',
            claimStatus: null,
            claimUpdatedAt: null,
            claimSourceHash: null,
            claimEmbeddingProfile: null,
          }),
          title: 'Entry',
          category: 'policy',
          content: 'Text',
        },
      ])

    const result = await auditEmbeddingFreshness({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      scanCap: 20,
    })
    expect(result).toMatchObject({ scanned: 2, truncated: false })
    expect(result.groups).toEqual([
      {
        venueId: 'venue_1',
        entityType: 'KNOWLEDGE_ENTRY',
        reason: 'legacy-vector-no-claim',
        count: 1,
      },
      {
        venueId: 'venue_1',
        entityType: 'PLACE',
        reason: 'missing-vector-no-claim',
        count: 1,
      },
    ])
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2)
    expect(mocks.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'RepeatableRead' }),
    )
  })
})
