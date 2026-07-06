import Anthropic from '@anthropic-ai/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  venueFindMany: vi.fn(),
  messageFindMany: vi.fn(),
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
}))

vi.mock('@pathfinder/config', () => ({
  env: { ANTHROPIC_API_KEY: 'test-key' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    venue: { findMany: mocks.venueFindMany },
    message: { findMany: mocks.messageFindMany, updateMany: mocks.messageUpdateMany },
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
  generateEmbeddings: mocks.generateEmbeddings,
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))

import {
  _setAnthropicClientForTesting,
  clusterQuestions,
  processAnalyticsEnrichmentJob,
} from './analytics-enrichment'

const anthropicCreate = vi.fn()
const mockAnthropic = { messages: { create: anthropicCreate } } as unknown as Anthropic

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
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        dailyRollup: { deleteMany: mocks.rollupDeleteMany, createMany: mocks.rollupCreateMany },
      }),
    )

    mocks.venueFindMany.mockResolvedValue([{ id: 'venue_1' }])
    mocks.messageFindMany.mockResolvedValue([
      { id: 'm1', content: 'where is the toilet' },
      { id: 'm2', content: 'what time do you open' },
    ])
    mocks.messageUpdateMany.mockResolvedValue({})
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
        { metadata: { message: 'where is the toilet' } },
        { metadata: { message: 'what time do you open' } },
      ])
      .mockResolvedValueOnce([{ metadata: { question: 'is there a helipad' } }])
      .mockResolvedValueOnce([{ metadata: { message: 'where is the toilet' } }])
    mocks.generateEmbeddings.mockImplementation(async (texts: string[]) =>
      texts.map((_, index) => [index + 1, 0, 0]),
    )
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

    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('synthesizes and upserts weekly themes once there are enough questions', async () => {
    // Replace beforeEach's queued once-values (which include a deliberately
    // thin theme window) with a fresh set for this test's 3 findMany calls,
    // in order: top-question window, content-gap window, weekly-theme window.
    mocks.analyticsFindMany.mockReset()
    mocks.analyticsFindMany
      .mockResolvedValueOnce([
        { metadata: { message: 'where is the toilet' } },
        { metadata: { message: 'what time do you open' } },
      ])
      .mockResolvedValueOnce([{ metadata: { question: 'is there a helipad' } }])
      .mockResolvedValueOnce([
        { metadata: { message: 'where is the toilet' } },
        { metadata: { message: 'what time do you open' } },
        { metadata: { message: 'is there parking nearby' } },
        { metadata: { message: 'do you allow dogs' } },
        { metadata: { message: 'where can I get coffee' } },
      ])

    anthropicCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: '[{"index":0,"topic":"amenities_restrooms"},{"index":1,"topic":"hours_logistics"}]',
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: '[{"title":"Restroom locations","explanation":"Guests frequently ask where the restrooms are."}]',
          },
        ],
      })
    mocks.themeUpsert.mockResolvedValue({})

    await processAnalyticsEnrichmentJob({ tenantId: 'tenant_1', date: '2026-06-18T00:00:00.000Z' })

    expect(mocks.themeUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
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
