import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

import { env, logger } from '@pathfinder/config'
import { db, withTenantIsolationBypass, writeJobRecord, updateJobRecord } from '@pathfinder/db'
import type { WeeklyDigestJobPayload } from '@pathfinder/jobs'

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const MESSAGE_CONTENT_LIMIT = 500
const MINIMUM_SESSION_COUNT = 5
const MAX_OUTPUT_TOKENS = 1_200

const insightSchema = z.object({
  type: z.enum(['trend', 'confusion', 'interest', 'recommendation']),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(2_000),
})

const weeklyDigestResponseSchema = z.object({
  insights: z.array(insightSchema).min(3).max(8),
})

type WeeklyDigestInsight = z.infer<typeof insightSchema>
type PromptSession = {
  sessionId: string
  venueName: string
  venueType: string | null
  startedAt: string
  lastActiveAt: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    createdAt: string
  }>
}

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

function trimMessageContent(content: string): string {
  return content.length > MESSAGE_CONTENT_LIMIT
    ? `${content.slice(0, MESSAGE_CONTENT_LIMIT).trimEnd()}...`
    : content
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

function parseDigestInsights(rawText: string): WeeklyDigestInsight[] {
  const fencedMatch =
    rawText.match(/```json\s*([\s\S]*?)```/i) ?? rawText.match(/```([\s\S]*?)```/i)
  const candidate = fencedMatch?.[1]?.trim() ?? rawText.trim()

  try {
    return weeklyDigestResponseSchema.parse(JSON.parse(candidate)).insights
  } catch {
    const firstBrace = candidate.indexOf('{')
    const lastBrace = candidate.lastIndexOf('}')

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error('Claude response did not contain valid JSON')
    }

    return weeklyDigestResponseSchema.parse(JSON.parse(candidate.slice(firstBrace, lastBrace + 1)))
      .insights
  }
}

function buildWeeklyDigestPrompt(params: {
  tenantName: string
  venueSummary: string
  weekStart: string
  weekEnd: string
  sessions: PromptSession[]
}): string {
  const responseShape = `{
  "insights": [
    {
      "type": "trend | confusion | interest | recommendation",
      "title": "Short headline (max 10 words)",
      "body": "Plain English explanation (2-4 sentences). Be specific - include counts, place names, and times where relevant. Write for a venue manager, not a data analyst."
    }
  ]
}`

  return [
    'You are generating a weekly guest-insights digest for venue managers.',
    `Tenant: ${params.tenantName}`,
    `Venue context: ${params.venueSummary}`,
    `Week start (UTC): ${params.weekStart}`,
    `Week end (UTC): ${params.weekEnd}`,
    '',
    'Analyze the conversation sessions below and return JSON only.',
    'Requirements:',
    '- Return exactly one JSON object matching this shape:',
    responseShape,
    '- Produce 3 to 8 insights total.',
    '- Order insights by importance, most actionable first.',
    '- Use only these insight types: trend, confusion, interest, recommendation.',
    '- Focus on guest confusion, unusual interest, time-of-day or day-of-week patterns, questions that suggest signage or information gaps, and surprising anomalies.',
    '- Never invent data or fill gaps with assumptions. If a point is weakly supported, omit it.',
    '- Base every insight only on the sessions provided.',
    '',
    'Sessions JSON:',
    JSON.stringify(params.sessions, null, 2),
  ].join('\n')
}

async function markDigestStatus(
  payload: WeeklyDigestJobPayload,
  data: {
    status: 'PROCESSING' | 'COMPLETE' | 'FAILED'
    sessionCount?: number
    messageCount?: number
    insights?: WeeklyDigestInsight[]
    generatedAt?: Date | null
  },
): Promise<void> {
  await withTenantIsolationBypass(async () => {
    await db.weeklyDigest.updateMany({
      where: {
        id: payload.digestId,
        tenantId: payload.tenantId,
      },
      data,
    })
  })
}

async function loadPromptSessions(payload: WeeklyDigestJobPayload) {
  const weekStart = new Date(payload.weekStart)
  const weekEnd = new Date(payload.weekEnd)

  return withTenantIsolationBypass(async () => {
    const tenant = await db.tenant.findUnique({
      where: { id: payload.tenantId },
      select: {
        name: true,
      },
    })

    if (!tenant) {
      throw new Error(`Tenant ${payload.tenantId} not found`)
    }

    const sessions = await db.visitorSession.findMany({
      where: {
        tenantId: payload.tenantId,
        messages: {
          some: {
            tenantId: payload.tenantId,
            createdAt: {
              gte: weekStart,
              lte: weekEnd,
            },
          },
        },
      },
      orderBy: {
        startedAt: 'asc',
      },
      select: {
        id: true,
        startedAt: true,
        lastActiveAt: true,
        venue: {
          select: {
            name: true,
            category: true,
          },
        },
        messages: {
          where: {
            tenantId: payload.tenantId,
            createdAt: {
              gte: weekStart,
              lte: weekEnd,
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
          select: {
            role: true,
            content: true,
            createdAt: true,
          },
        },
      },
    })

    const promptSessions: PromptSession[] = sessions
      .map((session) => ({
        sessionId: session.id,
        venueName: session.venue.name,
        venueType: session.venue.category,
        startedAt: session.startedAt.toISOString(),
        lastActiveAt: session.lastActiveAt.toISOString(),
        messages: session.messages.map((message) => ({
          role: message.role,
          content: trimMessageContent(message.content),
          createdAt: message.createdAt.toISOString(),
        })),
      }))
      .filter((session) => session.messages.length > 0)

    const venuesInSessions = Array.from(
      new Map(
        promptSessions.map((session) => [
          `${session.venueName}:${session.venueType ?? 'unknown'}`,
          session,
        ]),
      ).values(),
    )

    const venueSummary =
      venuesInSessions.length === 0
        ? 'No venue context available'
        : venuesInSessions
            .map((session) =>
              session.venueType ? `${session.venueName} (${session.venueType})` : session.venueName,
            )
            .join(', ')

    const messageCount = promptSessions.reduce(
      (total, session) => total + session.messages.length,
      0,
    )

    return {
      tenantName: tenant.name,
      venueSummary,
      sessions: promptSessions,
      sessionCount: promptSessions.length,
      messageCount,
    }
  })
}

export async function processWeeklyDigestJob(
  payload: WeeklyDigestJobPayload,
  bullJobId?: string | null,
): Promise<void> {
  const startedAt = new Date()
  await markDigestStatus(payload, { status: 'PROCESSING' })

  const jobRecordId = await writeJobRecord({
    queue: 'weekly-digest',
    jobName: 'weekly-digest-process',
    bullJobId: bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
  })

  try {
    const promptData = await loadPromptSessions(payload)

    if (promptData.sessionCount < MINIMUM_SESSION_COUNT) {
      await markDigestStatus(payload, {
        status: 'COMPLETE',
        sessionCount: promptData.sessionCount,
        messageCount: promptData.messageCount,
        insights: [],
        generatedAt: new Date(),
      })

      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

      logger.info({
        action: 'workers.weekly-digest.insufficient-data',
        tenantId: payload.tenantId,
        digestId: payload.digestId,
        sessionCount: promptData.sessionCount,
        messageCount: promptData.messageCount,
      })

      return
    }

    const prompt = buildWeeklyDigestPrompt({
      tenantName: promptData.tenantName,
      venueSummary: promptData.venueSummary,
      weekStart: payload.weekStart,
      weekEnd: payload.weekEnd,
      sessions: promptData.sessions,
    })

    const response = await getAnthropicClient().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    })

    const insights = parseDigestInsights(extractResponseText(response.content))

    await markDigestStatus(payload, {
      status: 'COMPLETE',
      sessionCount: promptData.sessionCount,
      messageCount: promptData.messageCount,
      insights,
      generatedAt: new Date(),
    })

    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.weekly-digest.completed',
      tenantId: payload.tenantId,
      digestId: payload.digestId,
      sessionCount: promptData.sessionCount,
      messageCount: promptData.messageCount,
      insightCount: insights.length,
    })
  } catch (error) {
    await markDigestStatus(payload, { status: 'FAILED' })

    await updateJobRecord(jobRecordId, {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Unknown weekly digest error',
    })

    logger.error({
      action: 'workers.weekly-digest.failed',
      tenantId: payload.tenantId,
      digestId: payload.digestId,
      error: error instanceof Error ? error.message : 'Unknown weekly digest error',
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })

    throw error
  }
}
