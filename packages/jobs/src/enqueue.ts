import { createHash } from 'node:crypto'

import { Queue, type JobsOptions } from 'bullmq'

import { logger } from '@pathfinder/config'

import { getBullMQConnection } from './connection'
import {
  AGENT_RUN_PROCESS_JOB,
  AGENT_RUN_QUEUE,
  AGENT_RUN_RETRY_BACKOFF,
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
  EMBED_COMPANY_KNOWLEDGE_PROCESS_JOB,
  EMBED_KNOWLEDGE_ENTRY_QUEUE,
  EMBED_KNOWLEDGE_ENTRY_RETRY_BACKOFF,
  EMBED_PLACE_PROCESS_JOB,
  EMBED_PLACE_QUEUE,
  EMBED_PLACE_RETRY_BACKOFF,
  GENERATION_DISPATCH_KICK_JOB,
  GENERATION_DISPATCH_QUEUE,
  GMAIL_SYNC_NOTIFICATION_JOB,
  GMAIL_SYNC_QUEUE,
  GMAIL_SYNC_RECONCILIATION_JOB,
  GMAIL_SYNC_WATCH_RENEWAL_JOB,
  INTAKE_UPLOAD_VERIFICATION_PROCESS_JOB,
  INTAKE_UPLOAD_VERIFICATION_QUEUE,
  SEND_EMAIL_QUEUE,
  SEND_WELCOME_EMAIL_JOB,
  SEND_WELCOME_EMAIL_RETRY_BACKOFF,
  SEND_PROSPECT_OUTREACH_JOB,
  SEND_PROSPECT_OUTREACH_RETRY_BACKOFF,
  MEDIA_INGESTION_PROCESS_JOB,
  MEDIA_INGESTION_QUEUE,
  MEDIA_INGESTION_RETRY_BACKOFF,
  OPERATIONAL_QUEUE_NAMES,
  PROSPECT_IMPORT_COMMIT_JOB,
  PROSPECT_IMPORT_INSPECT_JOB,
  PROSPECT_IMPORT_STAGE_JOB,
  PROSPECT_IMPORT_QUEUE,
  PROSPECT_IMPORT_RETRY_BACKOFF,
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
  GUEST_ANSWER_ATTRIBUTION_EVALUATION_PROCESS_JOB,
  GUEST_ANSWER_ATTRIBUTION_EVALUATION_QUEUE,
} from './queues'
import { CONTENT_EMBEDDING_MAX_ATTEMPTS } from './embedding-policy'
import type {
  AgentRunJobPayload,
  AnswerAnalysisJobPayload,
  AnalyticsEnrichmentJobPayload,
  DailyRollupJobPayload,
  EmbedCompanyKnowledgeJobPayload,
  EmbedKnowledgeEntryJobPayload,
  EmbedPlaceJobPayload,
  GenerationDispatchKickJobPayload,
  SendWelcomeEmailJobPayload,
  SendProspectOutreachJobPayload,
  WeeklyDigestJobPayload,
  WeeklyReportJobPayload,
  MediaIngestionJobPayload,
  EvaluationRunJobPayload,
  GuestAnswerAttributionEvaluationJobPayload,
  ProspectImportCommitJobPayload,
  ProspectImportInspectionJobPayload,
  ProspectImportStagingJobPayload,
  GmailSyncJobPayload,
  IntakeUploadVerificationJobPayload,
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

const sendProspectOutreachJobOptions: JobsOptions = {
  attempts: 4,
  backoff: { type: SEND_PROSPECT_OUTREACH_RETRY_BACKOFF },
  removeOnComplete: 5000,
  removeOnFail: 10000,
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

const agentRunJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: AGENT_RUN_RETRY_BACKOFF },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

const prospectImportJobOptions: JobsOptions = {
  attempts: 6,
  backoff: { type: PROSPECT_IMPORT_RETRY_BACKOFF },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

export async function enqueueProspectImportCommit(
  payload: ProspectImportCommitJobPayload,
): Promise<void> {
  if (!payload.importId.trim() || payload.importId.length > 191) {
    throw new Error('Prospect import payload requires an exact import identity')
  }
  const queue = getQueue(PROSPECT_IMPORT_QUEUE)
  const jobId = `prospect-import-${payload.importId}`
  const retained = await queue.getJob(jobId)
  const retainedState = retained ? await retained.getState() : null
  if (retained && retainedState === 'failed') {
    await retained.retry('failed')
    logger.info({ action: 'jobs.prospect-import.redriven', importId: payload.importId })
    return
  }
  if (retainedState === 'completed') {
    // Durable row state is already terminal for this exact approved import.
    return
  }
  await queue.add(PROSPECT_IMPORT_COMMIT_JOB, payload, {
    ...prospectImportJobOptions,
    jobId,
  })
  logger.info({ action: 'jobs.prospect-import.enqueued', importId: payload.importId })
}

export async function enqueueProspectImportInspection(
  payload: ProspectImportInspectionJobPayload,
): Promise<void> {
  if (!payload.importId || payload.importId.length > 191)
    throw new Error('Valid import ID required')
  await getQueue(PROSPECT_IMPORT_QUEUE).add(PROSPECT_IMPORT_INSPECT_JOB, payload, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    jobId: `prospect-import-inspect-${payload.importId}-${Date.now()}`,
    removeOnComplete: 100,
    removeOnFail: 500,
  })
}

export async function enqueueProspectImportStaging(
  payload: ProspectImportStagingJobPayload,
): Promise<void> {
  if (!payload.importId || payload.importId.length > 191)
    throw new Error('Valid import ID required')
  await getQueue(PROSPECT_IMPORT_QUEUE).add(PROSPECT_IMPORT_STAGE_JOB, payload, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    jobId: `prospect-import-stage-${payload.importId}-${Date.now()}`,
    removeOnComplete: 100,
    removeOnFail: 500,
  })
}

/** Agent execution is default-off. The caller must pass the explicit runtime
 * gate, making accidental imports or task creation incapable of dispatch. */
export async function enqueueAgentRun(
  payload: AgentRunJobPayload,
  options: { enabled?: boolean; dispatchKey?: string } = {},
): Promise<{ enqueued: boolean }> {
  if (options.enabled !== true) return { enqueued: false }
  if (!payload.tenantId.trim() || !payload.runId.trim()) {
    throw new Error('Agent run payload requires exact tenant and run identity')
  }
  await getQueue(AGENT_RUN_QUEUE).add(AGENT_RUN_PROCESS_JOB, payload, {
    ...agentRunJobOptions,
    jobId: `agent-run-${payload.runId}${options.dispatchKey ? `-${options.dispatchKey}` : ''}`,
  })
  logger.info({
    action: 'jobs.agent-run.enqueued',
    tenantId: payload.tenantId,
    runId: payload.runId,
  })
  return { enqueued: true }
}

/** Evaluation execution is deliberately default-off. Callers must pass the
 * operator-controlled gate explicitly; omission can never enqueue work. */
export async function enqueueEvaluationRun(
  payload: EvaluationRunJobPayload,
  options: { enabled?: boolean; dispatchKey?: string } = {},
): Promise<{ enqueued: boolean }> {
  if (options.enabled !== true) return { enqueued: false }
  if (!UUID_PATTERN.test(payload.runId) || !/^[0-9a-f]{64}$/u.test(payload.runIdentityHash)) {
    throw new Error('Evaluation run payload must contain a UUID and lowercase identity hash')
  }
  await getQueue(EVALUATION_RUN_QUEUE).add(EVALUATION_RUN_PROCESS_JOB, payload, {
    ...evaluationRunJobOptions,
    jobId: `evaluation-run-${payload.runId}${options.dispatchKey ? `-${options.dispatchKey}` : ''}`,
  })
  logger.info({
    action: 'jobs.evaluation-run.enqueued',
    tenantId: payload.tenantId,
    venueId: payload.venueId,
    runId: payload.runId,
  })
  return { enqueued: true }
}

/** Machine semantic review remains default-off. Every caller must pass the independently
 * revalidated evaluation-runtime gate; importing this function cannot dispatch provider work. */
export async function enqueueGuestAnswerAttributionEvaluation(
  payload: GuestAnswerAttributionEvaluationJobPayload,
  options: { enabled?: boolean; dispatchKey?: string } = {},
): Promise<{ enqueued: boolean }> {
  if (options.enabled !== true) return { enqueued: false }
  if (
    !UUID_PATTERN.test(payload.requestId) ||
    !/^[0-9a-f]{64}$/u.test(payload.answerHash) ||
    !/^[0-9a-f]{64}$/u.test(payload.evidenceSetHash) ||
    !payload.tenantId.trim() ||
    !payload.venueId.trim()
  ) {
    throw new Error('Guest answer attribution evaluation payload has invalid exact identity')
  }
  await getQueue(GUEST_ANSWER_ATTRIBUTION_EVALUATION_QUEUE).add(
    GUEST_ANSWER_ATTRIBUTION_EVALUATION_PROCESS_JOB,
    payload,
    {
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      jobId: `guest-answer-attribution-evaluation-${payload.requestId}${options.dispatchKey ? `-${options.dispatchKey}` : ''}`,
    },
  )
  logger.info({
    action: 'jobs.guest-answer-attribution-evaluation.enqueued',
    tenantId: payload.tenantId,
    venueId: payload.venueId,
    requestId: payload.requestId,
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
  const queue = getQueue(WEEKLY_DIGEST_QUEUE)
  const jobId = `weekly-digest-${payload.digestId}`
  const retained = await queue.getJob(jobId)
  const queuedStates = ['waiting', 'active', 'delayed', 'prioritized']

  const redriveFailed = async (job: NonNullable<typeof retained>): Promise<void> => {
    try {
      await job.retry('failed')
    } catch (error) {
      // Two exact retries can observe the same retained failure. The loser is
      // successful only if the winner really moved this same job back to work.
      const reconciled = await queue.getJob(jobId)
      const state = reconciled ? await reconciled.getState() : null
      if (!state || !queuedStates.includes(state)) throw error
    }
  }

  const retainedState = retained ? await retained.getState() : null
  if (retained && retainedState === 'failed') {
    await redriveFailed(retained)

    logger.info({
      action: 'jobs.weekly-digest.redriven',
      tenantId: payload.tenantId,
      digestId: payload.digestId,
      weekStart: payload.weekStart,
      weekEnd: payload.weekEnd,
    })
    return
  }
  if (retained && retainedState === 'completed') {
    throw new Error(
      'A completed weekly digest job conflicts with the durable enqueue intent; reconcile status before retrying.',
    )
  }

  await queue.add(WEEKLY_DIGEST_PROCESS_JOB, payload, {
    ...weeklyDigestJobOptions,
    jobId,
  })

  // A retained active job can become terminal while deterministic add is
  // deduplicating it. Re-read after add and repair that exact transition.
  const afterAdd = await queue.getJob(jobId)
  const afterAddState = afterAdd ? await afterAdd.getState() : null
  if (afterAdd && afterAddState === 'failed') {
    await redriveFailed(afterAdd)
  } else if (afterAddState === 'completed') {
    // This exact work finished between add/deduplication and confirmation.
    // Completion is success; rerunning would duplicate provider work.
  } else if (afterAddState && !queuedStates.includes(afterAddState)) {
    throw new Error(`Weekly digest queue state ${afterAddState} cannot confirm publication.`)
  }

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

export async function enqueueEmbedCompanyKnowledge(
  payload: EmbedCompanyKnowledgeJobPayload,
): Promise<void> {
  await getQueue(EMBED_KNOWLEDGE_ENTRY_QUEUE).add(EMBED_COMPANY_KNOWLEDGE_PROCESS_JOB, payload, {
    ...embedKnowledgeEntryJobOptions,
    jobId: `embed-company-knowledge-${payload.itemId}-${payload.contentUpdatedAt}`,
  })

  logger.info({
    action: 'jobs.embed-company-knowledge.enqueued',
    tenantId: payload.tenantId,
    itemId: payload.itemId,
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

export async function enqueueProspectOutreach(
  payload: SendProspectOutreachJobPayload,
): Promise<void> {
  if (!payload.outboxId || payload.outboxId.length > 191)
    throw new Error('Valid outbox identity is required')
  const identity = createHash('sha256')
    .update(`torchiko-prospect-outbox-v2:${payload.outboxId}`)
    .digest('hex')
  await getQueue(SEND_EMAIL_QUEUE).add(SEND_PROSPECT_OUTREACH_JOB, payload, {
    ...sendProspectOutreachJobOptions,
    jobId: `send-prospect-outbox-${identity}`,
  })
  logger.info({ action: 'jobs.send-prospect-outbox.enqueued', outboxId: payload.outboxId })
}

export async function enqueueGmailSync(payload: GmailSyncJobPayload): Promise<void> {
  if (!payload.providerAccountId || payload.providerAccountId.length > 191) {
    throw new Error('Valid Gmail provider account identity is required')
  }
  const receipt =
    payload.receiptId ??
    (payload.trigger === 'WATCH_RENEWAL'
      ? `watch-day-${Math.floor(Date.now() / 86_400_000)}`
      : `reconcile-window-${Math.floor(Date.now() / 900_000)}`)
  const identity = createHash('sha256')
    .update(`torchiko-gmail-sync-v1:${payload.providerAccountId}:${payload.trigger}:${receipt}`)
    .digest('hex')
  await getQueue(GMAIL_SYNC_QUEUE).add(
    payload.trigger === 'WATCH_RENEWAL'
      ? GMAIL_SYNC_WATCH_RENEWAL_JOB
      : payload.trigger === 'SCHEDULED_RECONCILIATION'
        ? GMAIL_SYNC_RECONCILIATION_JOB
        : GMAIL_SYNC_NOTIFICATION_JOB,
    payload,
    {
      attempts: 8,
      backoff: { type: 'exponential', delay: 30_000 },
      jobId: `gmail-sync-${identity}`,
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  )
  logger.info({ action: 'jobs.gmail-sync.enqueued', providerAccountId: payload.providerAccountId })
}

export async function enqueueIntakeUploadVerification(
  payload: IntakeUploadVerificationJobPayload,
): Promise<void> {
  const identity = [payload.tenantId, payload.venueId, payload.uploadId, payload.observedUpdatedAt]
  if (identity.some((value) => typeof value !== 'string' || value.trim().length === 0))
    throw new Error('Intake upload verification requires complete durable identity')
  if (Number.isNaN(Date.parse(payload.observedUpdatedAt)))
    throw new Error('Intake upload verification observedUpdatedAt must be an ISO timestamp')
  const digest = createHash('sha256')
    .update(JSON.stringify(['pathfinder-intake-upload-verification-v1', ...identity]))
    .digest('hex')
  await getQueue(INTAKE_UPLOAD_VERIFICATION_QUEUE).add(
    INTAKE_UPLOAD_VERIFICATION_PROCESS_JOB,
    payload,
    {
      jobId: `intake-upload-verification-${digest}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  )
}

type OperationalSnapshotQueue = Pick<
  Queue,
  'getJobCounts' | 'getJobs' | 'getJobSchedulersCount' | 'isPaused'
>

export async function inspectQueueOperationalSnapshot(
  now = new Date(),
  resolveQueue: (name: string) => OperationalSnapshotQueue = getQueue,
) {
  const observedAtMs = now.getTime()
  if (!Number.isFinite(observedAtMs)) throw new Error('Queue snapshot time must be valid')
  const queues = await Promise.all(
    OPERATIONAL_QUEUE_NAMES.map(async (name) => {
      const queue = resolveQueue(name)
      const [counts, oldest, paused, jobSchedulers] = await Promise.all([
        queue.getJobCounts(
          'wait',
          'active',
          'delayed',
          'prioritized',
          'waiting-children',
          'failed',
        ),
        queue.getJobs(
          ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'],
          0,
          0,
          true,
        ),
        queue.isPaused(),
        queue.getJobSchedulersCount(),
      ])
      const candidateTimestamp = oldest[0]?.timestamp
      const oldestTimestamp =
        typeof candidateTimestamp === 'number' &&
        Number.isFinite(candidateTimestamp) &&
        candidateTimestamp >= 0
          ? candidateTimestamp
          : null
      const waiting = counts.wait ?? 0
      const active = counts.active ?? 0
      const delayed = counts.delayed ?? 0
      const prioritized = counts.prioritized ?? 0
      const waitingChildren = counts['waiting-children'] ?? 0
      const failed = counts.failed ?? 0
      return {
        name,
        counts: { waiting, active, delayed, prioritized, waitingChildren, failed },
        depth: waiting + active + delayed + prioritized + waitingChildren,
        failed,
        paused,
        jobSchedulers,
        oldestQueuedAt: oldestTimestamp === null ? null : new Date(oldestTimestamp),
        oldestAgeMs: oldestTimestamp === null ? null : Math.max(0, observedAtMs - oldestTimestamp),
      }
    }),
  )
  return {
    observedAt: now,
    coverage: {
      expectedQueues: OPERATIONAL_QUEUE_NAMES.length,
      observedQueues: queues.length,
      complete: queues.length === OPERATIONAL_QUEUE_NAMES.length,
    },
    totalDepth: queues.reduce((sum, queue) => sum + queue.depth, 0),
    totalFailed: queues.reduce((sum, queue) => sum + queue.failed, 0),
    pausedQueues: queues.reduce((sum, queue) => sum + (queue.paused ? 1 : 0), 0),
    jobSchedulers: queues.reduce((sum, queue) => sum + queue.jobSchedulers, 0),
    oldestAgeMs: queues.reduce<number | null>(
      (oldest, queue) =>
        queue.oldestAgeMs === null
          ? oldest
          : oldest === null
            ? queue.oldestAgeMs
            : Math.max(oldest, queue.oldestAgeMs),
      null,
    ),
    queues,
  }
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
