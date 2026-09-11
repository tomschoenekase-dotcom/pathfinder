import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { db } from '@pathfinder/db'
import { buildAiCostRollups } from './daily-rollup'

const integrationDescribe =
  process.env.RUN_AI_USAGE_OBSERVATION_DB_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('AI usage observation rollup (PostgreSQL)', () => {
  const suffix = randomUUID()
  const tenantId = `usage-observation-${suffix}`
  const date = new Date('2026-09-07T00:00:00.000Z')

  afterAll(async () => {
    // Usage events are immutable audit evidence. The runner drops the entire
    // disposable database instead of deleting scoped proof rows.
    await db.$disconnect()
  })

  it('persists and rolls up mixed explicit and legacy observation authority', async () => {
    await db.tenant.create({ data: { id: tenantId, name: 'Usage observation', slug: tenantId } })
    const common = {
      tenantId,
      feature: 'fixture',
      surface: 'fixture',
      provider: 'openai',
      model: 'fixture',
      pricingVersion: 'fixture-v1',
      inputTokens: 1,
      outputTokens: 0,
      totalTokens: 1,
      estimatedCostUsd: '0.01000000',
      latencyMs: 1,
      attempts: 1,
      success: false,
      createdAt: date,
    }
    await db.aiUsageEvent.createMany({
      data: [
        { ...common, usageObservationStatus: 'OBSERVED' },
        { ...common, usageObservationStatus: 'UNKNOWN' },
        { ...common, usageObservationStatus: 'NOT_DISPATCHED' },
        { ...common, usageObservationStatus: null },
      ],
    })
    const groups = await db.aiUsageEvent.groupBy({
      by: ['venueId', 'feature', 'success', 'usageObservationStatus'],
      where: { tenantId },
      _count: { _all: true },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheCreationInputTokens: true,
        cacheReadInputTokens: true,
        audioInputTokens: true,
        audioOutputTokens: true,
        cachedAudioInputTokens: true,
        totalTokens: true,
        estimatedCostUsd: true,
      },
    })
    const [rollup] = buildAiCostRollups({
      tenantId,
      date,
      events: groups.map((group) => ({
        venueId: group.venueId,
        feature: group.feature,
        success: group.success,
        usageObservationStatus: group.usageObservationStatus,
        requestCount: group._count._all,
        inputTokens: group._sum.inputTokens ?? 0,
        outputTokens: group._sum.outputTokens ?? 0,
        cacheCreationInputTokens: group._sum.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: group._sum.cacheReadInputTokens ?? 0,
        audioInputTokens: group._sum.audioInputTokens ?? 0,
        audioOutputTokens: group._sum.audioOutputTokens ?? 0,
        cachedAudioInputTokens: group._sum.cachedAudioInputTokens ?? 0,
        totalTokens: group._sum.totalTokens ?? 0,
        estimatedCostUsd: group._sum.estimatedCostUsd ?? 0,
      })),
    })
    await db.aiUsageDailyRollup.create({ data: rollup! })
    const stored = await db.aiUsageDailyRollup.findFirstOrThrow({ where: { tenantId } })
    expect(stored).toMatchObject({
      requestCount: 4,
      observedUsageRequestCount: 1,
      unknownUsageRequestCount: 1,
      notDispatchedRequestCount: 1,
      legacyUnclassifiedRequestCount: 1,
      observedTotalTokens: 1,
    })
    expect(stored.observedEstimatedCostUsd.toFixed(8)).toBe('0.01000000')
    await expect(
      db.aiUsageEvent.create({ data: { ...common, usageObservationStatus: 'GUESSED' } }),
    ).rejects.toThrow()
  })
})
