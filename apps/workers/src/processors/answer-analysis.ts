import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

import { env, logger } from '@pathfinder/config'
import { db, updateJobRecord, withTenantIsolationBypass, writeJobRecord } from '@pathfinder/db'
import type { AnswerAnalysisJobPayload } from '@pathfinder/jobs'

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 1_500
// Gate on combined signal (structured answers + general chat messages), not just
// engagement-question answers — a venue with no configured questions answered yet can
// still have plenty of informative guest chat to analyze.
const MINIMUM_SIGNAL_COUNT = 3
const MAX_GENERAL_MESSAGES = 300
const MESSAGE_CONTENT_LIMIT = 500

function trimMessageContent(content: string): string {
  return content.length > MESSAGE_CONTENT_LIMIT
    ? `${content.slice(0, MESSAGE_CONTENT_LIMIT).trimEnd()}...`
    : content
}

function emptyAnalysisSummary(
  answerCount: number,
  generalMessageCount: number,
): AnswerAnalysisSummary {
  return {
    liked: [],
    improve: [],
    themes: [],
    complaints: [],
    mostMentioned: [],
    sentimentSummary: 'Not enough chat activity in this range to summarize sentiment yet.',
    quotes: [],
    perQuestion: [],
    sampleSizeCaveat:
      answerCount === 0 && generalMessageCount === 0
        ? 'No engagement-question answers or guest messages were captured in this date range yet.'
        : `Only ${answerCount} engagement answer(s) and ${generalMessageCount} guest message(s) were captured in this date range — too few to draw reliable conclusions yet.`,
  }
}

const answerAnalysisResponseSchema = z.object({
  liked: z.array(z.string().max(300)).max(8),
  improve: z.array(z.string().max(300)).max(8),
  themes: z.array(z.string().max(200)).max(8),
  complaints: z.array(z.string().max(300)).max(8),
  mostMentioned: z.array(z.string().max(150)).max(8),
  sentimentSummary: z.string().max(500),
  quotes: z.array(z.string().max(300)).max(5),
  perQuestion: z
    .array(
      z.object({
        questionText: z.string().max(500),
        answerCount: z.number().int(),
        summary: z.string().max(600),
      }),
    )
    .max(20),
  sampleSizeCaveat: z.string().max(300).nullable(),
})

type AnswerAnalysisSummary = z.infer<typeof answerAnalysisResponseSchema>

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

function extractResponseText(content: Anthropic.Messages.Message['content']): string {
  return content
    .filter(
      (block): block is Extract<(typeof content)[number], { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
    .trim()
}

const ARRAY_FIELD_MAX: Record<string, number> = {
  liked: 8,
  improve: 8,
  themes: 8,
  complaints: 8,
  mostMentioned: 8,
  quotes: 5,
  perQuestion: 20,
}

// Claude occasionally overshoots an array field's requested max by one or two items.
// Truncate defensively before validating rather than failing the whole job over a minor
// formatting overshoot — a truncated analysis is far better than an endless retry loop.
function truncateAnalysisArrays(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null) {
    return parsed
  }

  const obj = parsed as Record<string, unknown>

  for (const [field, max] of Object.entries(ARRAY_FIELD_MAX)) {
    const value = obj[field]
    if (Array.isArray(value) && value.length > max) {
      obj[field] = value.slice(0, max)
    }
  }

  return obj
}

function parseAnalysis(rawText: string): AnswerAnalysisSummary {
  const fencedMatch =
    rawText.match(/```json\s*([\s\S]*?)```/i) ?? rawText.match(/```([\s\S]*?)```/i)
  const candidate = fencedMatch?.[1]?.trim() ?? rawText.trim()

  try {
    return answerAnalysisResponseSchema.parse(truncateAnalysisArrays(JSON.parse(candidate)))
  } catch {
    const firstBrace = candidate.indexOf('{')
    const lastBrace = candidate.lastIndexOf('}')

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error('Claude response did not contain valid JSON')
    }

    return answerAnalysisResponseSchema.parse(
      truncateAnalysisArrays(JSON.parse(candidate.slice(firstBrace, lastBrace + 1))),
    )
  }
}

async function markSnapshotStatus(
  payload: AnswerAnalysisJobPayload,
  data: {
    status: 'GENERATING' | 'COMPLETE' | 'FAILED'
    summary?: AnswerAnalysisSummary
    answerCount?: number
    error?: string | null
    generatedAt?: Date | null
  },
): Promise<void> {
  await withTenantIsolationBypass(async () => {
    await db.answerAnalysisSnapshot.updateMany({
      where: { id: payload.snapshotId, tenantId: payload.tenantId },
      data,
    })
  })
}

async function loadAnswers(payload: AnswerAnalysisJobPayload) {
  return withTenantIsolationBypass(async () => {
    const rangeStart = new Date(payload.rangeStart)
    const rangeEnd = new Date(payload.rangeEnd)

    const [venue, responses, generalMessages] = await Promise.all([
      db.venue.findUnique({ where: { id: payload.venueId }, select: { name: true } }),
      db.engagementQuestionResponse.findMany({
        where: {
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          answeredAt: { gte: rangeStart, lte: rangeEnd },
        },
        orderBy: { answeredAt: 'asc' },
        select: { questionText: true, answerText: true, answerType: true, isAiInvented: true },
      }),
      // Ordinary guest chat, not tied to any configured/invented engagement question —
      // this is the "chats with informal questions and statements" signal that structured
      // answers alone miss. User-role only: we're after what guests said, not the AI's replies.
      db.message.findMany({
        where: {
          tenantId: payload.tenantId,
          role: 'user',
          createdAt: { gte: rangeStart, lte: rangeEnd },
          session: { venueId: payload.venueId },
        },
        orderBy: { createdAt: 'asc' },
        take: MAX_GENERAL_MESSAGES,
        select: { content: true },
      }),
    ])

    return {
      venueName: venue?.name ?? 'Unknown venue',
      responses,
      generalMessages: generalMessages.map((message) => trimMessageContent(message.content)),
    }
  })
}

function buildPrompt(params: {
  venueName: string
  rangeStart: string
  rangeEnd: string
  responses: Awaited<ReturnType<typeof loadAnswers>>['responses']
  generalMessages: string[]
}): string {
  return [
    'You are analyzing visitor feedback signal from PathFinder guest conversations.',
    `Venue: ${params.venueName}`,
    `Range start (UTC): ${params.rangeStart}`,
    `Range end (UTC): ${params.rangeEnd}`,
    '',
    'Return exactly one JSON object with keys: liked, improve, themes, complaints, mostMentioned, sentimentSummary, quotes, perQuestion, sampleSizeCaveat.',
    'Use only the data provided below. Never invent trends, counts, quotes, or identifying details.',
    'Two data sources are provided: (1) structured answers the AI captured after directly asking a configured or invented engagement question, and (2) ordinary guest chat messages that were not answering any specific question. Draw liked, improve, themes, complaints, mostMentioned, quotes, and sentimentSummary from BOTH sources combined — an informative aside in an ordinary chat message counts just as much as a direct answer.',
    'perQuestion is the one exception: it must reflect ONLY the structured answers (source 1), since its purpose is reporting whether visitors answered the specific questions this venue configured. Summarize each distinct questionText with its answer count. If source 1 is empty, return an empty perQuestion array — do not substitute general chat content into it.',
    'Quotes must be anonymized/paraphrased and must not include names or identifying details.',
    'If total signal (structured answers plus general messages) is thin, fill sampleSizeCaveat honestly noting the small sample and avoid overclaiming; otherwise set it to null.',
    'liked, improve, themes, complaints, mostMentioned, quotes, and perQuestion must always be JSON arrays — use an empty array [] when you have nothing to report for that field. Never return a plain string in place of an array.',
    '',
    'Source 1 — structured engagement-question answers JSON:',
    JSON.stringify(
      params.responses.map((response) => ({
        questionText: response.questionText,
        answerText: response.answerText,
        answerType: response.answerType,
        isAiInvented: response.isAiInvented,
      })),
      null,
      2,
    ),
    '',
    'Source 2 — ordinary guest chat messages JSON (not tied to any specific question):',
    JSON.stringify(params.generalMessages, null, 2),
  ].join('\n')
}

export async function processAnswerAnalysisJob(
  payload: AnswerAnalysisJobPayload,
  bullJobId?: string | null,
): Promise<void> {
  const startedAt = new Date()
  await markSnapshotStatus(payload, { status: 'GENERATING', error: null })

  const jobRecordId = await writeJobRecord({
    queue: 'answer-analysis',
    jobName: 'answer-analysis-process',
    bullJobId: bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
  })

  try {
    const promptData = await loadAnswers(payload)
    const totalSignal = promptData.responses.length + promptData.generalMessages.length

    if (totalSignal < MINIMUM_SIGNAL_COUNT) {
      await markSnapshotStatus(payload, {
        status: 'COMPLETE',
        summary: emptyAnalysisSummary(
          promptData.responses.length,
          promptData.generalMessages.length,
        ),
        answerCount: promptData.responses.length,
        error: null,
        generatedAt: new Date(),
      })
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

      logger.info({
        action: 'workers.answer-analysis.insufficient-data',
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        snapshotId: payload.snapshotId,
        answerCount: promptData.responses.length,
        generalMessageCount: promptData.generalMessages.length,
      })

      return
    }

    const prompt = buildPrompt({
      venueName: promptData.venueName,
      rangeStart: payload.rangeStart,
      rangeEnd: payload.rangeEnd,
      responses: promptData.responses,
      generalMessages: promptData.generalMessages,
    })

    const response = await getAnthropicClient().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    })

    const summary = parseAnalysis(extractResponseText(response.content))

    await markSnapshotStatus(payload, {
      status: 'COMPLETE',
      summary,
      answerCount: promptData.responses.length,
      error: null,
      generatedAt: new Date(),
    })
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.answer-analysis.completed',
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      snapshotId: payload.snapshotId,
      answerCount: promptData.responses.length,
      generalMessageCount: promptData.generalMessages.length,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown answer analysis error'
    await markSnapshotStatus(payload, { status: 'FAILED', error: message })
    await updateJobRecord(jobRecordId, { status: 'FAILED', error: message })

    logger.error({
      action: 'workers.answer-analysis.failed',
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      snapshotId: payload.snapshotId,
      error: message,
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })

    throw error
  }
}
