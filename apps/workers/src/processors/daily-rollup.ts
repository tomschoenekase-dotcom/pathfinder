import { logger } from '@pathfinder/config'
import { aiCostDecimalToUnits, aiCostUnitsToDecimal } from '@pathfinder/ai'
import { db, withTenantIsolationBypass, writeJobRecord, updateJobRecord } from '@pathfinder/db'
import {
  DAILY_ROLLUP_PROCESS_JOB,
  DAILY_ROLLUP_QUEUE,
  type DailyRollupJobPayload,
} from '@pathfinder/jobs'

import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  type JobExecutionInput,
} from '../lib/job-execution'

type RollupRow = {
  tenantId: string
  venueId: string
  date: Date
  metric: string
  value: number
  placeId?: string
}

type AiUsageRow = {
  venueId: string
  feature: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  audioInputTokens: number
  audioOutputTokens: number
  cachedAudioInputTokens: number
  totalTokens: number
  estimatedCostUsd: unknown
  success: boolean
}

type AiCostRollupRow = {
  tenantId: string
  venueId: string
  date: Date
  feature: string
  requestCount: number
  successfulRequestCount: number
  failedRequestCount: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  audioInputTokens: number
  audioOutputTokens: number
  cachedAudioInputTokens: number
  totalTokens: number
  estimatedCostUsd: string
}

type ChatReliabilityEvent = { eventType: string; metadata: unknown }

const CHAT_TIMING_METRICS = {
  embeddingMs: ['chat_embedding_p50_ms', 'chat_embedding_p95_ms'],
  retrievalMs: ['chat_retrieval_p50_ms', 'chat_retrieval_p95_ms'],
  promptAssemblyMs: ['chat_prompt_assembly_p50_ms', 'chat_prompt_assembly_p95_ms'],
  modelMs: ['chat_model_p50_ms', 'chat_model_p95_ms'],
  persistenceMs: ['chat_persistence_p50_ms', 'chat_persistence_p95_ms'],
  totalMs: ['chat_total_p50_ms', 'chat_total_p95_ms'],
} as const

const OWNED_DAILY_ROLLUP_METRICS = [
  'sessions',
  'messages',
  'unique_place_mentions',
  'place_mentions',
  'chat_responses',
  'chat_fallbacks',
  'chat_fallback_rate_bps',
  ...Object.values(CHAT_TIMING_METRICS).flat(),
] as const

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nearestRankPercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return Math.round(sorted[Math.ceil(sorted.length * percentile) - 1] ?? 0)
}

export function buildChatReliabilityRollups(params: {
  tenantId: string
  venueId: string
  date: Date
  events: ChatReliabilityEvent[]
}): RollupRow[] {
  const responseEvents = params.events.filter((event) => event.eventType === 'message.received')
  const metadata = responseEvents.map((event) => metadataRecord(event.metadata))
  const fallbackCount = metadata.filter((entry) => entry?.fallback === true).length
  const base = { tenantId: params.tenantId, venueId: params.venueId, date: params.date }
  const rows: RollupRow[] = [
    { ...base, metric: 'chat_responses', value: responseEvents.length },
    { ...base, metric: 'chat_fallbacks', value: fallbackCount },
    {
      ...base,
      metric: 'chat_fallback_rate_bps',
      value:
        responseEvents.length === 0
          ? 0
          : Math.round((fallbackCount * 10_000) / responseEvents.length),
    },
  ]

  for (const [field, [p50Metric, p95Metric]] of Object.entries(CHAT_TIMING_METRICS)) {
    const values = metadata.flatMap((entry) => {
      const value = entry?.[field]
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [value] : []
    })
    if (values.length === 0) continue

    rows.push({ ...base, metric: p50Metric, value: nearestRankPercentile(values, 0.5) })
    rows.push({ ...base, metric: p95Metric, value: nearestRankPercentile(values, 0.95) })
  }
  return rows
}

export function buildAiCostRollups(params: {
  tenantId: string
  date: Date
  events: AiUsageRow[]
}): AiCostRollupRow[] {
  const grouped = new Map<
    string,
    Omit<AiCostRollupRow, 'estimatedCostUsd'> & { costUnits: bigint }
  >()

  for (const event of params.events) {
    const key = JSON.stringify([event.venueId, event.feature])
    const existing = grouped.get(key) ?? {
      tenantId: params.tenantId,
      venueId: event.venueId,
      date: params.date,
      feature: event.feature,
      requestCount: 0,
      successfulRequestCount: 0,
      failedRequestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      audioInputTokens: 0,
      audioOutputTokens: 0,
      cachedAudioInputTokens: 0,
      totalTokens: 0,
      costUnits: 0n,
    }

    existing.requestCount += event.requestCount
    existing.successfulRequestCount += event.success ? event.requestCount : 0
    existing.failedRequestCount += event.success ? 0 : event.requestCount
    existing.inputTokens += event.inputTokens
    existing.outputTokens += event.outputTokens
    existing.cacheCreationInputTokens += event.cacheCreationInputTokens
    existing.cacheReadInputTokens += event.cacheReadInputTokens
    existing.audioInputTokens += event.audioInputTokens
    existing.audioOutputTokens += event.audioOutputTokens
    existing.cachedAudioInputTokens += event.cachedAudioInputTokens
    existing.totalTokens += event.totalTokens
    existing.costUnits += aiCostDecimalToUnits(event.estimatedCostUsd)
    grouped.set(key, existing)
  }

  return [...grouped.values()]
    .sort((left, right) =>
      left.venueId === right.venueId
        ? left.feature.localeCompare(right.feature)
        : left.venueId.localeCompare(right.venueId),
    )
    .map(({ costUnits, ...rollup }) => ({
      ...rollup,
      estimatedCostUsd: aiCostUnitsToDecimal(costUnits),
    }))
}

function startOfUtcDay(date: Date): Date {
  const result = new Date(date)

  result.setUTCHours(0, 0, 0, 0)

  return result
}

function endOfUtcDay(date: Date): Date {
  const result = startOfUtcDay(date)

  result.setUTCDate(result.getUTCDate() + 1)

  return result
}

function normalizeForSearch(value: string): string {
  return value.toLocaleLowerCase()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countPlaceMentions(
  messages: Array<{ content: string }>,
  places: Array<{ id: string; name: string }>,
): { mentionCounts: Map<string, number>; uniqueMentionCount: number } {
  const mentionCounts = new Map<string, number>()

  for (const place of places) {
    const matcher = new RegExp(`\\b${escapeRegExp(place.name)}\\b`, 'i')
    let count = 0

    for (const message of messages) {
      if (matcher.test(message.content)) {
        count += 1
      }
    }

    if (count > 0) {
      mentionCounts.set(place.id, count)
    }
  }

  return {
    mentionCounts,
    uniqueMentionCount: mentionCounts.size,
  }
}

async function buildTenantRollups(payload: DailyRollupJobPayload): Promise<RollupRow[]> {
  const date = startOfUtcDay(new Date(payload.date))
  const nextDate = endOfUtcDay(date)

  return withTenantIsolationBypass(async () => {
    const venues = await db.venue.findMany({
      where: {
        tenantId: payload.tenantId,
        isActive: true,
      },
      select: {
        id: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    })

    const rollups: RollupRow[] = []

    for (const venue of venues) {
      const [sessionCount, messageCount, messages, places, chatEvents] = await Promise.all([
        db.visitorSession.count({
          where: {
            tenantId: payload.tenantId,
            venueId: venue.id,
            experienceScope: 'PUBLIC',
            startedAt: {
              gte: date,
              lt: nextDate,
            },
          },
        }),
        db.message.count({
          where: {
            tenantId: payload.tenantId,
            createdAt: {
              gte: date,
              lt: nextDate,
            },
            session: {
              venueId: venue.id,
              experienceScope: 'PUBLIC',
            },
          },
        }),
        db.message.findMany({
          where: {
            tenantId: payload.tenantId,
            createdAt: {
              gte: date,
              lt: nextDate,
            },
            session: {
              venueId: venue.id,
              experienceScope: 'PUBLIC',
            },
          },
          select: {
            content: true,
          },
        }),
        db.place.findMany({
          where: {
            tenantId: payload.tenantId,
            venueId: venue.id,
            isActive: true,
            visibility: 'PUBLIC',
          },
          select: {
            id: true,
            name: true,
          },
        }),
        db.analyticsEvent.findMany({
          where: {
            tenantId: payload.tenantId,
            venueId: venue.id,
            eventType: 'message.received',
            occurredAt: { gte: date, lt: nextDate },
          },
          select: { eventType: true, metadata: true },
        }),
      ])

      const normalizedMessages = messages.map((message) => ({
        content: normalizeForSearch(message.content),
      }))
      const normalizedPlaces = places.map((place) => ({
        ...place,
        name: normalizeForSearch(place.name),
      }))
      const { mentionCounts, uniqueMentionCount } = countPlaceMentions(
        normalizedMessages,
        normalizedPlaces,
      )

      rollups.push(
        {
          tenantId: payload.tenantId,
          venueId: venue.id,
          date,
          metric: 'sessions',
          value: sessionCount,
        },
        {
          tenantId: payload.tenantId,
          venueId: venue.id,
          date,
          metric: 'messages',
          value: messageCount,
        },
        {
          tenantId: payload.tenantId,
          venueId: venue.id,
          date,
          metric: 'unique_place_mentions',
          value: uniqueMentionCount,
        },
        ...buildChatReliabilityRollups({
          tenantId: payload.tenantId,
          venueId: venue.id,
          date,
          events: chatEvents,
        }),
      )

      for (const [placeId, value] of mentionCounts.entries()) {
        rollups.push({
          tenantId: payload.tenantId,
          venueId: venue.id,
          date,
          metric: 'place_mentions',
          placeId,
          value,
        })
      }
    }

    return rollups
  })
}

export async function processDailyRollupJob(
  payload: DailyRollupJobPayload,
  executionInput?: JobExecutionInput,
): Promise<void> {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const startedAt = new Date()
  const date = startOfUtcDay(new Date(payload.date))
  const nextDate = endOfUtcDay(date)

  const jobRecordId = await writeJobRecord({
    queue: DAILY_ROLLUP_QUEUE,
    jobName: DAILY_ROLLUP_PROCESS_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })

  try {
    const [rollups, groupedUsage] = await Promise.all([
      buildTenantRollups(payload),
      withTenantIsolationBypass(() =>
        db.aiUsageEvent.groupBy({
          by: ['venueId', 'feature', 'success'],
          where: {
            tenantId: payload.tenantId,
            createdAt: { gte: date, lt: nextDate },
          },
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
        }),
      ),
    ])
    const aiCostRollups = buildAiCostRollups({
      tenantId: payload.tenantId,
      date,
      events: groupedUsage.map((group) => ({
        venueId: group.venueId,
        feature: group.feature,
        success: group.success,
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

    await withTenantIsolationBypass(async () => {
      await db.$transaction(async (tx) => {
        await tx.dailyRollup.deleteMany({
          where: {
            tenantId: payload.tenantId,
            date: {
              gte: date,
              lt: nextDate,
            },
            metric: { in: [...OWNED_DAILY_ROLLUP_METRICS] },
          },
        })

        if (rollups.length > 0) {
          await tx.dailyRollup.createMany({
            data: rollups.map((rollup) => ({
              tenantId: rollup.tenantId,
              venueId: rollup.venueId,
              date: rollup.date,
              metric: rollup.metric,
              value: rollup.value,
              ...(rollup.placeId ? { placeId: rollup.placeId } : {}),
            })),
          })
        }

        await tx.aiUsageDailyRollup.deleteMany({
          where: {
            tenantId: payload.tenantId,
            date: { gte: date, lt: nextDate },
          },
        })

        if (aiCostRollups.length > 0) {
          await tx.aiUsageDailyRollup.createMany({ data: aiCostRollups })
        }
      })
    })

    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.daily-rollup.completed',
      tenantId: payload.tenantId,
      date: date.toISOString(),
      rowCount: rollups.length,
      aiCostRowCount: aiCostRollups.length,
    })
  } catch (error) {
    await recordJobFailure({
      jobRecordId,
      error,
      errorMessage: error instanceof Error ? error.message : 'Unknown daily rollup error',
      execution,
    })

    logger.error({
      action: 'workers.daily-rollup.failed',
      tenantId: payload.tenantId,
      date: date.toISOString(),
      error: error instanceof Error ? error.message : 'Unknown daily rollup error',
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })

    throw error
  }
}
