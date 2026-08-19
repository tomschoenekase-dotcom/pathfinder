import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnthropicMessagesClient } from '@pathfinder/ai'

const mocks = vi.hoisted(() => ({
  venueFindMany: vi.fn(),
  placeFindMany: vi.fn(),
  knowledgeFindMany: vi.fn(),
  messageFindMany: vi.fn(),
  messageGroupBy: vi.fn(),
  messageUpdateMany: vi.fn(),
  analyticsGroupBy: vi.fn(),
  analyticsFindMany: vi.fn(),
  analyticsCount: vi.fn(),
  visitorFindMany: vi.fn(),
  clusterDeleteMany: vi.fn(),
  clusterCreateMany: vi.fn(),
  themeUpsert: vi.fn(),
  rollupDeleteMany: vi.fn(),
  rollupCreateMany: vi.fn(),
  transaction: vi.fn(),
  generateEmbeddings: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
  writeJobRecord: vi.fn(),
  updateJobRecord: vi.fn(),
  aiUsageEventCreate: vi.fn(),
  assertGlobalAiAvailable: vi.fn(),
  recordOrReplayOnboardingMilestoneEvent: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  env: { ANTHROPIC_API_KEY: 'test-key' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@pathfinder/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/ai')>()
  return { ...actual, generateEmbeddings: mocks.generateEmbeddings }
})

vi.mock('@pathfinder/db', () => ({
  assertGlobalAiAvailable: mocks.assertGlobalAiAvailable,
  assertVenueAiAvailable: mocks.assertGlobalAiAvailable,
  reserveAiCostAttempt: vi.fn(async () => null),
  markAiCostAttemptDispatched: vi.fn(),
  settleAiCostAttemptExact: vi.fn(),
  settleAiCostAttemptAmbiguous: vi.fn(),
  releaseUndispatchedAiCostAttempt: vi.fn(),
  GlobalAiAdmissionError: class GlobalAiAdmissionError extends Error {
    name = 'GlobalAiAdmissionError'
    constructor(readonly code: string) {
      super('Global AI admission is unavailable')
    }
  },
  isAiAdmissionControlError: (error: unknown) =>
    error instanceof Error &&
    (error.name === 'GlobalAiAdmissionError' ||
      error.name === 'AiCostBudgetExceededError' ||
      error.name === 'AiCostBudgetUnavailableError' ||
      error.name === 'VenueUnavailableError'),
  db: {
    venue: { findMany: mocks.venueFindMany },
    place: { findMany: mocks.placeFindMany },
    venueKnowledgeEntry: { findMany: mocks.knowledgeFindMany },
    aiUsageEvent: { create: mocks.aiUsageEventCreate },
    message: {
      findMany: mocks.messageFindMany,
      groupBy: mocks.messageGroupBy,
      updateMany: mocks.messageUpdateMany,
    },
    analyticsEvent: {
      groupBy: mocks.analyticsGroupBy,
      findMany: mocks.analyticsFindMany,
      count: mocks.analyticsCount,
    },
    visitorSession: { findMany: mocks.visitorFindMany },
    questionCluster: { deleteMany: mocks.clusterDeleteMany, createMany: mocks.clusterCreateMany },
    venueWeeklyTheme: { upsert: mocks.themeUpsert },
    $transaction: mocks.transaction,
  },
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
  recordOrReplayOnboardingMilestoneEvent: mocks.recordOrReplayOnboardingMilestoneEvent,
}))

import {
  _setAnthropicClientForTesting,
  clusterQuestions,
  processAnalyticsEnrichmentJob,
} from './analytics-enrichment'
import { GlobalAiAdmissionError } from '@pathfinder/db'

const anthropicCreate = vi.fn()
const mockAnthropic = { messages: { create: anthropicCreate } } as AnthropicMessagesClient

const embeddingUsage = {
  provider: 'openai' as const,
  model: 'text-embedding-3-small',
  pricingVersion: 'openai-public-2026-08-07',
  usage: {
    inputTokens: 12,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
  estimatedCostUsd: 0.00000024,
  latencyMs: 3,
  attempts: 1,
  success: true,
}

type EmbeddingParams = {
  modelKey: string
  texts: string[]
  usageSink: (usage: typeof embeddingUsage & { errorCode?: string }) => Promise<void>
}

async function successfulEmbeddingBatch(params: EmbeddingParams) {
  await params.usageSink(embeddingUsage)
  return {
    ...embeddingUsage,
    embeddings: params.texts.map((_, index) => [index + 1, 0, 0]),
  }
}

describe('clusterQuestions', () => {
  it('merges near-identical embeddings and keeps the most frequent phrasing', () => {
    const clusters = clusterQuestions([
      { text: 'Where is the toilet?', embedding: [1, 0, 0] },
      { text: 'Where is the toilet?', embedding: [0.99, 0.01, 0] },
      { text: 'where is the toilet', embedding: [0.98, 0.02, 0] },
      { text: 'What time do you close?', embedding: [0, 1, 0] },
    ])

    expect(clusters).toHaveLength(2)
    expect(clusters[0]).toMatchObject({ canonicalText: 'Where is the toilet?', count: 3 })
    expect(clusters[1]).toMatchObject({ canonicalText: 'What time do you close?', count: 1 })
  })

  it('keeps dissimilar questions in separate clusters', () => {
    const clusters = clusterQuestions([
      { text: 'a', embedding: [1, 0, 0] },
      { text: 'b', embedding: [0, 1, 0] },
      { text: 'c', embedding: [0, 0, 1] },
    ])

    expect(clusters).toHaveLength(3)
  })
})

describe('processAnalyticsEnrichmentJob', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _setAnthropicClientForTesting(mockAnthropic)

    mocks.withTenantIsolationBypass.mockImplementation((fn: () => unknown) => fn())
    mocks.writeJobRecord.mockResolvedValue('job_record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.aiUsageEventCreate.mockResolvedValue({})
    mocks.assertGlobalAiAvailable.mockResolvedValue(undefined)
    mocks.recordOrReplayOnboardingMilestoneEvent.mockResolvedValue({
      event: { id: 'milestone_1' },
      replayed: false,
    })
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        dailyRollup: { deleteMany: mocks.rollupDeleteMany, createMany: mocks.rollupCreateMany },
      }),
    )

    mocks.venueFindMany.mockResolvedValue([{ id: 'venue_1' }])
    mocks.placeFindMany.mockResolvedValue([])
    mocks.knowledgeFindMany.mockResolvedValue([])
    mocks.messageFindMany.mockResolvedValue([
      { id: 'm1', content: 'where is the toilet' },
      { id: 'm2', content: 'what time do you open' },
    ])
    mocks.messageUpdateMany.mockResolvedValue({})
    mocks.messageGroupBy.mockResolvedValue([
      { topic: 'amenities_restrooms', _count: { _all: 1 } },
      { topic: 'hours_logistics', _count: { _all: 1 } },
    ])
    mocks.analyticsGroupBy.mockResolvedValue([
      { placeId: 'p1', eventType: 'place_card.viewed', _count: { _all: 3 } },
      { placeId: 'p1', eventType: 'directions.opened', _count: { _all: 1 } },
    ])
    mocks.visitorFindMany.mockResolvedValue([{ visitorId: 'v1' }, { visitorId: 'v2' }])
    mocks.analyticsCount.mockResolvedValue(1)
    // Calls in order: top-question window, content-gap window, weekly-theme window.
    // Theme window is kept below THEME_MIN_QUESTIONS so this test doesn't also
    // need to stub a themes-shaped Anthropic response.
    mocks.analyticsFindMany
      .mockResolvedValueOnce([
        { userMessage: { content: 'where is the toilet' } },
        { userMessage: { content: 'what time do you open' } },
      ])
      .mockResolvedValueOnce([{ userMessage: { content: 'is there a helipad' } }])
      .mockResolvedValueOnce([{ userMessage: { content: 'where is the toilet' } }])
    mocks.generateEmbeddings.mockImplementation(successfulEmbeddingBatch)
    mocks.clusterDeleteMany.mockResolvedValue({})
    mocks.clusterCreateMany.mockResolvedValue({})
    mocks.rollupDeleteMany.mockResolvedValue({})
    mocks.rollupCreateMany.mockResolvedValue({})

    anthropicCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '[{"index":0,"topic":"amenities_restrooms"},{"index":1,"topic":"hours_logistics"}]',
        },
      ],
      usage: { input_tokens: 20, output_tokens: 10 },
    })
  })

  it('tags topics, writes owned rollups and clusters, and completes the job record', async () => {
    await processAnalyticsEnrichmentJob({ tenantId: 'tenant_1', date: '2026-06-18T00:00:00.000Z' })

    // Topic tagging updated the messages by assigned topic.
    expect(mocks.messageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['m1'] }, tenantId: 'tenant_1' },
        data: { topic: 'amenities_restrooms' },
      }),
    )
    expect(mocks.messageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['m2'] }, tenantId: 'tenant_1' },
        data: { topic: 'hours_logistics' },
      }),
    )

    // Owned daily rollups written (and only the owned metrics deleted).
    expect(mocks.rollupDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          metric: { in: expect.arrayContaining(['unique_visitors', 'low_confidence']) },
        }),
      }),
    )
    const rollupData = mocks.rollupCreateMany.mock.calls[0]?.[0]?.data as Array<{
      metric: string
      value: number
      placeId?: string
      category?: string
    }>
    expect(rollupData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: 'unique_visitors', value: 2 }),
        expect.objectContaining({ metric: 'low_confidence', value: 1 }),
        expect.objectContaining({ metric: 'place_card_views', placeId: 'p1', value: 3 }),
        expect.objectContaining({ metric: 'place_directions', placeId: 'p1', value: 1 }),
        expect.objectContaining({ metric: 'topic', category: 'amenities_restrooms', value: 1 }),
      ]),
    )

    // Clusters replaced for both kinds.
    expect(mocks.clusterDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ kind: { in: ['top_question', 'content_gap'] } }),
      }),
    )
    const clusterData = mocks.clusterCreateMany.mock.calls[0]?.[0]?.data as Array<{ kind: string }>
    expect(clusterData.some((row) => row.kind === 'top_question')).toBe(true)
    expect(clusterData.some((row) => row.kind === 'content_gap')).toBe(true)
    expect(mocks.recordOrReplayOnboardingMilestoneEvent).toHaveBeenCalledWith({
      db: expect.any(Object),
      input: expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        eventType: 'POST_LAUNCH_MISSING_KNOWLEDGE',
        idempotencyKey: expect.stringMatching(
          /^analytics-gap:2026-06-18T00:00:00\.000Z:[a-f0-9]{64}$/u,
        ),
        occurredAt: new Date('2026-06-18T00:00:00.000Z'),
        actorType: 'SYSTEM',
        actorId: null,
        sourceType: 'ANALYTICS_CONTENT_GAP',
        sourceId: expect.stringMatching(/^[a-f0-9]{64}$/u),
        category: 'CONTENT_GAP',
      }),
    })

    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
    for (const call of mocks.analyticsFindMany.mock.calls.slice(0, 3)) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'tenant_1',
            venueId: 'venue_1',
            userMessageId: { not: null },
            userMessage: { is: { role: 'user' } },
          }),
          select: { userMessage: { select: { content: true } } },
        }),
      )
      expect(call[0]).not.toHaveProperty('select.metadata')
    }
    expect(mocks.aiUsageEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        feature: 'analytics-topic-classifier',
        surface: 'worker',
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        success: true,
      }),
    })
  })

  it('emits bounded sanitized stale-fact signals once per content review revision', async () => {
    const reviewedAt = new Date('2026-04-01T12:00:00.000Z')
    mocks.placeFindMany.mockResolvedValue([{ id: 'place_1', lastReviewedAt: reviewedAt }])
    mocks.knowledgeFindMany.mockResolvedValue([{ id: 'knowledge_1', lastReviewedAt: reviewedAt }])

    await processAnalyticsEnrichmentJob({ tenantId: 'tenant_1', date: '2026-06-18T00:00:00.000Z' })

    expect(mocks.placeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          humanConfirmedAt: { not: null },
        }),
        take: 1_000,
        select: { id: true, lastReviewedAt: true },
      }),
    )
    expect(mocks.recordOrReplayOnboardingMilestoneEvent).toHaveBeenCalledWith({
      db: expect.any(Object),
      input: expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        eventType: 'STALE_FACT',
        idempotencyKey: expect.stringMatching(/^stale-fact:[a-f0-9]{64}$/u),
        occurredAt: new Date('2026-05-31T12:00:00.000Z'),
        actorType: 'SYSTEM',
        actorId: null,
        sourceType: 'PLACE',
        sourceId: 'place_1',
        sourceRevision: reviewedAt.toISOString(),
        category: 'PLACE',
      }),
    })
    const staleCalls = mocks.recordOrReplayOnboardingMilestoneEvent.mock.calls.filter(
      ([call]) => call.input.eventType === 'STALE_FACT',
    )
    expect(staleCalls).toHaveLength(2)
    expect(JSON.stringify(staleCalls)).not.toContain('name')
    expect(JSON.stringify(staleCalls)).not.toContain('content')
  })

  it('skips unattributed legacy events without reading raw question metadata', async () => {
    mocks.analyticsFindMany.mockReset()
    mocks.analyticsFindMany
      .mockResolvedValueOnce([
        { userMessage: null, metadata: { message: 'legacy private question' } },
      ])
      .mockResolvedValueOnce([{ userMessage: null, metadata: { question: 'legacy private gap' } }])
      .mockResolvedValueOnce([{ userMessage: null, metadata: { message: 'legacy private theme' } }])

    await processAnalyticsEnrichmentJob({ tenantId: 'tenant_1', date: '2026-06-18T00:00:00.000Z' })

    expect(mocks.generateEmbeddings).not.toHaveBeenCalled()
    expect(mocks.clusterCreateMany).not.toHaveBeenCalled()
    expect(mocks.themeUpsert).not.toHaveBeenCalled()
  })

  it('synthesizes and upserts weekly themes once there are enough questions', async () => {
    // Replace beforeEach's queued once-values (which include a deliberately
    // thin theme window) with a fresh set for this test's 3 findMany calls,
    // in order: top-question window, content-gap window, weekly-theme window.
    mocks.analyticsFindMany.mockReset()
    mocks.analyticsFindMany
      .mockResolvedValueOnce([
        { userMessage: { content: 'where is the toilet' } },
        { userMessage: { content: 'what time do you open' } },
      ])
      .mockResolvedValueOnce([{ userMessage: { content: 'is there a helipad' } }])
      .mockResolvedValueOnce([
        { userMessage: { content: 'where is the toilet' } },
        { userMessage: { content: 'what time do you open' } },
        { userMessage: { content: 'is there parking nearby' } },
        { userMessage: { content: 'do you allow dogs' } },
        { userMessage: { content: 'where can I get coffee' } },
      ])

    anthropicCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: '[{"index":0,"topic":"amenities_restrooms"},{"index":1,"topic":"hours_logistics"}]',
          },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: '[{"title":"Restroom locations","explanation":"Guests frequently ask where the restrooms are."}]',
          },
        ],
        usage: { input_tokens: 30, output_tokens: 15 },
      })
    mocks.themeUpsert.mockResolvedValue({})

    await processAnalyticsEnrichmentJob({ tenantId: 'tenant_1', date: '2026-06-18T00:00:00.000Z' })

    expect(mocks.themeUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant_1',
          tenantId_venueId_weekStart: expect.objectContaining({
            tenantId: 'tenant_1',
            venueId: 'venue_1',
          }),
        },
        create: expect.objectContaining({
          themes: [
            {
              title: 'Restroom locations',
              explanation: 'Guests frequently ask where the restrooms are.',
            },
          ],
        }),
      }),
    )
    expect(mocks.aiUsageEventCreate).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          feature: 'analytics-weekly-themes',
          inputTokens: 30,
          outputTokens: 15,
          success: true,
        }),
      }),
    )
  })

  it('records malformed classifier output as failure and continues the job', async () => {
    anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"not":"an array"}' }],
      usage: { input_tokens: 12, output_tokens: 4 },
    })

    await expect(
      processAnalyticsEnrichmentJob({
        tenantId: 'tenant_1',
        date: '2026-06-18T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined()

    expect(mocks.messageUpdateMany).not.toHaveBeenCalled()
    expect(mocks.aiUsageEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        feature: 'analytics-topic-classifier',
        success: false,
        errorCode: 'invalid-structured-output',
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
      }),
    })
    const failedClassifierUsage = mocks.aiUsageEventCreate.mock.calls[0]?.[0]?.data as {
      estimatedCostUsd: number
    }
    expect(failedClassifierUsage.estimatedCostUsd).toBeGreaterThan(0)
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('propagates admission closure during topic classification', async () => {
    const error = new GlobalAiAdmissionError('global-ai-paused')
    mocks.assertGlobalAiAvailable.mockRejectedValueOnce(error)

    await expect(
      processAnalyticsEnrichmentJob({
        tenantId: 'tenant_1',
        date: '2026-06-18T00:00:00.000Z',
      }),
    ).rejects.toBe(error)
    expect(mocks.messageUpdateMany).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).not.toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('propagates admission closure during weekly theme synthesis', async () => {
    const error = new GlobalAiAdmissionError('global-ai-paused')
    mocks.analyticsFindMany.mockReset()
    mocks.analyticsFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(
        Array.from({ length: 5 }, (_, index) => ({
          userMessage: { content: `question ${index}` },
        })),
      )
    mocks.assertGlobalAiAvailable.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error)

    await expect(
      processAnalyticsEnrichmentJob({
        tenantId: 'tenant_1',
        date: '2026-06-18T00:00:00.000Z',
      }),
    ).rejects.toBe(error)
    expect(mocks.themeUpsert).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).not.toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('rebuilds topic rollups from persisted tags after an interrupted attempt resumes', async () => {
    mocks.messageFindMany.mockResolvedValueOnce([])
    mocks.messageGroupBy.mockResolvedValueOnce([
      { topic: 'amenities_restrooms', _count: { _all: 4 } },
    ])
    mocks.analyticsFindMany.mockReset()
    mocks.analyticsFindMany.mockResolvedValue([])

    await processAnalyticsEnrichmentJob({
      tenantId: 'tenant_1',
      date: '2026-06-18T00:00:00.000Z',
    })

    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.messageUpdateMany).not.toHaveBeenCalled()
    expect(mocks.rollupCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          metric: 'topic',
          category: 'amenities_restrooms',
          value: 4,
        }),
      ]),
    })
  })

  it('attributes classifier usage to each resolved venue', async () => {
    mocks.venueFindMany.mockResolvedValueOnce([{ id: 'venue_1' }, { id: 'venue_2' }])
    mocks.analyticsFindMany.mockReset()
    mocks.analyticsFindMany.mockResolvedValue([])

    await processAnalyticsEnrichmentJob({
      tenantId: 'tenant_1',
      date: '2026-06-18T00:00:00.000Z',
    })

    expect(mocks.aiUsageEventCreate).toHaveBeenCalledTimes(2)
    expect(mocks.aiUsageEventCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant_1', venueId: 'venue_1' }),
      }),
    )
    expect(mocks.aiUsageEventCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant_1', venueId: 'venue_2' }),
      }),
    )
  })

  it('records malformed weekly themes and preserves the last good row', async () => {
    mocks.analyticsFindMany.mockReset()
    mocks.analyticsFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { userMessage: { content: 'where is the toilet' } },
        { userMessage: { content: 'what time do you open' } },
        { userMessage: { content: 'is there parking nearby' } },
        { userMessage: { content: 'do you allow dogs' } },
        { userMessage: { content: 'where can I get coffee' } },
      ])
    anthropicCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: '[{"index":0,"topic":"amenities_restrooms"},{"index":1,"topic":"hours_logistics"}]',
          },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"malformed":true}' }],
        usage: { input_tokens: 30, output_tokens: 5 },
      })

    await expect(
      processAnalyticsEnrichmentJob({
        tenantId: 'tenant_1',
        date: '2026-06-18T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined()

    expect(mocks.themeUpsert).not.toHaveBeenCalled()
    expect(mocks.aiUsageEventCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          feature: 'analytics-weekly-themes',
          success: false,
          errorCode: 'invalid-structured-output',
          inputTokens: 30,
          outputTokens: 5,
          totalTokens: 35,
        }),
      }),
    )
  })

  it('batches clustering embeddings in order and attributes each request', async () => {
    const questions = Array.from({ length: 97 }, (_, index) => ({
      userMessage: { content: `question ${index}` },
    }))
    mocks.analyticsFindMany.mockReset()
    mocks.analyticsFindMany
      .mockResolvedValueOnce(questions)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    await processAnalyticsEnrichmentJob({
      tenantId: 'tenant_1',
      date: '2026-06-18T00:00:00.000Z',
    })

    expect(mocks.generateEmbeddings).toHaveBeenCalledTimes(2)
    expect(mocks.generateEmbeddings.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        modelKey: 'analytics-clustering-embedding',
        texts: Array.from({ length: 96 }, (_, index) => `question ${index}`),
      }),
    )
    expect(mocks.generateEmbeddings.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        modelKey: 'analytics-clustering-embedding',
        texts: ['question 96'],
      }),
    )
    const embeddingEvents = mocks.aiUsageEventCreate.mock.calls
      .map((call) => call[0].data)
      .filter((data) => data.feature === 'analytics-question-clustering')
    expect(embeddingEvents).toHaveLength(2)
    expect(embeddingEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          surface: 'worker',
          attempts: 1,
          success: true,
        }),
      ]),
    )
  })

  it('retains prior batch usage and preserves clusters when a later batch fails', async () => {
    const questions = Array.from({ length: 97 }, (_, index) => ({
      userMessage: { content: `question ${index}` },
    }))
    mocks.analyticsFindMany.mockReset()
    mocks.analyticsFindMany.mockResolvedValueOnce(questions)
    mocks.generateEmbeddings
      .mockImplementationOnce(successfulEmbeddingBatch)
      .mockImplementationOnce(async (params: EmbeddingParams) => {
        await params.usageSink({
          ...embeddingUsage,
          usage: { ...embeddingUsage.usage, inputTokens: 0 },
          estimatedCostUsd: 0,
          success: false,
          errorCode: 'provider-http-503',
        })
        throw new Error('OpenAI embedding request failed')
      })

    await expect(
      processAnalyticsEnrichmentJob({
        tenantId: 'tenant_1',
        date: '2026-06-18T00:00:00.000Z',
      }),
    ).rejects.toThrow('OpenAI embedding request failed')

    expect(mocks.generateEmbeddings).toHaveBeenCalledTimes(2)
    const embeddingEvents = mocks.aiUsageEventCreate.mock.calls
      .map((call) => call[0].data)
      .filter((data) => data.feature === 'analytics-question-clustering')
    expect(embeddingEvents).toEqual([
      expect.objectContaining({ success: true, attempts: 1 }),
      expect.objectContaining({ success: false, attempts: 1, errorCode: 'provider-http-503' }),
    ])
    expect(mocks.clusterDeleteMany).not.toHaveBeenCalled()
    expect(mocks.clusterCreateMany).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'OpenAI embedding request failed',
      attemptNumber: 1,
      maxAttempts: 1,
      failureDisposition: 'ATTEMPTS_EXHAUSTED',
    })
  })

  it('continues clustering when usage persistence is unavailable', async () => {
    mocks.aiUsageEventCreate.mockRejectedValue(new Error('usage db unavailable'))
    await expect(
      processAnalyticsEnrichmentJob({
        tenantId: 'tenant_1',
        date: '2026-06-18T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined()
    expect(mocks.clusterCreateMany).toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('marks the job record FAILED and rethrows on error', async () => {
    mocks.venueFindMany.mockRejectedValueOnce(new Error('db down'))

    await expect(
      processAnalyticsEnrichmentJob({ tenantId: 'tenant_1', date: '2026-06-18T00:00:00.000Z' }),
    ).rejects.toThrow('db down')

    expect(mocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_1',
      expect.objectContaining({ status: 'FAILED' }),
    )
  })
})
