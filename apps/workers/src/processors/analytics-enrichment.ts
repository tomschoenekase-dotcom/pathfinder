import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

import { TOPIC_KEY_SET, TOPIC_KEYS, type TopicKey } from '@pathfinder/analytics/topics'
import { env, logger } from '@pathfinder/config'
import {
  db,
  generateEmbeddings,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import type { AnalyticsEnrichmentJobPayload } from '@pathfinder/jobs'

// ---------------------------------------------------------------------------
// Tunables — ALL of these need tuning on real data. Kept here as named constants
// so they are easy to find and adjust. Cost control: every LLM/embedding call in
// this file is nightly, batched, and on cheap models (Haiku + text-embedding-3-small).
// The live chat path gains NO new model calls.
// ---------------------------------------------------------------------------

const CLUSTER_WINDOW_DAYS = 30 // rolling window for top-question + content-gap clusters
const TOP_N_CLUSTERS = 10 // clusters kept per venue per kind
const CLUSTER_SIMILARITY_THRESHOLD = 0.83 // cosine similarity to merge into a cluster
const CLUSTER_MAX_QUESTIONS = 1000 // safety cap on questions embedded per venue/kind
const CLUSTER_EXAMPLES_PER = 3 // example raw questions stored per cluster
const TOPIC_BATCH_SIZE = 20 // questions per Haiku classification call
const EMBED_BATCH_SIZE = 96 // questions per embeddings request

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'
const CLASSIFIER_MAX_TOKENS = 1_024

// Weekly themes (decision F): synthesized once per calendar week per venue, not
// nightly — regenerating unchanged data every night would just burn model calls.
const THEME_MIN_QUESTIONS = 5 // below this, guest data is too thin to summarize honestly
const THEME_MAX_QUESTIONS_FOR_PROMPT = 300
const THEME_MAX_TOKENS = 1_024

// DailyRollup metrics this job owns. It deletes ONLY these for the target day before
// re-inserting, so it never clobbers the pure-SQL daily-rollup job's rows
// (sessions/messages/place_mentions/unique_place_mentions), which runs earlier.
const OWNED_DAILY_METRICS = [
  'topic',
  'place_card_views',
  'place_card_clicks',
  'place_directions',
  'unique_visitors',
  'low_confidence',
] as const

// ---------------------------------------------------------------------------
// Anthropic client — module-level singleton with a test setter, mirroring chat.ts.
// ---------------------------------------------------------------------------

let anthropicClient: Anthropic | null = null

function getAnthropicClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured')
  }

  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  }

  return anthropicClient
}

export function _setAnthropicClientForTesting(client: Anthropic | null): void {
  anthropicClient = client
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

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

/** Monday 00:00 UTC of the week containing `date`. */
function startOfIsoWeekUtc(date: Date): Date {
  const result = startOfUtcDay(date)
  const isoDayOfWeek = (result.getUTCDay() + 6) % 7 // Mon=0 .. Sun=6
  result.setUTCDate(result.getUTCDate() - isoDayOfWeek)
  return result
}

// ---------------------------------------------------------------------------
// Topic classification (decision B)
// ---------------------------------------------------------------------------

function extractText(content: Anthropic.Messages.Message['content']): string {
  return content
    .filter(
      (block): block is Extract<(typeof content)[number], { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function parseTopicAssignments(rawText: string, count: number): TopicKey[] {
  const fenced = rawText.match(/```json\s*([\s\S]*?)```/i) ?? rawText.match(/```([\s\S]*?)```/i)
  let candidate = fenced?.[1]?.trim() ?? rawText.trim()

  const firstBracket = candidate.indexOf('[')
  const lastBracket = candidate.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidate = candidate.slice(firstBracket, lastBracket + 1)
  }

  const parsed = JSON.parse(candidate) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('Classifier response was not a JSON array')
  }

  // Default to 'other' for anything missing or off-taxonomy.
  const result: TopicKey[] = new Array(count).fill('other')
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const index = (entry as { index?: unknown }).index
    const topic = (entry as { topic?: unknown }).topic
    if (typeof index !== 'number' || index < 0 || index >= count) continue
    if (typeof topic === 'string' && TOPIC_KEY_SET.has(topic)) {
      result[index] = topic as TopicKey
    }
  }
  return result
}

/**
 * Classifies a batch of questions into the fixed taxonomy with one Haiku call.
 * Falls back to 'other' for the whole batch if the model/parse fails — a failed
 * classification must never abort the night's enrichment.
 */
async function classifyTopicBatch(questions: string[]): Promise<TopicKey[]> {
  const prompt = [
    'You label short visitor questions for a venue guide with exactly one topic each.',
    `Allowed topics: ${TOPIC_KEYS.join(', ')}.`,
    "Pick the single best fit; use 'other' when nothing fits.",
    'Return JSON only: an array of {"index": <number>, "topic": "<topic_key>"} for every question.',
    '',
    'Questions:',
    ...questions.map(
      (question, index) => `${index}. ${question.replace(/\s+/g, ' ').slice(0, 300)}`,
    ),
  ].join('\n')

  const response = await getAnthropicClient().messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: CLASSIFIER_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseTopicAssignments(extractText(response.content), questions.length)
}

// ---------------------------------------------------------------------------
// Weekly themes (decision F): title + 1-3 sentence explanation, replacing the
// old raw "top questions" and "topics" lists with something that actually reads
// as an insight.
// ---------------------------------------------------------------------------

const weeklyThemesSchema = z
  .array(
    z.object({
      title: z.string().max(80),
      explanation: z.string().max(500),
    }),
  )
  .max(3)

export type WeeklyTheme = z.infer<typeof weeklyThemesSchema>[number]

function parseWeeklyThemes(rawText: string): WeeklyTheme[] {
  const fenced = rawText.match(/```json\s*([\s\S]*?)```/i) ?? rawText.match(/```([\s\S]*?)```/i)
  let candidate = fenced?.[1]?.trim() ?? rawText.trim()

  const firstBracket = candidate.indexOf('[')
  const lastBracket = candidate.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidate = candidate.slice(firstBracket, lastBracket + 1)
  }

  return weeklyThemesSchema.parse(JSON.parse(candidate)).slice(0, 3)
}

/**
 * Synthesizes up to 3 named themes from a venue's recent guest questions —
 * a title and a short explanation each, instead of a flat frequency list.
 * Returns [] on any model/parse failure; the caller treats that as "skip".
 */
async function synthesizeWeeklyThemes(questions: string[]): Promise<WeeklyTheme[]> {
  const trimmed = questions.slice(0, THEME_MAX_QUESTIONS_FOR_PROMPT)

  const prompt = [
    'You are analyzing a week of guest questions asked to a venue guide chatbot.',
    'Identify up to 3 recurring themes across these questions.',
    'For each theme, write a short title (5 words or fewer) and a 1-3 sentence plain-English explanation of what guests are asking and why it might matter to the venue operator.',
    'Do not just restate a single question — describe the pattern across multiple questions.',
    'Only report themes that are actually supported by the questions below; return fewer than 3 if the data does not support more.',
    'Return JSON only: an array of {"title": "...", "explanation": "..."}.',
    '',
    'Guest questions:',
    JSON.stringify(trimmed),
  ].join('\n')

  const response = await getAnthropicClient().messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: THEME_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseWeeklyThemes(extractText(response.content))
}

// ---------------------------------------------------------------------------
// Greedy question clustering (decisions C + E)
// ---------------------------------------------------------------------------

export type QuestionCluster = {
  canonicalText: string
  count: number
  examples: string[]
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

type WorkingCluster = {
  centroidSum: number[]
  count: number
  textCounts: Map<string, number>
}

/**
 * Greedy single-pass cosine clustering of question embeddings. Representative
 * phrasing is the most frequent verbatim question in the cluster. Pure function
 * (no IO) so it is straightforward to unit test.
 */
export function clusterQuestions(
  items: Array<{ text: string; embedding: number[] }>,
): QuestionCluster[] {
  const clusters: WorkingCluster[] = []

  for (const item of items) {
    let best: WorkingCluster | null = null
    let bestSim = CLUSTER_SIMILARITY_THRESHOLD

    for (const cluster of clusters) {
      const centroid = cluster.centroidSum.map((value) => value / cluster.count)
      const sim = cosineSim(item.embedding, centroid)
      if (sim >= bestSim) {
        best = cluster
        bestSim = sim
      }
    }

    if (best) {
      for (let i = 0; i < best.centroidSum.length; i += 1) {
        best.centroidSum[i]! += item.embedding[i]!
      }
      best.count += 1
      best.textCounts.set(item.text, (best.textCounts.get(item.text) ?? 0) + 1)
    } else {
      clusters.push({
        centroidSum: [...item.embedding],
        count: 1,
        textCounts: new Map([[item.text, 1]]),
      })
    }
  }

  return clusters
    .map((cluster) => {
      const ranked = Array.from(cluster.textCounts.entries()).sort((a, b) => b[1] - a[1])
      return {
        canonicalText: ranked[0]?.[0] ?? '',
        count: cluster.count,
        examples: ranked.slice(0, CLUSTER_EXAMPLES_PER).map(([text]) => text),
      }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N_CLUSTERS)
}

async function buildClusters(questions: string[]): Promise<QuestionCluster[]> {
  const trimmed = questions
    .map((question) => question.trim())
    .filter((question) => question.length > 0)
    .slice(0, CLUSTER_MAX_QUESTIONS)

  if (trimmed.length === 0) {
    return []
  }

  const embeddings: number[][] = []
  for (let i = 0; i < trimmed.length; i += EMBED_BATCH_SIZE) {
    const batch = trimmed.slice(i, i + EMBED_BATCH_SIZE)
    embeddings.push(...(await generateEmbeddings(batch)))
  }

  const items = trimmed.map((text, index) => ({ text, embedding: embeddings[index]! }))
  return clusterQuestions(items)
}

// ---------------------------------------------------------------------------
// Per-venue enrichment
// ---------------------------------------------------------------------------

type OwnedRollup = {
  metric: (typeof OWNED_DAILY_METRICS)[number]
  value: number
  placeId?: string
  category?: string
}

function questionFromMetadata(metadata: unknown, key: 'message' | 'question'): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

async function enrichVenue(params: {
  tenantId: string
  venueId: string
  dayStart: Date
  dayEnd: Date
  windowStart: Date
}): Promise<{ rollups: OwnedRollup[]; clustersWritten: number; themesWritten: number }> {
  const { tenantId, venueId, dayStart, dayEnd, windowStart } = params
  const rollups: OwnedRollup[] = []

  // --- 1. Topic tagging (B): classify the day's still-untagged user messages ---
  const untaggedMessages = await db.message.findMany({
    where: {
      tenantId,
      role: 'user',
      topic: null,
      createdAt: { gte: dayStart, lt: dayEnd },
      session: { venueId },
    },
    select: { id: true, content: true },
  })

  const topicCounts = new Map<string, number>()
  for (let i = 0; i < untaggedMessages.length; i += TOPIC_BATCH_SIZE) {
    const batch = untaggedMessages.slice(i, i + TOPIC_BATCH_SIZE)
    let topics: TopicKey[]
    try {
      topics = await classifyTopicBatch(batch.map((message) => message.content))
    } catch (error) {
      logger.warn({
        action: 'workers.analytics-enrichment.classify-failed',
        tenantId,
        venueId,
        error: error instanceof Error ? error.message : 'Unknown classifier error',
      })
      continue
    }

    // Group message ids by assigned topic and update in one statement per topic.
    const idsByTopic = new Map<TopicKey, string[]>()
    batch.forEach((message, index) => {
      const topic = topics[index] ?? 'other'
      const ids = idsByTopic.get(topic) ?? []
      ids.push(message.id)
      idsByTopic.set(topic, ids)
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1)
    })

    for (const [topic, ids] of idsByTopic.entries()) {
      await db.message.updateMany({ where: { id: { in: ids }, tenantId }, data: { topic } })
    }
  }

  for (const [topic, value] of topicCounts.entries()) {
    rollups.push({ metric: 'topic', category: topic, value })
  }

  // --- 4. Place interest (A1): per-place event counts for the day ---
  const placeEvents = await db.analyticsEvent.groupBy({
    by: ['placeId', 'eventType'],
    where: {
      tenantId,
      venueId,
      placeId: { not: null },
      eventType: { in: ['place_card.viewed', 'place_card.clicked', 'directions.opened'] },
      occurredAt: { gte: dayStart, lt: dayEnd },
    },
    _count: { _all: true },
  })

  const metricByEvent: Record<string, OwnedRollup['metric']> = {
    'place_card.viewed': 'place_card_views',
    'place_card.clicked': 'place_card_clicks',
    'directions.opened': 'place_directions',
  }
  for (const row of placeEvents) {
    const metric = metricByEvent[row.eventType]
    if (!metric || !row.placeId) continue
    rollups.push({ metric, placeId: row.placeId, value: row._count._all })
  }

  // --- 5. Unique visitors (D): distinct visitorId among sessions started today ---
  const distinctVisitors = await db.visitorSession.findMany({
    where: {
      tenantId,
      venueId,
      visitorId: { not: null },
      startedAt: { gte: dayStart, lt: dayEnd },
    },
    select: { visitorId: true },
    distinct: ['visitorId'],
  })
  rollups.push({ metric: 'unique_visitors', value: distinctVisitors.length })

  // --- low-confidence count for the day (content-gap volume signal) ---
  const lowConfidenceToday = await db.analyticsEvent.count({
    where: {
      tenantId,
      venueId,
      eventType: 'message.low_confidence',
      occurredAt: { gte: dayStart, lt: dayEnd },
    },
  })
  rollups.push({ metric: 'low_confidence', value: lowConfidenceToday })

  // --- 2. Top-question clusters (C) over the rolling window ---
  const windowQuestions = await db.analyticsEvent.findMany({
    where: {
      tenantId,
      venueId,
      eventType: 'message.sent',
      occurredAt: { gte: windowStart, lt: dayEnd },
    },
    orderBy: { occurredAt: 'desc' },
    take: CLUSTER_MAX_QUESTIONS,
    select: { metadata: true },
  })
  const topQuestionTexts = windowQuestions
    .map((event) => questionFromMetadata(event.metadata, 'message'))
    .filter((text): text is string => text !== null)
  const topClusters = await buildClusters(topQuestionTexts)

  // --- 3. Content-gap clusters (E) over the rolling window ---
  const gapEvents = await db.analyticsEvent.findMany({
    where: {
      tenantId,
      venueId,
      eventType: 'message.low_confidence',
      occurredAt: { gte: windowStart, lt: dayEnd },
    },
    orderBy: { occurredAt: 'desc' },
    take: CLUSTER_MAX_QUESTIONS,
    select: { metadata: true },
  })
  const gapTexts = gapEvents
    .map((event) => questionFromMetadata(event.metadata, 'question'))
    .filter((text): text is string => text !== null)
  const gapClusters = await buildClusters(gapTexts)

  // --- Weekly themes (F): refreshed nightly from a trailing 7-day window, keyed
  // by the calendar week containing today so the row converges over the week
  // rather than resetting each night. Skips (leaves last good themes alone)
  // when there isn't enough data to summarize honestly.
  const themeWindowStart = new Date(dayEnd)
  themeWindowStart.setUTCDate(themeWindowStart.getUTCDate() - 7)
  const themeEvents = await db.analyticsEvent.findMany({
    where: {
      tenantId,
      venueId,
      eventType: 'message.sent',
      occurredAt: { gte: themeWindowStart, lt: dayEnd },
    },
    orderBy: { occurredAt: 'desc' },
    take: CLUSTER_MAX_QUESTIONS,
    select: { metadata: true },
  })
  const themeQuestions = themeEvents
    .map((event) => questionFromMetadata(event.metadata, 'message'))
    .filter((text): text is string => text !== null)

  let themesWritten = 0
  if (themeQuestions.length >= THEME_MIN_QUESTIONS) {
    try {
      const themes = await synthesizeWeeklyThemes(themeQuestions)
      if (themes.length > 0) {
        const weekStart = startOfIsoWeekUtc(dayStart)
        const weekEnd = new Date(weekStart)
        weekEnd.setUTCDate(weekEnd.getUTCDate() + 7)

        await db.venueWeeklyTheme.upsert({
          where: { tenantId_venueId_weekStart: { tenantId, venueId, weekStart } },
          create: { tenantId, venueId, weekStart, weekEnd, themes },
          update: { themes, generatedAt: new Date() },
        })
        themesWritten = themes.length
      }
    } catch (error) {
      logger.warn({
        action: 'workers.analytics-enrichment.themes-failed',
        tenantId,
        venueId,
        error: error instanceof Error ? error.message : 'Unknown themes error',
      })
    }
  }

  // Replace this venue's clusters for both kinds.
  await db.questionCluster.deleteMany({
    where: { tenantId, venueId, kind: { in: ['top_question', 'content_gap'] } },
  })

  const clusterRows = [
    ...topClusters.map((cluster) => ({ ...cluster, kind: 'top_question' })),
    ...gapClusters.map((cluster) => ({ ...cluster, kind: 'content_gap' })),
  ]

  if (clusterRows.length > 0) {
    await db.questionCluster.createMany({
      data: clusterRows.map((cluster) => ({
        tenantId,
        venueId,
        kind: cluster.kind,
        windowStart,
        windowEnd: dayEnd,
        canonicalText: cluster.canonicalText,
        count: cluster.count,
        examples: cluster.examples,
      })),
    })
  }

  return { rollups, clustersWritten: clusterRows.length, themesWritten }
}

// ---------------------------------------------------------------------------
// Processor entrypoint — one process job per active tenant.
// ---------------------------------------------------------------------------

export async function processAnalyticsEnrichmentJob(
  payload: AnalyticsEnrichmentJobPayload,
  bullJobId?: string | null,
): Promise<void> {
  const startedAt = new Date()
  const dayStart = startOfUtcDay(new Date(payload.date))
  const dayEnd = endOfUtcDay(dayStart)
  const windowStart = startOfUtcDay(new Date(dayStart))
  windowStart.setUTCDate(windowStart.getUTCDate() - (CLUSTER_WINDOW_DAYS - 1))

  const jobRecordId = await writeJobRecord({
    queue: 'analytics-enrichment',
    jobName: 'analytics-enrichment-process',
    bullJobId: bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
  })

  try {
    let totalRollups = 0
    let totalClusters = 0
    let totalThemes = 0

    await withTenantIsolationBypass(async () => {
      const venues = await db.venue.findMany({
        where: { tenantId: payload.tenantId, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })

      for (const venue of venues) {
        const { rollups, clustersWritten, themesWritten } = await enrichVenue({
          tenantId: payload.tenantId,
          venueId: venue.id,
          dayStart,
          dayEnd,
          windowStart,
        })
        totalClusters += clustersWritten
        totalThemes += themesWritten

        // Replace only the metrics this job owns for the day, then insert fresh
        // values — never touch the daily-rollup job's rows.
        await db.$transaction(async (tx) => {
          await tx.dailyRollup.deleteMany({
            where: {
              tenantId: payload.tenantId,
              venueId: venue.id,
              date: dayStart,
              metric: { in: [...OWNED_DAILY_METRICS] },
            },
          })

          if (rollups.length > 0) {
            await tx.dailyRollup.createMany({
              data: rollups.map((rollup) => ({
                tenantId: payload.tenantId,
                venueId: venue.id,
                date: dayStart,
                metric: rollup.metric,
                value: rollup.value,
                ...(rollup.placeId ? { placeId: rollup.placeId } : {}),
                ...(rollup.category ? { category: rollup.category } : {}),
              })),
            })
          }
        })

        totalRollups += rollups.length
      }
    })

    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.analytics-enrichment.completed',
      tenantId: payload.tenantId,
      date: dayStart.toISOString(),
      rollupCount: totalRollups,
      clusterCount: totalClusters,
      themeCount: totalThemes,
    })
  } catch (error) {
    await updateJobRecord(jobRecordId, {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Unknown analytics enrichment error',
    })

    logger.error({
      action: 'workers.analytics-enrichment.failed',
      tenantId: payload.tenantId,
      date: dayStart.toISOString(),
      error: error instanceof Error ? error.message : 'Unknown analytics enrichment error',
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })

    throw error
  }
}
