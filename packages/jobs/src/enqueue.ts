import { createHash } from 'node:crypto'

import { Queue, type JobsOptions } from 'bullmq'

import { logger } from '@pathfinder/config'

import { getBullMQConnection } from './connection'
import {
  ANSWER_ANALYSIS_PROCESS_JOB,
  ANSWER_ANALYSIS_QUEUE,
  ANSWER_ANALYSIS_RECOVERY_JOB,
  ANSWER_ANALYSIS_RETRY_BACKOFF,
  ANALYTICS_ENRICHMENT_PROCESS_JOB,
  ANALYTICS_ENRICHMENT_QUEUE,
  ANALYTICS_ENRICHMENT_RETRY_BACKOFF,
  DAILY_ROLLUP_PROCESS_JOB,
  DAILY_ROLLUP_QUEUE,
  DAILY_ROLLUP_RETRY_BACKOFF,
  EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB,
  EMBED_KNOWLEDGE_ENTRY_QUEUE,
  EMBED_KNOWLEDGE_ENTRY_RETRY_BACKOFF,
  EMBED_PLACE_PROCESS_JOB,
  EMBED_PLACE_QUEUE,
  EMBED_PLACE_RETRY_BACKOFF,
  GENERATION_DISPATCH_KICK_JOB,
  GENERATION_DISPATCH_QUEUE,
  SEND_EMAIL_QUEUE,
  SEND_WELCOME_EMAIL_JOB,
  SEND_WELCOME_EMAIL_RETRY_BACKOFF,
  MEDIA_INGESTION_PROCESS_JOB,
  MEDIA_INGESTION_QUEUE,
  MEDIA_INGESTION_RETRY_BACKOFF,
  WEEKLY_DIGEST_PROCESS_JOB,
  WEEKLY_DIGEST_QUEUE,
  WEEKLY_DIGEST_RETRY_BACKOFF,
  WEEKLY_REPORT_PROCESS_JOB,
  WEEKLY_REPORT_QUEUE,
  WEEKLY_REPORT_RECOVERY_JOB,
  WEEKLY_REPORT_RETRY_BACKOFF,
  EVALUATION_RUN_PROCESS_JOB,
  EVALUATION_RUN_QUEUE,
  EVALUATION_RUN_RETRY_BACKOFF,
} from './queues'
import { CONTENT_EMBEDDING_MAX_ATTEMPTS } from './embedding-policy'
import type {
  AnswerAnalysisJobPayload,
  AnalyticsEnrichmentJobPayload,
  DailyRollupJobPayload,
  EmbedKnowledgeEntryJobPayload,
  EmbedPlaceJobPayload,
  GenerationDispatchKickJobPayload,
  SendWelcomeEmailJobPayload,
  WeeklyDigestJobPayload,
  WeeklyReportJobPayload,
  MediaIngestionJobPayload,
  EvaluationRunJobPayload,
} from './types'

const queueCache = new Map<string, Queue>()
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const GENERATION_DISPATCH_ID_MAX_LENGTH = 200
const WELCOME_EMAIL_DELIVERY_DOMAIN = 'pathfinder-welcome-email-v1'

function validateGenerationDispatchId(dispatchId: string): void {
  if (
    typeof dispatchId !== 'string' ||
    dispatchId.trim().length === 0 ||
    dispatchId.length > GENERATION_DISPATCH_ID_MAX_LENGTH
  ) {
    throw new Error(
      `Generation dispatch ID must be a nonempty opaque identifier of at most ${GENERATION_DISPATCH_ID_MAX_LENGTH} characters`,
    )
  }
}

function generationDispatchJobId(
  target: 'kick' | 'answer-analysis' | 'weekly-report',
  dispatchId: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['pathfinder-generation-dispatch-v1', target, dispatchId]))
    .digest('hex')
  return `generation-dispatch-${target}-${digest}`
}

function normalizeObservedLeaseToken(observedLeaseToken: string): string {
  if (!UUID_PATTERN.test(observedLeaseToken)) {
    throw new Error('Observed execution lease token must be a UUID')
  }
  return observedLeaseToken.toLowerCase()
}

function recoveryJobId(type: 'answer-analysis' | 'weekly-report', identity: string[]): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['pathfinder-generation-recovery-v1', type, ...identity]))
    .digest('hex')
  return `generation-recovery-${type}-${digest}`
}

function getQueue(name: string): Queue {
  const existingQueue = queueCache.get(name)

  if (existingQueue) {
    return existingQueue
  }

  const queue = new Queue(name, {
    connection: getBullMQConnection(),
  })

  queueCache.set(name, queue)

  return queue
}

const weeklyDigestJobOptions: JobsOptions = {
  attempts: 6,
  backoff: {
    type: WEEKLY_DIGEST_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

const answerAnalysisJobOptions: JobsOptions = {
  attempts: 6,
  backoff: {
    type: ANSWER_ANALYSIS_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

const answerAnalysisRecoveryJobOptions: JobsOptions = {
  ...answerAnalysisJobOptions,
  removeOnFail: true,
}

const weeklyReportJobOptions: JobsOptions = {
  attempts: 6,
  backoff: {
    type: WEEKLY_REPORT_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

const weeklyReportRecoveryJobOptions: JobsOptions = {
  ...weeklyReportJobOptions,
  removeOnFail: true,
}

const generationDispatchKickJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: 1000,
  removeOnFail: true,
}

const dailyRollupJobOptions: JobsOptions = {
  attempts: 6,
  backoff: {
    type: DAILY_ROLLUP_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

const embedPlaceJobOptions: JobsOptions = {
  attempts: CONTENT_EMBEDDING_MAX_ATTEMPTS,
  backoff: {
    type: EMBED_PLACE_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

const embedKnowledgeEntryJobOptions: JobsOptions = {
  attempts: CONTENT_EMBEDDING_MAX_ATTEMPTS,
  backoff: {
    type: EMBED_KNOWLEDGE_ENTRY_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

const analyticsEnrichmentJobOptions: JobsOptions = {
  attempts: 6,
  backoff: {
    type: ANALYTICS_ENRICHMENT_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

const sendWelcomeEmailJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    type: SEND_WELCOME_EMAIL_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

const mediaIngestionJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: MEDIA_INGESTION_RETRY_BACKOFF },
  removeOnComplete: 100,
  removeOnFail: 500,
}

const evaluationRunJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: EVALUATION_RUN_RETRY_BACKOFF },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

/** Evaluation execution is deliberately default-off. Callers must pass the
 * operator-controlled gate explicitly; omission can never enqueue work. */
export async function enqueueEvaluationRun(
  payload: EvaluationRunJobPayload,
  options: { enabled?: boolean } = {},
): Promise<{ enqueued: boolean }> {
  if (options.enabled !== true) return { enqueued: false }
  if (!UUID_PATTERN.test(payload.runId) || !/^[0-9a-f]{64}$/u.test(payload.runIdentityHash)) {
    throw new Error('Evaluation run payload must contain a UUID and lowercase identity hash')
  }
  await getQueue(EVALUATION_RUN_QUEUE).add(EVALUATION_RUN_PROCESS_JOB, payload, {
    ...evaluationRunJobOptions,
    jobId: `evaluation-run-${payload.runId}`,
  })
  logger.info({
    action: 'jobs.evaluation-run.enqueued',
    tenantId: payload.tenantId,
    venueId: payload.venueId,
    runId: payload.runId,
  })
  return { enqueued: true }
}

export async function enqueueMediaIngestion(payload: MediaIngestionJobPayload): Promise<void> {
  const generationIdentity = createHash('sha256')
    .update(`${payload.tenantId}\0${payload.projectId}\0${payload.uploadAttemptId}`)
    .digest('hex')
  await getQueue(MEDIA_INGESTION_QUEUE).add(MEDIA_INGESTION_PROCESS_JOB, payload, {
    ...mediaIngestionJobOptions,
    jobId: `media-ingestion-${generationIdentity}`,
  })
  logger.info({
    action: 'jobs.media-ingestion.enqueued',
    tenantId: payload.tenantId,
    venueId: payload.venueId,
    projectId: payload.projectId,
  })
}

export async function enqueueWeeklyDigest(payload: WeeklyDigestJobPayload): Promise<void> {
  await getQueue(WEEKLY_DIGEST_QUEUE).add(WEEKLY_DIGEST_PROCESS_JOB, payload, {
    ...weeklyDigestJobOptions,
    jobId: `weekly-digest-${payload.digestId}`,
  })

  logger.info({
    action: 'jobs.weekly-digest.enqueued',
    tenantId: payload.tenantId,
    digestId: payload.digestId,
    weekStart: payload.weekStart,
    weekEnd: payload.weekEnd,
  })
}

export async function enqueueAnswerAnalysis(payload: AnswerAnalysisJobPayload): Promise<void> {
  await getQueue(ANSWER_ANALYSIS_QUEUE).add(ANSWER_ANALYSIS_PROCESS_JOB, payload, {
    ...answerAnalysisJobOptions,
    jobId: `answer-analysis-${payload.snapshotId}`,
  })

  logger.info({
    action: 'jobs.answer-analysis.enqueued',
    tenantId: payload.tenantId,
    venueId: payload.venueId,
    snapshotId: payload.snapshotId,
  })
}

export async function enqueueGenerationDispatchKick(dispatchId: string): Promise<void> {
  validateGenerationDispatchId(dispatchId)
  const payload: GenerationDispatchKickJobPayload = { dispatchId }

  await getQueue(GENERATION_DISPATCH_QUEUE).add(GENERATION_DISPATCH_KICK_JOB, payload, {
    ...generationDispatchKickJobOptions,
    jobId: generationDispatchJobId('kick', dispatchId),
  })

  logger.info({ action: 'jobs.generation-dispatch.kick-enqueued' })
}

export async function enqueueAnswerAnalysisDispatch(
  payload: AnswerAnalysisJobPayload,
  dispatchId: string,
): Promise<void> {
  validateGenerationDispatchId(dispatchId)

  await getQueue(ANSWER_ANALYSIS_QUEUE).add(ANSWER_ANALYSIS_PROCESS_JOB, payload, {
    ...answerAnalysisJobOptions,
    removeOnFail: true,
    jobId: generationDispatchJobId('answer-analysis', dispatchId),
  })

  logger.info({ action: 'jobs.answer-analysis.dispatch-enqueued' })
}

export async function enqueueAnswerAnalysisRecovery(
  payload: AnswerAnalysisJobPayload,
  observedLeaseToken: string,
): Promise<void> {
  const normalizedLeaseToken = normalizeObservedLeaseToken(observedLeaseToken)
  const jobId = recoveryJobId('answer-analysis', [
    payload.tenantId,
    payload.venueId,
    payload.snapshotId,
    payload.rangeStart,
    payload.rangeEnd,
    normalizedLeaseToken,
  ])

  await getQueue(ANSWER_ANALYSIS_QUEUE).add(
    ANSWER_ANALYSIS_RECOVERY_JOB,
    { ...payload, observedLeaseToken: normalizedLeaseToken },
    {
      ...answerAnalysisRecoveryJobOptions,
      jobId,
    },
  )

  logger.info({ action: 'jobs.answer-analysis.recovery-enqueued' })
}

export async function enqueueWeeklyReport(payload: WeeklyReportJobPayload): Promise<void> {
  await getQueue(WEEKLY_REPORT_QUEUE).add(WEEKLY_REPORT_PROCESS_JOB, payload, {
    ...weeklyReportJobOptions,
    jobId: `weekly-report-${payload.reportId}`,
  })

  logger.info({
    action: 'jobs.weekly-report.enqueued',
    tenantId: payload.tenantId,
    venueId: payload.venueId,
    reportId: payload.reportId,
    weekStart: payload.weekStart,
    weekEnd: payload.weekEnd,
  })
}

export async function enqueueWeeklyReportDispatch(
  payload: WeeklyReportJobPayload,
  dispatchId: string,
): Promise<void> {
  validateGenerationDispatchId(dispatchId)

  await getQueue(WEEKLY_REPORT_QUEUE).add(WEEKLY_REPORT_PROCESS_JOB, payload, {
    ...weeklyReportJobOptions,
    removeOnFail: true,
    jobId: generationDispatchJobId('weekly-report', dispatchId),
  })

  logger.info({ action: 'jobs.weekly-report.dispatch-enqueued' })
}

export async function enqueueWeeklyReportRecovery(
  payload: WeeklyReportJobPayload,
  observedLeaseToken: string,
): Promise<void> {
  const normalizedLeaseToken = normalizeObservedLeaseToken(observedLeaseToken)
  const jobId = recoveryJobId('weekly-report', [
    payload.tenantId,
    payload.venueId,
    payload.reportId,
    payload.weekStart,
    payload.weekEnd,
    normalizedLeaseToken,
  ])

  await getQueue(WEEKLY_REPORT_QUEUE).add(
    WEEKLY_REPORT_RECOVERY_JOB,
    { ...payload, observedLeaseToken: normalizedLeaseToken },
    {
      ...weeklyReportRecoveryJobOptions,
      jobId,
    },
  )

  logger.info({ action: 'jobs.weekly-report.recovery-enqueued' })
}

export async function enqueueDailyRollup(payload: DailyRollupJobPayload): Promise<void> {
  await getQueue(DAILY_ROLLUP_QUEUE).add(DAILY_ROLLUP_PROCESS_JOB, payload, {
    ...dailyRollupJobOptions,
    jobId: `daily-rollup-${payload.tenantId}-${payload.date}`,
  })

  logger.info({
    action: 'jobs.daily-rollup.enqueued',
    tenantId: payload.tenantId,
    date: payload.date,
  })
}

export async function enqueueEmbedPlace(payload: EmbedPlaceJobPayload): Promise<void> {
  await getQueue(EMBED_PLACE_QUEUE).add(EMBED_PLACE_PROCESS_JOB, payload, {
    ...embedPlaceJobOptions,
  })

  logger.info({
    action: 'jobs.embed-place.enqueued',
    tenantId: payload.tenantId,
    placeId: payload.placeId,
  })
}

export async function enqueueEmbedKnowledgeEntry(
  payload: EmbedKnowledgeEntryJobPayload,
): Promise<void> {
  await getQueue(EMBED_KNOWLEDGE_ENTRY_QUEUE).add(EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB, payload, {
    ...embedKnowledgeEntryJobOptions,
  })

  logger.info({
    action: 'jobs.embed-knowledge-entry.enqueued',
    tenantId: payload.tenantId,
    entryId: payload.entryId,
  })
}

export async function enqueueAnalyticsEnrichment(
  payload: AnalyticsEnrichmentJobPayload,
): Promise<void> {
  await getQueue(ANALYTICS_ENRICHMENT_QUEUE).add(ANALYTICS_ENRICHMENT_PROCESS_JOB, payload, {
    ...analyticsEnrichmentJobOptions,
    jobId: `analytics-enrichment-${payload.tenantId}-${payload.date}`,
  })

  logger.info({
    action: 'jobs.analytics-enrichment.enqueued',
    tenantId: payload.tenantId,
    date: payload.date,
  })
}

export async function enqueueWelcomeEmail(
  payload: Omit<SendWelcomeEmailJobPayload, 'deliveryId'>,
  deliveryId: string,
): Promise<void> {
  if (typeof deliveryId !== 'string' || deliveryId.trim().length === 0 || deliveryId.length > 200) {
    throw new Error(
      'Welcome email delivery ID must be a nonempty opaque identifier of at most 200 characters',
    )
  }

  const deliveryIdentity = createHash('sha256')
    .update(JSON.stringify([WELCOME_EMAIL_DELIVERY_DOMAIN, payload.tenantId, deliveryId]))
    .digest('hex')
  const jobPayload: SendWelcomeEmailJobPayload = { ...payload, deliveryId }

  await getQueue(SEND_EMAIL_QUEUE).add(SEND_WELCOME_EMAIL_JOB, jobPayload, {
    ...sendWelcomeEmailJobOptions,
    jobId: `send-welcome-email-${deliveryIdentity}`,
  })

  logger.info({
    action: 'jobs.send-welcome-email.enqueued',
    tenantId: payload.tenantId,
  })
}

export async function closeJobQueues(): Promise<void> {
  const queues = Array.from(queueCache.entries())
  const results = await Promise.allSettled(
    queues.map(([, queue]) => Promise.resolve().then(() => queue.close())),
  )
  const failures: Error[] = []

  results.forEach((result, index) => {
    const [name, queue] = queues[index]!
    if (result.status === 'fulfilled') {
      if (queueCache.get(name) === queue) queueCache.delete(name)
      return
    }
    const detail =
      result.reason instanceof Error ? result.reason.message : 'Unknown queue close error'
    failures.push(new Error(`${name}: ${detail}`, { cause: result.reason }))
  })

  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more cached job queues failed to close.')
  }
}
