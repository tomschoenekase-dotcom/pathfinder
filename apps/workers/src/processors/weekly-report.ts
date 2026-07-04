import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

import { env, logger } from '@pathfinder/config'
import { db, updateJobRecord, withTenantIsolationBypass, writeJobRecord } from '@pathfinder/db'
import type { WeeklyReportJobPayload } from '@pathfinder/jobs'

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 1_800
const MAX_GENERAL_MESSAGES = 400
const MESSAGE_CONTENT_LIMIT = 500

function trimMessageContent(content: string): string {
  return content.length > MESSAGE_CONTENT_LIMIT
    ? `${content.slice(0, MESSAGE_CONTENT_LIMIT).trimEnd()}...`
    : content
}

const weeklyReportResponseSchema = z.object({
  overview: z.string().max(800),
  visitorQuestionsAndInterests: z.string().max(1200),
  specificAnalytics: z.string().max(1500),
  notableInsight: z.string().max(800),
  quotes: z.array(z.string().max(300)).min(0).max(3),
  nextSteps: z.array(z.string().max(300)).min(1).max(2),
})

type WeeklyReportResponse = z.infer<typeof weeklyReportResponseSchema>

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

function parseReport(rawText: string): WeeklyReportResponse {
  const fencedMatch =
    rawText.match(/```json\s*([\s\S]*?)```/i) ?? rawText.match(/```([\s\S]*?)```/i)
  const candidate = fencedMatch?.[1]?.trim() ?? rawText.trim()

  try {
    return weeklyReportResponseSchema.parse(JSON.parse(candidate))
  } catch {
    const firstBrace = candidate.indexOf('{')
    const lastBrace = candidate.lastIndexOf('}')

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error('Claude response did not contain valid JSON')
    }

    return weeklyReportResponseSchema.parse(JSON.parse(candidate.slice(firstBrace, lastBrace + 1)))
  }
}

function formatReportContent(params: {
  title: string
  venueName: string
  weekLabel: string
  parsed: WeeklyReportResponse
}): string {
  const { title, venueName, weekLabel, parsed } = params
  const quotesBlock =
    parsed.quotes.length > 0
      ? parsed.quotes.map((quote) => `- "${quote}"`).join('\n')
      : 'No standout quotes this week.'
  const nextStepsBlock = parsed.nextSteps.map((step, index) => `${index + 1}. ${step}`).join('\n')

  return [
    title,
    `Venue: ${venueName}`,
    `Week: ${weekLabel}`,
    '',
    'Overview',
    parsed.overview,
    '',
    'Visitor Questions & Interests',
    parsed.visitorQuestionsAndInterests,
    '',
    'Specific Analytics',
    parsed.specificAnalytics,
    '',
    'Notable Insight',
    parsed.notableInsight,
    '',
    'Visitor Quotes / Examples',
    quotesBlock,
    '',
    'Suggested Next Step',
    nextStepsBlock,
  ].join('\n')
}

async function markReportStatus(
  payload: WeeklyReportJobPayload,
  data: {
    status: 'GENERATING' | 'DRAFT' | 'FAILED'
    content?: string | null
    answerCount?: number
    sessionCount?: number
    error?: string | null
    generatedAt?: Date | null
  },
): Promise<void> {
  await withTenantIsolationBypass(async () => {
    await db.weeklyReport.updateMany({
      where: { id: payload.reportId, tenantId: payload.tenantId },
      data,
    })
  })
}

async function loadReportData(payload: WeeklyReportJobPayload) {
  const weekStart = new Date(payload.weekStart)
  const weekEnd = new Date(payload.weekEnd)

  return withTenantIsolationBypass(async () => {
    const [
      venue,
      sessionCount,
      messageCount,
      responses,
      activeQuestions,
      notableNotes,
      generalMessages,
    ] = await Promise.all([
      db.venue.findFirst({
        where: { id: payload.venueId, tenantId: payload.tenantId },
        select: { name: true, category: true },
      }),
      db.visitorSession.count({
        where: {
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          messages: { some: { createdAt: { gte: weekStart, lte: weekEnd } } },
        },
      }),
      db.message.count({
        where: {
          tenantId: payload.tenantId,
          createdAt: { gte: weekStart, lte: weekEnd },
          session: { venueId: payload.venueId },
        },
      }),
      db.engagementQuestionResponse.findMany({
        where: {
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          answeredAt: { gte: weekStart, lte: weekEnd },
        },
        orderBy: { answeredAt: 'asc' },
        select: { questionText: true, answerText: true, isAiInvented: true },
      }),
      db.engagementQuestion.findMany({
        where: { tenantId: payload.tenantId, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { prompt: true, questionType: true },
      }),
      db.adminChatlogNote.findMany({
        where: {
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          createdAt: { gte: weekStart, lte: weekEnd },
          session: { isNotable: true },
        },
        orderBy: { createdAt: 'asc' },
        select: { note: true },
      }),
      // Ordinary guest chat, not tied to any configured/invented engagement question — this
      // is what makes "Visitor Questions & Interests" reflect real conversation content
      // instead of just session/message counts.
      db.message.findMany({
        where: {
          tenantId: payload.tenantId,
          role: 'user',
          createdAt: { gte: weekStart, lte: weekEnd },
          session: { venueId: payload.venueId },
        },
        orderBy: { createdAt: 'asc' },
        take: MAX_GENERAL_MESSAGES,
        select: { content: true },
      }),
    ])

    if (!venue) {
      throw new Error(`Venue ${payload.venueId} not found`)
    }

    return {
      venue,
      sessionCount,
      messageCount,
      responses,
      activeQuestions,
      notableNotes,
      generalMessages: generalMessages.map((message) => trimMessageContent(message.content)),
    }
  })
}

function buildReportPrompt(params: {
  venueName: string
  venueCategory: string | null
  weekStart: string
  weekEnd: string
  sessionCount: number
  messageCount: number
  responses: Awaited<ReturnType<typeof loadReportData>>['responses']
  activeQuestions: Awaited<ReturnType<typeof loadReportData>>['activeQuestions']
  notableNotes: Awaited<ReturnType<typeof loadReportData>>['notableNotes']
  generalMessages: string[]
}): string {
  return [
    'You are drafting a weekly PathFinder report for a venue operator.',
    `Venue: ${params.venueName}${params.venueCategory ? ` (${params.venueCategory})` : ''}`,
    `Week start (UTC): ${params.weekStart}`,
    `Week end (UTC): ${params.weekEnd}`,
    `Session count: ${params.sessionCount}`,
    `Message count: ${params.messageCount}`,
    `Captured answer count: ${params.responses.length}`,
    '',
    'Return JSON only with keys: overview, visitorQuestionsAndInterests, specificAnalytics, notableInsight, quotes, nextSteps.',
    'Write concise plain English, not corporate language. Write like someone who actually read the conversations.',
    'Never invent data or fill gaps with assumptions. If a point is weakly supported, omit it.',
    'Base every report section only on the provided data.',
    'visitorQuestionsAndInterests should merge common questions, interests, and confusion points into one short section, drawing on both the ordinary guest chat messages and the structured answers below — an informative aside in an ordinary message counts just as much as a direct answer.',
    'specificAnalytics must directly answer each active configured engagement question using ONLY the structured captured answers (not the ordinary chat messages). If a configured question has zero answers this week, say so plainly.',
    'quotes must be paraphrased/anonymized with no names or identifying details, and may be drawn from either data source.',
    'quotes and nextSteps must always be JSON arrays — use an empty array [] for quotes if none stand out, but nextSteps must contain at least one recommendation. Never return a plain string in place of an array.',
    'If answers or sessions are low this week, say so honestly and avoid overclaiming.',
    '',
    'Active configured engagement questions JSON:',
    JSON.stringify(params.activeQuestions, null, 2),
    '',
    'Structured captured answers JSON:',
    JSON.stringify(params.responses, null, 2),
    '',
    'Ordinary guest chat messages JSON (not tied to any specific question):',
    JSON.stringify(params.generalMessages, null, 2),
    '',
    'Admin notes from notable conversations JSON:',
    JSON.stringify(
      params.notableNotes.map((note) => note.note),
      null,
      2,
    ),
  ].join('\n')
}

export async function processWeeklyReportJob(
  payload: WeeklyReportJobPayload,
  bullJobId?: string | null,
): Promise<void> {
  const startedAt = new Date()
  await markReportStatus(payload, { status: 'GENERATING', error: null })

  const jobRecordId = await writeJobRecord({
    queue: 'weekly-report',
    jobName: 'weekly-report-process',
    bullJobId: bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
  })

  try {
    const data = await loadReportData(payload)
    const prompt = buildReportPrompt({
      venueName: data.venue.name,
      venueCategory: data.venue.category,
      weekStart: payload.weekStart,
      weekEnd: payload.weekEnd,
      sessionCount: data.sessionCount,
      messageCount: data.messageCount,
      responses: data.responses,
      activeQuestions: data.activeQuestions,
      notableNotes: data.notableNotes,
      generalMessages: data.generalMessages,
    })

    const response = await getAnthropicClient().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    })

    const parsed = parseReport(extractResponseText(response.content))
    const title = 'PathFinder Weekly Report'
    const content = formatReportContent({
      title,
      venueName: data.venue.name,
      weekLabel: `${payload.weekStart.slice(0, 10)} to ${payload.weekEnd.slice(0, 10)}`,
      parsed,
    })

    await markReportStatus(payload, {
      status: 'DRAFT',
      content,
      answerCount: data.responses.length,
      sessionCount: data.sessionCount,
      error: null,
      generatedAt: new Date(),
    })
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.weekly-report.completed',
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      reportId: payload.reportId,
      answerCount: data.responses.length,
      sessionCount: data.sessionCount,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown weekly report error'
    await markReportStatus(payload, { status: 'FAILED', error: message })
    await updateJobRecord(jobRecordId, { status: 'FAILED', error: message })

    logger.error({
      action: 'workers.weekly-report.failed',
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      reportId: payload.reportId,
      error: message,
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })

    throw error
  }
}
