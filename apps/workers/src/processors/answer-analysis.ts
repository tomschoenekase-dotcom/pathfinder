import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

import { env, logger } from '@pathfinder/config'
import { db, updateJobRecord, withTenantIsolationBypass, writeJobRecord } from '@pathfinder/db'
import type { AnswerAnalysisJobPayload } from '@pathfinder/jobs'

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 1_500

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

function parseAnalysis(rawText: string): AnswerAnalysisSummary {
  const fencedMatch =
    rawText.match(/```json\s*([\s\S]*?)```/i) ?? rawText.match(/```([\s\S]*?)```/i)
  const candidate = fencedMatch?.[1]?.trim() ?? rawText.trim()

  try {
    return answerAnalysisResponseSchema.parse(JSON.parse(candidate))
  } catch {
    const firstBrace = candidate.indexOf('{')
    const lastBrace = candidate.lastIndexOf('}')

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error('Claude response did not contain valid JSON')
    }

    return answerAnalysisResponseSchema.parse(
      JSON.parse(candidate.slice(firstBrace, lastBrace + 1)),
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
    const [venue, responses] = await Promise.all([
      db.venue.findUnique({ where: { id: payload.venueId }, select: { name: true } }),
      db.engagementQuestionResponse.findMany({
        where: {
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          answeredAt: { gte: new Date(payload.rangeStart), lte: new Date(payload.rangeEnd) },
        },
        orderBy: { answeredAt: 'asc' },
        select: { questionText: true, answerText: true, answerType: true, isAiInvented: true },
      }),
    ])

    return { venueName: venue?.name ?? 'Unknown venue', responses }
  })
}

function buildPrompt(params: {
  venueName: string
  rangeStart: string
  rangeEnd: string
  responses: Awaited<ReturnType<typeof loadAnswers>>['responses']
}): string {
  return [
    'You are analyzing captured visitor answers from PathFinder guest conversations.',
    `Venue: ${params.venueName}`,
    `Range start (UTC): ${params.rangeStart}`,
    `Range end (UTC): ${params.rangeEnd}`,
    '',
    'Return exactly one JSON object with keys: liked, improve, themes, complaints, mostMentioned, sentimentSummary, quotes, perQuestion, sampleSizeCaveat.',
    'Use only the provided answers. Never invent trends, counts, quotes, or identifying details.',
    'Summarize what visitors liked, what to improve, common themes, repeated complaints or confusion, most mentioned activities/areas, and overall sentiment.',
    'Quotes must be anonymized/paraphrased and must not include names or identifying details.',
    'perQuestion must directly summarize each distinct questionText and include the answer count for that question.',
    'If there are fewer than 8 total answers, fill sampleSizeCaveat honestly noting the small sample and avoid overclaiming; otherwise set it to null.',
    '',
    'Answers JSON:',
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
    const prompt = buildPrompt({
      venueName: promptData.venueName,
      rangeStart: payload.rangeStart,
      rangeEnd: payload.rangeEnd,
      responses: promptData.responses,
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
