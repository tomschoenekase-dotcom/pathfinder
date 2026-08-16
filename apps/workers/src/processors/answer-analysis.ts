import { z } from 'zod'

import {
  AI_MODEL_KEYS,
  generateText,
  setAnthropicClientForTesting,
  type AnthropicMessagesClient,
} from '@pathfinder/ai'
import { logger } from '@pathfinder/config'
import {
  acquireAnswerAnalysisExecution,
  acquireAnswerAnalysisRecoveryExecution,
  assertVenueAiAvailable,
  db,
  deferAnswerAnalysisExecution,
  GENERATION_EXECUTION_LEASE_MS,
  isAiAdmissionControlError,
  renewAnswerAnalysisExecution,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import {
  ANSWER_ANALYSIS_PROCESS_JOB,
  ANSWER_ANALYSIS_QUEUE,
  ANSWER_ANALYSIS_RECOVERY_JOB,
  type AnswerAnalysisJobPayload,
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
// Gate on combined signal (structured answers + general chat messages), not just
// engagement-question answers — a venue with no configured questions answered yet can
// still have plenty of informative guest chat to analyze.
const MINIMUM_SIGNAL_COUNT = 3
const MAX_GENERAL_MESSAGES = 300
const MESSAGE_CONTENT_LIMIT = 500
const EXECUTION_LEASED_ERROR = 'Answer analysis execution is already leased.'

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

export function _setAnthropicClientForTesting(client: AnthropicMessagesClient | null): void {
  setAnthropicClientForTesting(client)
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
  leaseToken: string,
  data: {
    status: 'COMPLETE' | 'FAILED'
    summary?: AnswerAnalysisSummary
    answerCount?: number
    error?: string | null
    generatedAt?: Date | null
  },
): Promise<void> {
  const updated = await withTenantIsolationBypass(async () => {
    return db.answerAnalysisSnapshot.updateMany({
      where: {
        id: payload.snapshotId,
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        status: 'GENERATING',
        executionLeaseToken: leaseToken,
      },
      data: {
        ...data,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      },
    })
  })
  if (updated.count !== 1) {
    throw new Error('The answer-analysis snapshot ownership state no longer matched.')
  }
}

async function loadAnswers(payload: AnswerAnalysisJobPayload) {
  return withTenantIsolationBypass(async () => {
    const rangeStart = new Date(payload.rangeStart)
    const rangeEnd = new Date(payload.rangeEnd)

    const [venue, responses, generalMessages] = await Promise.all([
      db.venue.findFirst({
        where: { id: payload.venueId, tenantId: payload.tenantId },
        select: { name: true },
      }),
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

    if (!venue) {
      throw new Error(`Venue ${payload.venueId} not found for tenant ${payload.tenantId}`)
    }

    return {
      venueName: venue.name,
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
    'You are analyzing visitor feedback signal from Torchico guest conversations.',
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
  executionInput?: JobExecutionInput,
  options: { observedLeaseToken?: string } = {},
): Promise<void> {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const startedAt = new Date()

  const jobRecordId = await writeJobRecord({
    queue: ANSWER_ANALYSIS_QUEUE,
    jobName:
      options.observedLeaseToken === undefined
        ? ANSWER_ANALYSIS_PROCESS_JOB
        : ANSWER_ANALYSIS_RECOVERY_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })
  let leaseToken: string | null = null
  let leaseConflict = false

  try {
    const claimIdentity = {
      snapshotId: payload.snapshotId,
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      rangeStart: new Date(payload.rangeStart),
      rangeEnd: new Date(payload.rangeEnd),
    }
    const acquisition =
      options.observedLeaseToken === undefined
        ? await acquireAnswerAnalysisExecution(claimIdentity)
        : await acquireAnswerAnalysisRecoveryExecution({
            ...claimIdentity,
            observedLeaseToken: options.observedLeaseToken,
          })
    if (acquisition.state !== 'acquired') {
      if (acquisition.state === 'leased') {
        leaseConflict = true
        throw new Error(EXECUTION_LEASED_ERROR)
      }
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return
    }
    const ownedLeaseToken = acquisition.leaseToken
    leaseToken = ownedLeaseToken

    const promptData = await loadAnswers(payload)
    const totalSignal = promptData.responses.length + promptData.generalMessages.length

    if (totalSignal < MINIMUM_SIGNAL_COUNT) {
      await markSnapshotStatus(payload, ownedLeaseToken, {
        status: 'COMPLETE',
        summary: emptyAnalysisSummary(
          promptData.responses.length,
          promptData.generalMessages.length,
        ),
        answerCount: promptData.responses.length,
        error: null,
        generatedAt: new Date(),
      })
      leaseToken = null
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

    const renewLease = () =>
      renewAnswerAnalysisExecution({ ...claimIdentity, leaseToken: ownedLeaseToken })
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
          modelKey: AI_MODEL_KEYS.ANSWER_ANALYSIS,
          system: [],
          messages: [{ role: 'user', content: prompt }],
          parseResponse: parseAnalysis,
          usageSink: createWorkerAiUsageSink({
            tenantId: payload.tenantId,
            venueId: payload.venueId,
            feature: 'answer-analysis',
          }),
          budgetGate: createWorkerAiBudgetGate({
            tenantId: payload.tenantId,
            venueId: payload.venueId,
            feature: 'answer-analysis',
          }),
        }),
    })

    const summary = response.parsed

    await markSnapshotStatus(payload, ownedLeaseToken, {
      status: 'COMPLETE',
      summary,
      answerCount: promptData.responses.length,
      error: null,
      generatedAt: new Date(),
    })
    leaseToken = null
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
    if (error instanceof ExecutionLeaseOwnershipLostError) {
      leaseToken = null
      await recordJobFailure({
        jobRecordId,
        error,
        errorMessage: error.message,
        execution,
      })
      throw error
    }
    if (isAiAdmissionControlError(error)) {
      if (leaseToken !== null) {
        const released = await deferAnswerAnalysisExecution({
          snapshotId: payload.snapshotId,
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          rangeStart: new Date(payload.rangeStart),
          rangeEnd: new Date(payload.rangeEnd),
          leaseToken,
        })
        if (!released) {
          logger.warn({
            action: 'workers.answer-analysis.pause-lease-release-lost',
            tenantId: payload.tenantId,
            venueId: payload.venueId,
            snapshotId: payload.snapshotId,
          })
        }
      }
      throw error
    }
    const message = error instanceof Error ? error.message : 'Unknown answer analysis error'
    if (!leaseConflict) {
      await recordJobFailure({ jobRecordId, error, errorMessage: message, execution })
    }

    if (leaseToken !== null) {
      try {
        await markSnapshotStatus(payload, leaseToken, { status: 'FAILED', error: message })
        leaseToken = null
      } catch (statusError) {
        logger.warn({
          action: 'workers.answer-analysis.failure-status-persistence-failed',
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          snapshotId: payload.snapshotId,
          error: statusError instanceof Error ? statusError.message : 'Unknown status update error',
        })
      }
    }

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
