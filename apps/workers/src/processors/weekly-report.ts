import { z } from 'zod'

import {
  AI_MODEL_KEYS,
  generateText,
  setAnthropicClientForTesting,
  type AnthropicMessagesClient,
} from '@pathfinder/ai'
import { logger } from '@pathfinder/config'
import {
  acquireWeeklyReportExecution,
  acquireWeeklyReportRecoveryExecution,
  assertVenueAiAvailable,
  db,
  deferWeeklyReportExecution,
  GENERATION_EXECUTION_LEASE_MS,
  isAiAdmissionControlError,
  renewWeeklyReportExecution,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import {
  WEEKLY_REPORT_PROCESS_JOB,
  WEEKLY_REPORT_QUEUE,
  WEEKLY_REPORT_RECOVERY_JOB,
  type WeeklyReportJobPayload,
} from '@pathfinder/jobs'

import { createWorkerAiBudgetGate, createWorkerAiUsageSink } from '../lib/ai-usage'
import {
  ExecutionLeaseOwnershipLostError,
  withExecutionLeaseHeartbeat,
} from '../lib/execution-lease-heartbeat'
import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  type JobExecutionInput,
} from '../lib/job-execution'

const MAX_GENERAL_MESSAGES = 400
const MESSAGE_CONTENT_LIMIT = 500
const WEEKLY_REPORT_EXECUTION_LEASED_ERROR =
  'Weekly report generation is already in progress. Retry this job later.'

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

export function _setAnthropicClientForTesting(client: AnthropicMessagesClient | null): void {
  setAnthropicClientForTesting(client)
}

// Claude occasionally overshoots an array field's requested max by one or two items.
// Truncate defensively before validating rather than failing the whole job over a minor
// formatting overshoot — a truncated report is far better than an endless retry loop.
function truncateReportArrays(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null) {
    return parsed
  }

  const obj = parsed as Record<string, unknown>

  if (Array.isArray(obj.quotes) && obj.quotes.length > 3) {
    obj.quotes = obj.quotes.slice(0, 3)
  }
  if (Array.isArray(obj.nextSteps) && obj.nextSteps.length > 2) {
    obj.nextSteps = obj.nextSteps.slice(0, 2)
  }

  return obj
}

function parseReport(rawText: string): WeeklyReportResponse {
  const fencedMatch =
    rawText.match(/```json\s*([\s\S]*?)```/i) ?? rawText.match(/```([\s\S]*?)```/i)
  const candidate = fencedMatch?.[1]?.trim() ?? rawText.trim()

  try {
    return weeklyReportResponseSchema.parse(truncateReportArrays(JSON.parse(candidate)))
  } catch {
    const firstBrace = candidate.indexOf('{')
    const lastBrace = candidate.lastIndexOf('}')

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error('Claude response did not contain valid JSON')
    }

    return weeklyReportResponseSchema.parse(
      truncateReportArrays(JSON.parse(candidate.slice(firstBrace, lastBrace + 1))),
    )
  }
}

function formatReportContent(params: {
  title: string
  venueName: string
  weekLabel: string
  sessionCount: number
  messageCount: number
  parsed: WeeklyReportResponse
}): string {
  const { title, venueName, weekLabel, sessionCount, messageCount, parsed } = params
  const quotesBlock =
    parsed.quotes.length > 0
      ? parsed.quotes.map((quote) => `- "${quote}"`).join('\n')
      : 'No standout quotes this week.'
  const nextStepsBlock = parsed.nextSteps.map((step, index) => `${index + 1}. ${step}`).join('\n')

  return [
    title,
    `Venue: ${venueName}`,
    `Week: ${weekLabel}`,
    // Printed directly from the counted values rather than left to the model to restate
    // in prose — Claude would sometimes describe this as "0 messages" when it meant zero
    // captured engagement answers, which are a different, often-empty metric.
    `Sessions: ${sessionCount} · Messages: ${messageCount}`,
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
  executionLeaseToken: string,
  data: {
    status: 'DRAFT' | 'FAILED'
    content?: string | null
    answerCount?: number
    sessionCount?: number
    error?: string | null
    generatedAt?: Date | null
  },
): Promise<void> {
  await withTenantIsolationBypass(async () => {
    const result = await db.weeklyReport.updateMany({
      where: {
        id: payload.reportId,
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        status: 'GENERATING',
        executionLeaseToken,
      },
      data: {
        ...data,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      },
    })

    if (result.count !== 1) {
      throw new Error('The weekly-report ownership state no longer matched.')
    }
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
          experienceScope: 'PUBLIC',
          messages: { some: { createdAt: { gte: weekStart, lte: weekEnd } } },
        },
      }),
      db.message.count({
        where: {
          tenantId: payload.tenantId,
          createdAt: { gte: weekStart, lte: weekEnd },
          session: { venueId: payload.venueId, experienceScope: 'PUBLIC' },
        },
      }),
      db.engagementQuestionResponse.findMany({
        where: {
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          answeredAt: { gte: weekStart, lte: weekEnd },
          session: { experienceScope: 'PUBLIC' },
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
          session: { isNotable: true, experienceScope: 'PUBLIC' },
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
          session: { venueId: payload.venueId, experienceScope: 'PUBLIC' },
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
    'You are drafting a weekly Torchiko report for a venue operator.',
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
  executionInput?: JobExecutionInput,
  options: { observedLeaseToken?: string } = {},
): Promise<void> {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const startedAt = new Date()

  const jobRecordId = await writeJobRecord({
    queue: WEEKLY_REPORT_QUEUE,
    jobName:
      options.observedLeaseToken === undefined
        ? WEEKLY_REPORT_PROCESS_JOB
        : WEEKLY_REPORT_RECOVERY_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })

  let executionLeaseToken: string | null = null
  let leaseConflict = false

  try {
    const claimIdentity = {
      reportId: payload.reportId,
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      weekStart: new Date(payload.weekStart),
      weekEnd: new Date(payload.weekEnd),
    }
    const acquisition =
      options.observedLeaseToken === undefined
        ? await acquireWeeklyReportExecution(claimIdentity)
        : await acquireWeeklyReportRecoveryExecution({
            ...claimIdentity,
            observedLeaseToken: options.observedLeaseToken,
          })
    if (acquisition.state !== 'acquired') {
      if (acquisition.state === 'leased') {
        leaseConflict = true
        throw new Error(WEEKLY_REPORT_EXECUTION_LEASED_ERROR)
      }
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return
    }
    const acquiredLeaseToken = acquisition.leaseToken
    executionLeaseToken = acquiredLeaseToken

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

    const renewLease = () =>
      renewWeeklyReportExecution({ ...claimIdentity, leaseToken: acquiredLeaseToken })
    const response = await withExecutionLeaseHeartbeat({
      intervalMs: Math.floor(GENERATION_EXECUTION_LEASE_MS / 3),
      renew: renewLease,
      operation: (signal) =>
        generateText({
          signal,
          admissionGuard: async () => {
            await assertVenueAiAvailable(db, {
              tenantId: payload.tenantId,
              venueId: payload.venueId,
            })
            if (!(await renewLease())) throw new ExecutionLeaseOwnershipLostError()
          },
          modelKey: AI_MODEL_KEYS.WEEKLY_REPORT,
          system: [],
          messages: [{ role: 'user', content: prompt }],
          parseResponse: parseReport,
          usageSink: createWorkerAiUsageSink({
            tenantId: payload.tenantId,
            venueId: payload.venueId,
            feature: 'weekly-report',
          }),
          budgetGate: createWorkerAiBudgetGate({
            tenantId: payload.tenantId,
            venueId: payload.venueId,
            feature: 'weekly-report',
          }),
        }),
    })

    const parsed = response.parsed
    const title = 'Torchiko Weekly Report'
    const content = formatReportContent({
      title,
      venueName: data.venue.name,
      weekLabel: `${payload.weekStart.slice(0, 10)} to ${payload.weekEnd.slice(0, 10)}`,
      sessionCount: data.sessionCount,
      messageCount: data.messageCount,
      parsed,
    })

    await markReportStatus(payload, acquiredLeaseToken, {
      status: 'DRAFT',
      content,
      answerCount: data.responses.length,
      sessionCount: data.sessionCount,
      error: null,
      generatedAt: new Date(),
    })
    executionLeaseToken = null
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
    if (error instanceof ExecutionLeaseOwnershipLostError) {
      executionLeaseToken = null
      await recordJobFailure({
        jobRecordId,
        error,
        errorMessage: error.message,
        execution,
      })
      throw error
    }
    if (isAiAdmissionControlError(error)) {
      if (executionLeaseToken !== null) {
        const released = await deferWeeklyReportExecution({
          reportId: payload.reportId,
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          weekStart: new Date(payload.weekStart),
          weekEnd: new Date(payload.weekEnd),
          leaseToken: executionLeaseToken,
        })
        if (!released) {
          logger.warn({
            action: 'workers.weekly-report.pause-lease-release-lost',
            tenantId: payload.tenantId,
            venueId: payload.venueId,
            reportId: payload.reportId,
          })
        }
      }
      throw error
    }
    const message = error instanceof Error ? error.message : 'Unknown weekly report error'
    if (!leaseConflict) {
      await recordJobFailure({ jobRecordId, error, errorMessage: message, execution })
    }

    if (executionLeaseToken !== null) {
      try {
        await markReportStatus(payload, executionLeaseToken, {
          status: 'FAILED',
          error: message,
        })
        executionLeaseToken = null
      } catch (statusError) {
        logger.warn({
          action: 'workers.weekly-report.failure-status-persistence-failed',
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          reportId: payload.reportId,
          error: statusError instanceof Error ? statusError.message : 'Unknown status update error',
        })
      }
    }

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
