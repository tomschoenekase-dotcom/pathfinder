import { Queue, type JobsOptions } from 'bullmq'

import { logger } from '@pathfinder/config'

import { getBullMQConnection } from './connection'
import {
  ANSWER_ANALYSIS_PROCESS_JOB,
  ANSWER_ANALYSIS_QUEUE,
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
  SEND_EMAIL_QUEUE,
  SEND_WELCOME_EMAIL_JOB,
  SEND_WELCOME_EMAIL_RETRY_BACKOFF,
  WEEKLY_DIGEST_PROCESS_JOB,
  WEEKLY_DIGEST_QUEUE,
  WEEKLY_DIGEST_RETRY_BACKOFF,
  WEEKLY_REPORT_PROCESS_JOB,
  WEEKLY_REPORT_QUEUE,
  WEEKLY_REPORT_RETRY_BACKOFF,
} from './queues'
import type {
  AnswerAnalysisJobPayload,
  AnalyticsEnrichmentJobPayload,
  DailyRollupJobPayload,
  EmbedKnowledgeEntryJobPayload,
  EmbedPlaceJobPayload,
  SendWelcomeEmailJobPayload,
  WeeklyDigestJobPayload,
  WeeklyReportJobPayload,
} from './types'

const queueCache = new Map<string, Queue>()

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

const weeklyReportJobOptions: JobsOptions = {
  attempts: 6,
  backoff: {
    type: WEEKLY_REPORT_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
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
  attempts: 6,
  backoff: {
    type: EMBED_PLACE_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

const embedKnowledgeEntryJobOptions: JobsOptions = {
  attempts: 6,
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
    jobId: `embed-place-${payload.placeId}`,
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
    jobId: `embed-knowledge-entry-${payload.entryId}`,
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

export async function enqueueWelcomeEmail(payload: SendWelcomeEmailJobPayload): Promise<void> {
  await getQueue(SEND_EMAIL_QUEUE).add(SEND_WELCOME_EMAIL_JOB, payload, {
    ...sendWelcomeEmailJobOptions,
    jobId: `send-welcome-email-${payload.tenantId}`,
  })

  logger.info({
    action: 'jobs.send-welcome-email.enqueued',
    tenantId: payload.tenantId,
  })
}

export async function closeJobQueues(): Promise<void> {
  const queues = Array.from(queueCache.values())
  queueCache.clear()

  await Promise.all(queues.map(async (queue) => queue.close()))
}
