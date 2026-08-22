import { Queue, Worker, type Job } from 'bullmq'

import { env, logger } from '@pathfinder/config'
import { recordWorkerHeartbeat } from '@pathfinder/db'
import {
  ACCOUNT_SUMMARY_REFRESH_QUEUE,
  ACCOUNT_SUMMARY_REFRESH_SCHEDULER_JOB,
  AGENT_RUN_PROCESS_JOB,
  AGENT_RUN_QUEUE,
  AGENT_RUN_RETRY_BACKOFF,
  ANSWER_ANALYSIS_PROCESS_JOB,
  ANSWER_ANALYSIS_QUEUE,
  ANSWER_ANALYSIS_RECOVERY_JOB,
  ANSWER_ANALYSIS_RETRY_BACKOFF,
  BILLING_RECONCILIATION_PROCESS_JOB,
  BILLING_RECONCILIATION_QUEUE,
  BILLING_RECONCILIATION_SCHEDULER_JOB,
  ANALYTICS_ENRICHMENT_PROCESS_JOB,
  ANALYTICS_ENRICHMENT_QUEUE,
  ANALYTICS_ENRICHMENT_RETRY_BACKOFF,
  ANALYTICS_ENRICHMENT_SCHEDULER_JOB,
  checkBullMQConnection,
  closeBullMQConnection,
  closeJobQueues,
  configureMediaIngestionGlobalConcurrency,
  DAILY_ROLLUP_PROCESS_JOB,
  DAILY_ROLLUP_QUEUE,
  DAILY_ROLLUP_RETRY_BACKOFF,
  DAILY_ROLLUP_SCHEDULER_JOB,
  EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB,
  EMBED_COMPANY_KNOWLEDGE_PROCESS_JOB,
  EMBED_KNOWLEDGE_ENTRY_QUEUE,
  EMBED_KNOWLEDGE_ENTRY_RETRY_BACKOFF,
  EMBED_PLACE_PROCESS_JOB,
  EMBED_PLACE_QUEUE,
  EMBED_PLACE_RETRY_BACKOFF,
  EMBEDDING_DISPATCH_QUEUE,
  EMBEDDING_DISPATCH_SCHEDULER_JOB,
  EVALUATION_RUN_PROCESS_JOB,
  EVALUATION_RUN_DISPATCH_JOB,
  EVALUATION_RUN_QUEUE,
  EVALUATION_RUN_RETRY_BACKOFF,
  GENERATION_DISPATCH_KICK_JOB,
  GENERATION_DISPATCH_QUEUE,
  GENERATION_DISPATCH_SCHEDULER_JOB,
  GENERATION_RECOVERY_QUEUE,
  GENERATION_RECOVERY_SCHEDULER_JOB,
  GMAIL_SYNC_NOTIFICATION_JOB,
  GMAIL_SYNC_QUEUE,
  GMAIL_SYNC_RECONCILIATION_JOB,
  GMAIL_SYNC_WATCH_RENEWAL_JOB,
  getBullMQConnection,
  MEDIA_INGESTION_PROCESS_JOB,
  MEDIA_INGESTION_QUEUE,
  MEDIA_INGESTION_RETRY_BACKOFF,
  OPERATIONAL_EVENT_DELIVERY_PROCESS_JOB,
  OPERATIONAL_EVENT_DELIVERY_QUEUE,
  OPERATIONAL_EVENT_DELIVERY_SCHEDULER_JOB,
  PROSPECT_IMPORT_COMMIT_JOB,
  PROSPECT_IMPORT_INSPECT_JOB,
  PROSPECT_IMPORT_QUEUE,
  PROSPECT_IMPORT_RETRY_BACKOFF,
  PROSPECT_IMPORT_STAGE_JOB,
  SEND_EMAIL_QUEUE,
  SEND_WELCOME_EMAIL_JOB,
  SEND_WELCOME_EMAIL_RETRY_BACKOFF,
  SEND_PROSPECT_OUTREACH_JOB,
  SEND_PROSPECT_OUTREACH_RETRY_BACKOFF,
  type AnalyticsEnrichmentJobPayload,
  type AgentRunJobPayload,
  type EmbedKnowledgeEntryJobPayload,
  type EmbedCompanyKnowledgeJobPayload,
  type EmbedPlaceJobPayload,
  type EvaluationRunJobPayload,
  type GenerationDispatchKickJobPayload,
  type GmailSyncJobPayload,
  type SendWelcomeEmailJobPayload,
  type SendProspectOutreachJobPayload,
  WEEKLY_DIGEST_PROCESS_JOB,
  WEEKLY_DIGEST_QUEUE,
  WEEKLY_DIGEST_RETRY_BACKOFF,
  WEEKLY_DIGEST_SCHEDULER_JOB,
  WEEKLY_REPORT_PROCESS_JOB,
  WEEKLY_REPORT_QUEUE,
  WEEKLY_REPORT_RECOVERY_JOB,
  WEEKLY_REPORT_RETRY_BACKOFF,
  type AnswerAnalysisJobPayload,
  type BillingReconciliationJobPayload,
  type AnswerAnalysisRecoveryJobPayload,
  type DailyRollupJobPayload,
  type WeeklyDigestJobPayload,
  type WeeklyReportJobPayload,
  type WeeklyReportRecoveryJobPayload,
  type MediaIngestionJobPayload,
  type OperationalEventDeliveryJobPayload,
  type ProspectImportCommitJobPayload,
  type ProspectImportInspectionJobPayload,
  type ProspectImportStagingJobPayload,
} from '@pathfinder/jobs'

import { processAnswerAnalysisJob } from './processors/answer-analysis'
import { processStaleAccountSummaries } from './processors/account-summary-refresh'
import { processAgentRunJob } from './processors/agent-run'
import { processAnalyticsEnrichmentJob } from './processors/analytics-enrichment'
import { processDailyRollupJob } from './processors/daily-rollup'
import { processEmbedKnowledgeEntryJob } from './processors/embed-knowledge-entry'
import { processEmbedCompanyKnowledgeJob } from './processors/embed-company-knowledge'
import { processEmbedPlaceJob } from './processors/embed-place'
import { processEvaluationRunJob } from './processors/evaluation-run'
import { processEvaluationDispatchJob } from './processors/evaluation-dispatch'
import { processEmbeddingDispatches } from './processors/dispatch-embeddings'
import { processGenerationDispatches } from './processors/generation-dispatch'
import { processGenerationRecovery } from './processors/generation-recovery'
import { processGmailSyncJob } from './processors/gmail-sync'
import { processSendWelcomeEmailJob } from './processors/send-welcome-email'
import { processSendProspectOutreachJob } from './processors/send-prospect-outreach'
import { startProspectOutboxDispatcher } from './processors/prospect-outbox-dispatcher'
import { processWeeklyDigestJob } from './processors/weekly-digest'
import { processWeeklyReportJob } from './processors/weekly-report'
import { processMediaIngestionJob } from './processors/media-ingestion'
import { processOperationalEventDeliveries } from './processors/operational-event-delivery'
import { processBillingReconciliationJob } from './processors/billing-reconciliation'
import {
  processProspectImportInspectionJob,
  processProspectImportCommitJob,
  processProspectImportStagingJob,
} from './processors/prospect-import'
import { applySchedulerState, utcCronSchedule } from './scheduler-control'
import {
  enqueueScheduledAnalyticsEnrichment,
  enqueueScheduledDailyRollups,
  enqueueScheduledWeeklyDigests,
} from './scheduled-tenant-fanout'
import { getJobExecutionMetadata } from './lib/job-execution'
import { globalAiAdmissionAvailable, runAiJobWithIncidentControl } from './lib/global-ai-deferral'
import {
  cancelAllMediaJobsAfterWorkerError,
  cancelMediaJobsAfterLockRenewalFailure,
} from './lib/media-job-cancellation'
import { createMediaAttemptSignal } from './lib/media-attempt-limits'
import { startProviderDisabledRuntime } from './lib/provider-disabled-runtime'
import { createIntakeUploadVerificationResources } from './intake-upload-verification-runtime'
import {
  createEscalatingShutdownHandler,
  createShutdownCoordinator,
  runStartupWithCleanup,
} from './lib/worker-lifecycle'

const WEEKLY_DIGEST_CRON = '0 23 * * 0'
const DAILY_ROLLUP_CRON = '0 1 * * *'
// Runs after the daily rollup (01:00) so its pure-SQL rows already exist.
const ANALYTICS_ENRICHMENT_CRON = '30 1 * * *'
const EMBEDDING_DISPATCH_CRON = '* * * * *'
const GENERATION_DISPATCH_CRON = '* * * * *'
const GENERATION_RECOVERY_CRON = '* * * * *'

async function handleAccountSummaryRefreshQueueJob(job: Job<Record<string, never>>) {
  if (job.name !== ACCOUNT_SUMMARY_REFRESH_SCHEDULER_JOB) {
    throw new Error(`Unsupported account summary refresh job: ${job.name}`)
  }
  await processStaleAccountSummaries({ systemJobId: String(job.id ?? job.name) })
}

async function startOperationalHeartbeat(mode: 'provider-enabled' | 'provider-disabled') {
  const write = () =>
    recordWorkerHeartbeat({
      mode,
      schedulersEnabled: env.WORKER_SCHEDULERS_ENABLED,
      revision: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? 'unknown',
    }).catch((error: unknown) => {
      logger.error({
        action: 'workers.heartbeat.failed',
        error: error instanceof Error ? error.message : 'Unknown worker heartbeat error',
      })
    })
  await write()
  const timer = setInterval(() => void write(), 30_000)
  timer.unref()
  return () => clearInterval(timer)
}

function registerShutdownSignals(shutdown: () => Promise<void>): void {
  const handleShutdownSignal = createEscalatingShutdownHandler(
    shutdown,
    (error) => {
      logger.error({
        action: 'workers.shutdown.failed',
        error: error instanceof Error ? error.message : 'Unknown worker shutdown error',
        ...(error instanceof AggregateError
          ? {
              failures: error.errors.map((failure) =>
                failure instanceof Error ? failure.message : 'Unknown resource close error',
              ),
            }
          : {}),
      })
      process.exitCode = 1
    },
    () => {
      logger.error({
        action: 'workers.shutdown.forced',
        error: 'Forced worker shutdown after a second termination signal.',
        reason: 'second-signal',
      })
      process.exit(1)
    },
  )

  process.once('SIGINT', handleShutdownSignal)
  process.once('SIGTERM', handleShutdownSignal)
}

function getWeeklyDigestBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    case 3:
      return 5 * 60_000
    case 4:
      return 30 * 60_000
    case 5:
      return 2 * 60 * 60_000
    default:
      return -1
  }
}

function getDailyRollupBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    case 3:
      return 5 * 60_000
    case 4:
      return 30 * 60_000
    case 5:
      return 2 * 60 * 60_000
    default:
      return -1
  }
}

function getEmbedPlaceBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    case 3:
      return 5 * 60_000
    case 4:
      return 30 * 60_000
    case 5:
      return 2 * 60 * 60_000
    default:
      return -1
  }
}

function getEmbedKnowledgeEntryBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    case 3:
      return 5 * 60_000
    case 4:
      return 30 * 60_000
    case 5:
      return 2 * 60 * 60_000
    default:
      return -1
  }
}

function getAnalyticsEnrichmentBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    case 3:
      return 5 * 60_000
    case 4:
      return 30 * 60_000
    case 5:
      return 2 * 60 * 60_000
    default:
      return -1
  }
}

function getAnswerAnalysisBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    case 3:
      return 5 * 60_000
    case 4:
      return 30 * 60_000
    case 5:
      return 2 * 60 * 60_000
    default:
      return -1
  }
}

function getWeeklyReportBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    case 3:
      return 5 * 60_000
    case 4:
      return 30 * 60_000
    case 5:
      return 2 * 60 * 60_000
    default:
      return -1
  }
}

function getSendWelcomeEmailBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    default:
      return -1
  }
}

function getEvaluationRunBackoffDelay(attemptsMade: number): number {
  return attemptsMade === 1 ? 30_000 : attemptsMade === 2 ? 2 * 60_000 : -1
}

async function handleWeeklyDigestQueueJob(
  job: Job<WeeklyDigestJobPayload | Record<string, never>>,
  token?: string,
) {
  if (job.name === WEEKLY_DIGEST_SCHEDULER_JOB) {
    if (!(await globalAiAdmissionAvailable())) return
    await enqueueScheduledWeeklyDigests()
    return
  }

  if (job.name === WEEKLY_DIGEST_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processWeeklyDigestJob(job.data as WeeklyDigestJobPayload, getJobExecutionMetadata(job)),
    )
    return
  }

  throw new Error(`Unsupported weekly digest job: ${job.name}`)
}

async function handleDailyRollupQueueJob(job: Job<DailyRollupJobPayload | Record<string, never>>) {
  if (job.name === DAILY_ROLLUP_SCHEDULER_JOB) {
    await enqueueScheduledDailyRollups()
    return
  }

  if (job.name === DAILY_ROLLUP_PROCESS_JOB) {
    await processDailyRollupJob(job.data as DailyRollupJobPayload, getJobExecutionMetadata(job))
    return
  }

  throw new Error(`Unsupported daily rollup job: ${job.name}`)
}

async function handleEmbedPlaceQueueJob(job: Job<EmbedPlaceJobPayload>, token?: string) {
  if (job.name === EMBED_PLACE_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processEmbedPlaceJob(job.data, getJobExecutionMetadata(job)),
    )
    return
  }

  throw new Error(`Unsupported embed place job: ${job.name}`)
}

async function handleEmbedKnowledgeEntryQueueJob(
  job: Job<EmbedKnowledgeEntryJobPayload | EmbedCompanyKnowledgeJobPayload>,
  token?: string,
) {
  if (job.name === EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processEmbedKnowledgeEntryJob(
        job.data as EmbedKnowledgeEntryJobPayload,
        getJobExecutionMetadata(job),
      ),
    )
    return
  }

  if (job.name === EMBED_COMPANY_KNOWLEDGE_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processEmbedCompanyKnowledgeJob(
        job.data as EmbedCompanyKnowledgeJobPayload,
        getJobExecutionMetadata(job),
      ),
    )
    return
  }

  throw new Error(`Unsupported embed knowledge entry job: ${job.name}`)
}

async function handleEmbeddingDispatchQueueJob(job: Job<Record<string, never>>) {
  if (job.name === EMBEDDING_DISPATCH_SCHEDULER_JOB) {
    if (!(await globalAiAdmissionAvailable())) return
    await processEmbeddingDispatches()
    return
  }

  throw new Error(`Unsupported embedding dispatch job: ${job.name}`)
}

async function handleGenerationDispatchQueueJob(
  job: Job<GenerationDispatchKickJobPayload | Record<string, never>>,
  token?: string,
) {
  if (job.name === GENERATION_DISPATCH_SCHEDULER_JOB) {
    if (!(await globalAiAdmissionAvailable())) return
    await processGenerationDispatches()
    return
  }

  if (job.name === GENERATION_DISPATCH_KICK_JOB) {
    await runAiJobWithIncidentControl(job, token, async () => {
      await processGenerationDispatches()
    })
    return
  }

  throw new Error(`Unsupported generation dispatch job: ${job.name}`)
}

async function handleGenerationRecoveryQueueJob(job: Job<Record<string, never>>) {
  if (job.name === GENERATION_RECOVERY_SCHEDULER_JOB) {
    if (!(await globalAiAdmissionAvailable())) return
    await processGenerationRecovery(getJobExecutionMetadata(job))
    return
  }

  throw new Error(`Unsupported generation recovery job: ${job.name}`)
}

async function handleAnalyticsEnrichmentQueueJob(
  job: Job<AnalyticsEnrichmentJobPayload | Record<string, never>>,
  token?: string,
) {
  if (job.name === ANALYTICS_ENRICHMENT_SCHEDULER_JOB) {
    if (!(await globalAiAdmissionAvailable())) return
    await enqueueScheduledAnalyticsEnrichment()
    return
  }

  if (job.name === ANALYTICS_ENRICHMENT_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processAnalyticsEnrichmentJob(
        job.data as AnalyticsEnrichmentJobPayload,
        getJobExecutionMetadata(job),
      ),
    )
    return
  }

  throw new Error(`Unsupported analytics enrichment job: ${job.name}`)
}

async function handleAnswerAnalysisQueueJob(
  job: Job<AnswerAnalysisJobPayload | AnswerAnalysisRecoveryJobPayload>,
  token?: string,
) {
  if (job.name === ANSWER_ANALYSIS_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processAnswerAnalysisJob(job.data, getJobExecutionMetadata(job)),
    )
    return
  }

  if (job.name === ANSWER_ANALYSIS_RECOVERY_JOB) {
    const { observedLeaseToken, ...payload } = job.data as AnswerAnalysisRecoveryJobPayload
    await runAiJobWithIncidentControl(job, token, () =>
      processAnswerAnalysisJob(payload, getJobExecutionMetadata(job), { observedLeaseToken }),
    )
    return
  }

  throw new Error(`Unsupported answer analysis job: ${job.name}`)
}

async function handleWeeklyReportQueueJob(
  job: Job<WeeklyReportJobPayload | WeeklyReportRecoveryJobPayload>,
  token?: string,
) {
  if (job.name === WEEKLY_REPORT_PROCESS_JOB) {
    await runAiJobWithIncidentControl(job, token, () =>
      processWeeklyReportJob(job.data, getJobExecutionMetadata(job)),
    )
    return
  }

  if (job.name === WEEKLY_REPORT_RECOVERY_JOB) {
    const { observedLeaseToken, ...payload } = job.data as WeeklyReportRecoveryJobPayload
    await runAiJobWithIncidentControl(job, token, () =>
      processWeeklyReportJob(payload, getJobExecutionMetadata(job), { observedLeaseToken }),
    )
    return
  }

  throw new Error(`Unsupported weekly report job: ${job.name}`)
}

async function handleSendEmailQueueJob(
  job: Job<SendWelcomeEmailJobPayload | SendProspectOutreachJobPayload>,
) {
  if (job.name === SEND_WELCOME_EMAIL_JOB) {
    await processSendWelcomeEmailJob(
      job.data as SendWelcomeEmailJobPayload,
      getJobExecutionMetadata(job),
    )
    return
  }

  if (job.name === SEND_PROSPECT_OUTREACH_JOB) {
    await processSendProspectOutreachJob(job.data as SendProspectOutreachJobPayload)
    return
  }

  throw new Error(`Unsupported send-email job: ${job.name}`)
}

async function handleMediaIngestionQueueJob(
  job: Job<MediaIngestionJobPayload>,
  token?: string,
  signal?: AbortSignal,
) {
  if (job.name === MEDIA_INGESTION_PROCESS_JOB) {
    const attempt = createMediaAttemptSignal(signal)
    try {
      await runAiJobWithIncidentControl(job, token, () =>
        processMediaIngestionJob(job.data, getJobExecutionMetadata(job), attempt.signal),
      )
    } finally {
      attempt.dispose()
    }
    return
  }

  throw new Error(`Unsupported media ingestion job: ${job.name}`)
}

async function handleEvaluationRunQueueJob(
  job: Job<EvaluationRunJobPayload | Record<string, never>>,
  token?: string,
  signal?: AbortSignal,
) {
  if (job.name === EVALUATION_RUN_DISPATCH_JOB) {
    await processEvaluationDispatchJob(getJobExecutionMetadata(job))
    return
  }
  if (job.name !== EVALUATION_RUN_PROCESS_JOB) {
    throw new Error(`Unsupported evaluation run job: ${job.name}`)
  }
  await runAiJobWithIncidentControl(job, token, () =>
    processEvaluationRunJob(
      job.data as EvaluationRunJobPayload,
      getJobExecutionMetadata(job),
      signal,
    ),
  )
}

async function handleAgentRunQueueJob(
  job: Job<AgentRunJobPayload>,
  token?: string,
  signal?: AbortSignal,
) {
  if (job.name !== AGENT_RUN_PROCESS_JOB) {
    throw new Error(`Unsupported agent run job: ${job.name}`)
  }
  await runAiJobWithIncidentControl(job, token, async () => {
    await processAgentRunJob(job.data, signal)
  })
}

async function handleOperationalEventDeliveryJob(job: Job<OperationalEventDeliveryJobPayload>) {
  if (job.name !== OPERATIONAL_EVENT_DELIVERY_PROCESS_JOB) {
    throw new Error(`Unsupported operational event delivery job: ${job.name}`)
  }
  await processOperationalEventDeliveries()
}

type ProspectImportJobPayload =
  | ProspectImportCommitJobPayload
  | ProspectImportInspectionJobPayload
  | ProspectImportStagingJobPayload

async function handleProspectImportQueueJob(job: Job<ProspectImportJobPayload>) {
  if (job.name === PROSPECT_IMPORT_INSPECT_JOB) {
    await processProspectImportInspectionJob(job.data.importId)
    return
  }
  if (job.name === PROSPECT_IMPORT_STAGE_JOB) {
    await processProspectImportStagingJob(job.data.importId)
    return
  }
  if (job.name === PROSPECT_IMPORT_COMMIT_JOB) {
    await processProspectImportCommitJob(job.data)
    return
  }
  throw new Error(`Unsupported prospect import job: ${job.name}`)
}

async function handleGmailSyncQueueJob(job: Job<GmailSyncJobPayload>) {
  if (
    ![
      GMAIL_SYNC_NOTIFICATION_JOB,
      GMAIL_SYNC_RECONCILIATION_JOB,
      GMAIL_SYNC_WATCH_RENEWAL_JOB,
    ].includes(job.name)
  ) {
    throw new Error(`Unsupported Gmail sync job: ${job.name}`)
  }
  await processGmailSyncJob(job.data)
}

async function handleBillingReconciliationQueueJob(job: Job<BillingReconciliationJobPayload>) {
  if (
    job.name !== BILLING_RECONCILIATION_PROCESS_JOB &&
    job.name !== BILLING_RECONCILIATION_SCHEDULER_JOB
  ) {
    throw new Error(`Unsupported billing reconciliation job: ${job.name}`)
  }
  await processBillingReconciliationJob(job.data)
}

export async function startWorkers() {
  if (!env.OUTBOUND_PROVIDER_WORKERS_ENABLED) {
    const stopHeartbeat = await startOperationalHeartbeat('provider-disabled')
    const runtime = await startProviderDisabledRuntime({
      checkConnection: () => checkBullMQConnection(5_000),
      closeConnection: closeBullMQConnection,
      onConnectionError: (error) =>
        logger.error({ action: 'workers.runtime.error', queueName: null, error: error.message }),
    })
    logger.info({
      action: 'workers.started',
      mode: runtime.mode,
      outboundProviderWorkersEnabled: false,
      queues: runtime.queues,
    })
    const shutdown = async () => {
      stopHeartbeat()
      await runtime.shutdown()
    }
    registerShutdownSignals(shutdown)
    return { ...runtime, shutdown }
  }

  const connection = getBullMQConnection()
  const weeklyDigestQueue = new Queue(WEEKLY_DIGEST_QUEUE, { connection })
  const dailyRollupQueue = new Queue(DAILY_ROLLUP_QUEUE, { connection })
  const embedPlaceQueue = new Queue(EMBED_PLACE_QUEUE, { connection })
  const embeddingDispatchQueue = new Queue(EMBEDDING_DISPATCH_QUEUE, { connection })
  const generationDispatchQueue = new Queue(GENERATION_DISPATCH_QUEUE, { connection })
  const generationRecoveryQueue = new Queue(GENERATION_RECOVERY_QUEUE, { connection })
  const analyticsEnrichmentQueue = new Queue(ANALYTICS_ENRICHMENT_QUEUE, { connection })
  const answerAnalysisQueue = new Queue(ANSWER_ANALYSIS_QUEUE, { connection })
  const weeklyReportQueue = new Queue(WEEKLY_REPORT_QUEUE, { connection })
  const mediaIngestionQueue = new Queue(MEDIA_INGESTION_QUEUE, { connection })
  const operationalEventDeliveryQueue = new Queue(OPERATIONAL_EVENT_DELIVERY_QUEUE, {
    connection,
  })
  const prospectImportQueue = new Queue(PROSPECT_IMPORT_QUEUE, { connection })
  const gmailSyncQueue = new Queue(GMAIL_SYNC_QUEUE, { connection })
  const billingReconciliationQueue = new Queue(BILLING_RECONCILIATION_QUEUE, { connection })
  const accountSummaryRefreshQueue = new Queue(ACCOUNT_SUMMARY_REFRESH_QUEUE, { connection })
  const evaluationRunQueue = env.EVALUATION_RUNNER_ENABLED
    ? new Queue(EVALUATION_RUN_QUEUE, { connection })
    : null
  const agentRunQueue = env.AGENT_RUNNER_ENABLED ? new Queue(AGENT_RUN_QUEUE, { connection }) : null

  const schedulerQueueResources = [
    { name: WEEKLY_DIGEST_QUEUE, close: () => weeklyDigestQueue.close() },
    { name: DAILY_ROLLUP_QUEUE, close: () => dailyRollupQueue.close() },
    { name: EMBED_PLACE_QUEUE, close: () => embedPlaceQueue.close() },
    { name: EMBEDDING_DISPATCH_QUEUE, close: () => embeddingDispatchQueue.close() },
    { name: GENERATION_DISPATCH_QUEUE, close: () => generationDispatchQueue.close() },
    { name: GENERATION_RECOVERY_QUEUE, close: () => generationRecoveryQueue.close() },
    { name: ANALYTICS_ENRICHMENT_QUEUE, close: () => analyticsEnrichmentQueue.close() },
    { name: ANSWER_ANALYSIS_QUEUE, close: () => answerAnalysisQueue.close() },
    { name: WEEKLY_REPORT_QUEUE, close: () => weeklyReportQueue.close() },
    { name: MEDIA_INGESTION_QUEUE, close: () => mediaIngestionQueue.close() },
    {
      name: OPERATIONAL_EVENT_DELIVERY_QUEUE,
      close: () => operationalEventDeliveryQueue.close(),
    },
    { name: PROSPECT_IMPORT_QUEUE, close: () => prospectImportQueue.close() },
    { name: GMAIL_SYNC_QUEUE, close: () => gmailSyncQueue.close() },
    { name: BILLING_RECONCILIATION_QUEUE, close: () => billingReconciliationQueue.close() },
    { name: ACCOUNT_SUMMARY_REFRESH_QUEUE, close: () => accountSummaryRefreshQueue.close() },
    ...(evaluationRunQueue
      ? [{ name: EVALUATION_RUN_QUEUE, close: () => evaluationRunQueue.close() }]
      : []),
    ...(agentRunQueue ? [{ name: AGENT_RUN_QUEUE, close: () => agentRunQueue.close() }] : []),
  ]
  const cleanupAfterStartupFailure = createShutdownCoordinator({
    onStart: () => logger.info({ action: 'workers.start.cleanup' }),
    phases: [
      { name: 'scheduler-queues', resources: schedulerQueueResources },
      { name: 'enqueue-queues', resources: [{ name: 'cached', close: closeJobQueues }] },
      {
        name: 'connection',
        resources: [{ name: 'bullmq', close: closeBullMQConnection }],
      },
    ],
  })

  await runStartupWithCleanup(async () => {
    await configureMediaIngestionGlobalConcurrency(mediaIngestionQueue)

    await applySchedulerState(env.WORKER_SCHEDULERS_ENABLED, [
      {
        upsert: () =>
          accountSummaryRefreshQueue.upsertJobScheduler(
            ACCOUNT_SUMMARY_REFRESH_SCHEDULER_JOB,
            { every: 5 * 60_000 },
            {
              name: ACCOUNT_SUMMARY_REFRESH_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 5,
                backoff: { type: 'exponential', delay: 10_000 },
                removeOnComplete: 20,
                removeOnFail: 100,
              },
            },
          ),
        remove: () =>
          accountSummaryRefreshQueue.removeJobScheduler(ACCOUNT_SUMMARY_REFRESH_SCHEDULER_JOB),
      },
    ])
    await applySchedulerState(env.WORKER_SCHEDULERS_ENABLED, [
      {
        upsert: () =>
          weeklyDigestQueue.upsertJobScheduler(
            WEEKLY_DIGEST_SCHEDULER_JOB,
            utcCronSchedule(WEEKLY_DIGEST_CRON),
            {
              name: WEEKLY_DIGEST_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 10,
                removeOnFail: 50,
              },
            },
          ),
        remove: () => weeklyDigestQueue.removeJobScheduler(WEEKLY_DIGEST_SCHEDULER_JOB),
      },
    ])
    await applySchedulerState(env.WORKER_SCHEDULERS_ENABLED, [
      {
        upsert: () =>
          dailyRollupQueue.upsertJobScheduler(
            DAILY_ROLLUP_SCHEDULER_JOB,
            utcCronSchedule(DAILY_ROLLUP_CRON),
            {
              name: DAILY_ROLLUP_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 10,
                removeOnFail: 50,
              },
            },
          ),
        remove: () => dailyRollupQueue.removeJobScheduler(DAILY_ROLLUP_SCHEDULER_JOB),
      },
      {
        upsert: () =>
          analyticsEnrichmentQueue.upsertJobScheduler(
            ANALYTICS_ENRICHMENT_SCHEDULER_JOB,
            utcCronSchedule(ANALYTICS_ENRICHMENT_CRON),
            {
              name: ANALYTICS_ENRICHMENT_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 10,
                removeOnFail: 50,
              },
            },
          ),
        remove: () =>
          analyticsEnrichmentQueue.removeJobScheduler(ANALYTICS_ENRICHMENT_SCHEDULER_JOB),
      },
    ])

    await applySchedulerState(
      env.OPERATIONAL_ALERT_DEV_SINK_ENABLED || env.OPERATIONAL_ALERT_DELIVERY_ENABLED,
      [
        {
          upsert: () =>
            operationalEventDeliveryQueue.upsertJobScheduler(
              OPERATIONAL_EVENT_DELIVERY_SCHEDULER_JOB,
              { every: 60_000 },
              {
                name: OPERATIONAL_EVENT_DELIVERY_PROCESS_JOB,
                data: {},
                opts: {
                  attempts: 3,
                  backoff: { type: 'exponential', delay: 5_000 },
                  removeOnComplete: 100,
                  removeOnFail: 500,
                },
              },
            ),
          remove: () =>
            operationalEventDeliveryQueue.removeJobScheduler(
              OPERATIONAL_EVENT_DELIVERY_SCHEDULER_JOB,
            ),
        },
      ],
    )

    await applySchedulerState(env.EMBEDDING_DISPATCH_ENABLED, [
      {
        upsert: () =>
          embeddingDispatchQueue.upsertJobScheduler(
            EMBEDDING_DISPATCH_SCHEDULER_JOB,
            { pattern: EMBEDDING_DISPATCH_CRON },
            {
              name: EMBEDDING_DISPATCH_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 10,
                removeOnFail: 50,
              },
            },
          ),
        remove: () => embeddingDispatchQueue.removeJobScheduler(EMBEDDING_DISPATCH_SCHEDULER_JOB),
      },
    ])

    await applySchedulerState(env.GENERATION_DISPATCH_ENABLED, [
      {
        upsert: () =>
          generationDispatchQueue.upsertJobScheduler(
            GENERATION_DISPATCH_SCHEDULER_JOB,
            { pattern: GENERATION_DISPATCH_CRON },
            {
              name: GENERATION_DISPATCH_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 10,
                removeOnFail: 50,
              },
            },
          ),
        remove: () => generationDispatchQueue.removeJobScheduler(GENERATION_DISPATCH_SCHEDULER_JOB),
      },
    ])

    await applySchedulerState(env.GENERATION_RECOVERY_ENABLED, [
      {
        upsert: () =>
          generationRecoveryQueue.upsertJobScheduler(
            GENERATION_RECOVERY_SCHEDULER_JOB,
            { pattern: GENERATION_RECOVERY_CRON },
            {
              name: GENERATION_RECOVERY_SCHEDULER_JOB,
              data: {},
              opts: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: 10,
                removeOnFail: 50,
              },
            },
          ),
        remove: () => generationRecoveryQueue.removeJobScheduler(GENERATION_RECOVERY_SCHEDULER_JOB),
      },
    ])

    await applySchedulerState(env.WORKER_SCHEDULERS_ENABLED && env.GMAIL_RECONCILIATION_ENABLED, [
      {
        upsert: () =>
          gmailSyncQueue.upsertJobScheduler(
            GMAIL_SYNC_RECONCILIATION_JOB,
            { every: 15 * 60_000 },
            {
              name: GMAIL_SYNC_RECONCILIATION_JOB,
              data: { providerAccountId: '*', trigger: 'SCHEDULED_RECONCILIATION' },
              opts: { attempts: 8, backoff: { type: 'exponential', delay: 30_000 } },
            },
          ),
        remove: () => gmailSyncQueue.removeJobScheduler(GMAIL_SYNC_RECONCILIATION_JOB),
      },
    ])
    await applySchedulerState(env.WORKER_SCHEDULERS_ENABLED && env.GMAIL_WATCH_RENEWAL_ENABLED, [
      {
        upsert: () =>
          gmailSyncQueue.upsertJobScheduler(
            GMAIL_SYNC_WATCH_RENEWAL_JOB,
            { every: 24 * 60 * 60_000 },
            {
              name: GMAIL_SYNC_WATCH_RENEWAL_JOB,
              data: { providerAccountId: '*', trigger: 'WATCH_RENEWAL' },
              opts: { attempts: 8, backoff: { type: 'exponential', delay: 30_000 } },
            },
          ),
        remove: () => gmailSyncQueue.removeJobScheduler(GMAIL_SYNC_WATCH_RENEWAL_JOB),
      },
    ])

    await applySchedulerState(env.WORKER_SCHEDULERS_ENABLED && env.STRIPE_RECONCILIATION_ENABLED, [
      {
        upsert: () =>
          billingReconciliationQueue.upsertJobScheduler(
            BILLING_RECONCILIATION_SCHEDULER_JOB,
            { every: 24 * 60 * 60_000 },
            {
              name: BILLING_RECONCILIATION_PROCESS_JOB,
              data: {},
              opts: {
                attempts: 5,
                backoff: { type: 'exponential', delay: 30_000 },
                removeOnComplete: 100,
                removeOnFail: 500,
              },
            },
          ),
        remove: () =>
          billingReconciliationQueue.removeJobScheduler(BILLING_RECONCILIATION_SCHEDULER_JOB),
      },
    ])

    if (evaluationRunQueue) {
      await applySchedulerState(env.EVALUATION_RUNNER_ENABLED, [
        {
          upsert: () =>
            evaluationRunQueue.upsertJobScheduler(
              EVALUATION_RUN_DISPATCH_JOB,
              { every: 60_000 },
              {
                name: EVALUATION_RUN_DISPATCH_JOB,
                data: {},
                opts: {
                  attempts: 3,
                  backoff: { type: EVALUATION_RUN_RETRY_BACKOFF },
                  removeOnComplete: 100,
                  removeOnFail: 500,
                },
              },
            ),
          remove: () => evaluationRunQueue.removeJobScheduler(EVALUATION_RUN_DISPATCH_JOB),
        },
      ])
    }
  }, cleanupAfterStartupFailure)

  const intakeVerification = env.INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED
    ? await createIntakeUploadVerificationResources().catch(async (error) => {
        await cleanupAfterStartupFailure()
        throw error
      })
    : null
  if (intakeVerification) {
    schedulerQueueResources.push({
      name: intakeVerification.queue.name,
      close: () => intakeVerification.queue.close(),
    })
  }

  const observeWorkerRuntime = <DataType, ResultType, NameType extends string>(
    queueName: string,
    worker: Worker<DataType, ResultType, NameType>,
  ) => {
    worker.on('error', (error) => {
      logger.error({
        action: 'workers.runtime.error',
        queueName,
        error: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      })
    })
    return worker
  }

  const weeklyDigestWorker = observeWorkerRuntime(
    WEEKLY_DIGEST_QUEUE,
    new Worker(WEEKLY_DIGEST_QUEUE, handleWeeklyDigestQueueJob, {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === WEEKLY_DIGEST_RETRY_BACKOFF) {
            return getWeeklyDigestBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  const dailyRollupWorker = observeWorkerRuntime(
    DAILY_ROLLUP_QUEUE,
    new Worker(DAILY_ROLLUP_QUEUE, handleDailyRollupQueueJob, {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === DAILY_ROLLUP_RETRY_BACKOFF) {
            return getDailyRollupBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  const embedPlaceWorker = observeWorkerRuntime(
    EMBED_PLACE_QUEUE,
    new Worker(EMBED_PLACE_QUEUE, handleEmbedPlaceQueueJob, {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === EMBED_PLACE_RETRY_BACKOFF) {
            return getEmbedPlaceBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  const embedKnowledgeEntryWorker = observeWorkerRuntime(
    EMBED_KNOWLEDGE_ENTRY_QUEUE,
    new Worker(EMBED_KNOWLEDGE_ENTRY_QUEUE, handleEmbedKnowledgeEntryQueueJob, {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === EMBED_KNOWLEDGE_ENTRY_RETRY_BACKOFF) {
            return getEmbedKnowledgeEntryBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  const embeddingDispatchWorker = observeWorkerRuntime(
    EMBEDDING_DISPATCH_QUEUE,
    new Worker(EMBEDDING_DISPATCH_QUEUE, handleEmbeddingDispatchQueueJob, {
      connection,
      concurrency: 1,
    }),
  )

  // Keep kick consumption active even when recurring dispatch scans are disabled.
  const generationDispatchWorker = observeWorkerRuntime(
    GENERATION_DISPATCH_QUEUE,
    new Worker(GENERATION_DISPATCH_QUEUE, handleGenerationDispatchQueueJob, {
      connection,
      concurrency: 1,
    }),
  )

  const generationRecoveryWorker = observeWorkerRuntime(
    GENERATION_RECOVERY_QUEUE,
    new Worker(GENERATION_RECOVERY_QUEUE, handleGenerationRecoveryQueueJob, {
      connection,
      concurrency: 1,
    }),
  )

  const analyticsEnrichmentWorker = observeWorkerRuntime(
    ANALYTICS_ENRICHMENT_QUEUE,
    new Worker(ANALYTICS_ENRICHMENT_QUEUE, handleAnalyticsEnrichmentQueueJob, {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === ANALYTICS_ENRICHMENT_RETRY_BACKOFF) {
            return getAnalyticsEnrichmentBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  const sendEmailWorker = observeWorkerRuntime(
    SEND_EMAIL_QUEUE,
    new Worker(SEND_EMAIL_QUEUE, handleSendEmailQueueJob, {
      connection,
      concurrency: 4,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === SEND_WELCOME_EMAIL_RETRY_BACKOFF) {
            return getSendWelcomeEmailBackoffDelay(attemptsMade)
          }

          if (type === SEND_PROSPECT_OUTREACH_RETRY_BACKOFF) {
            return Math.min(60_000, 2_000 * 2 ** Math.max(0, attemptsMade - 1))
          }

          return 0
        },
      },
    }),
  )

  const operationalEventDeliveryWorker = observeWorkerRuntime(
    OPERATIONAL_EVENT_DELIVERY_QUEUE,
    new Worker(OPERATIONAL_EVENT_DELIVERY_QUEUE, handleOperationalEventDeliveryJob, {
      connection,
      concurrency: 1,
    }),
  )

  const prospectImportWorker = observeWorkerRuntime(
    PROSPECT_IMPORT_QUEUE,
    new Worker(PROSPECT_IMPORT_QUEUE, handleProspectImportQueueJob, {
      connection,
      concurrency: 1,
      settings: {
        backoffStrategy: (attemptsMade, type) =>
          type === PROSPECT_IMPORT_RETRY_BACKOFF
            ? Math.min(10_000 * 2 ** Math.max(0, attemptsMade - 1), 5 * 60_000)
            : 0,
      },
    }),
  )

  const gmailSyncWorker = observeWorkerRuntime(
    GMAIL_SYNC_QUEUE,
    new Worker(GMAIL_SYNC_QUEUE, handleGmailSyncQueueJob, {
      connection,
      concurrency: 1,
    }),
  )

  const billingReconciliationWorker = observeWorkerRuntime(
    BILLING_RECONCILIATION_QUEUE,
    new Worker(BILLING_RECONCILIATION_QUEUE, handleBillingReconciliationQueueJob, {
      connection,
      concurrency: 1,
    }),
  )

  const accountSummaryRefreshWorker = observeWorkerRuntime(
    ACCOUNT_SUMMARY_REFRESH_QUEUE,
    new Worker(ACCOUNT_SUMMARY_REFRESH_QUEUE, handleAccountSummaryRefreshQueueJob, {
      connection,
      concurrency: 1,
    }),
  )

  const answerAnalysisWorker = observeWorkerRuntime(
    ANSWER_ANALYSIS_QUEUE,
    new Worker(ANSWER_ANALYSIS_QUEUE, handleAnswerAnalysisQueueJob, {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === ANSWER_ANALYSIS_RETRY_BACKOFF) {
            return getAnswerAnalysisBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  const weeklyReportWorker = observeWorkerRuntime(
    WEEKLY_REPORT_QUEUE,
    new Worker(WEEKLY_REPORT_QUEUE, handleWeeklyReportQueueJob, {
      connection,
      concurrency: 2,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type === WEEKLY_REPORT_RETRY_BACKOFF) {
            return getWeeklyReportBackoffDelay(attemptsMade)
          }

          return 0
        },
      },
    }),
  )

  // A media job may hold several GB of temporary data and make many model calls.
  // The queue-global ceiling configured above serializes every worker replica;
  // local concurrency remains one as a second, process-level boundary.
  const mediaIngestionWorker = observeWorkerRuntime(
    MEDIA_INGESTION_QUEUE,
    new Worker(MEDIA_INGESTION_QUEUE, handleMediaIngestionQueueJob, {
      connection,
      concurrency: 1,
      settings: {
        backoffStrategy: (attemptsMade, type) =>
          type === MEDIA_INGESTION_RETRY_BACKOFF ? Math.min(attemptsMade * 60_000, 5 * 60_000) : 0,
      },
    }),
  )
  mediaIngestionWorker.on('lockRenewalFailed', (jobIds) => {
    const cancelled = cancelMediaJobsAfterLockRenewalFailure(mediaIngestionWorker, jobIds)
    logger.error({
      action: 'media-ingestion.lock-renewal-failed',
      affectedJobs: jobIds.length,
      cancelledJobs: cancelled,
      error: 'Worker lost one or more media job locks.',
    })
  })
  mediaIngestionWorker.on('error', () => {
    cancelAllMediaJobsAfterWorkerError(mediaIngestionWorker)
  })

  // This consumer does not exist unless the server-only rollout gate is
  // explicitly enabled. Each job additionally rechecks the tenant feature flag
  // before every provider dispatch, so changing either gate fails closed.
  const evaluationRunWorker = env.EVALUATION_RUNNER_ENABLED
    ? observeWorkerRuntime(
        EVALUATION_RUN_QUEUE,
        new Worker(EVALUATION_RUN_QUEUE, handleEvaluationRunQueueJob, {
          connection,
          concurrency: 1,
          settings: {
            backoffStrategy: (attemptsMade, type) =>
              type === EVALUATION_RUN_RETRY_BACKOFF
                ? getEvaluationRunBackoffDelay(attemptsMade)
                : 0,
          },
        }),
      )
    : null

  const agentRunWorker = env.AGENT_RUNNER_ENABLED
    ? observeWorkerRuntime(
        AGENT_RUN_QUEUE,
        new Worker(AGENT_RUN_QUEUE, handleAgentRunQueueJob, {
          connection,
          concurrency: 1,
          settings: {
            backoffStrategy: (attemptsMade, type) =>
              type === AGENT_RUN_RETRY_BACKOFF ? Math.min(attemptsMade * 30_000, 5 * 60_000) : 0,
          },
        }),
      )
    : null

  const handleCompletedJob = (job: Job) => {
    logger.info({
      action: 'workers.job.completed',
      jobId: job.id,
      jobName: job.name,
      queueName: job.queueName,
    })
  }

  const handleFailedJob = (job: Job | undefined, error: Error) => {
    logger.error({
      action: 'workers.job.failed',
      error: error.message,
      ...(job?.id ? { jobId: job.id } : {}),
      ...(job?.name ? { jobName: job.name } : {}),
      ...(job?.queueName ? { queueName: job.queueName } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    })
  }

  const workers = [
    ...(intakeVerification
      ? [{ name: intakeVerification.queue.name, worker: intakeVerification.worker }]
      : []),
    { name: WEEKLY_DIGEST_QUEUE, worker: weeklyDigestWorker },
    { name: DAILY_ROLLUP_QUEUE, worker: dailyRollupWorker },
    { name: EMBED_PLACE_QUEUE, worker: embedPlaceWorker },
    { name: EMBED_KNOWLEDGE_ENTRY_QUEUE, worker: embedKnowledgeEntryWorker },
    { name: EMBEDDING_DISPATCH_QUEUE, worker: embeddingDispatchWorker },
    { name: GENERATION_DISPATCH_QUEUE, worker: generationDispatchWorker },
    { name: GENERATION_RECOVERY_QUEUE, worker: generationRecoveryWorker },
    { name: ANALYTICS_ENRICHMENT_QUEUE, worker: analyticsEnrichmentWorker },
    { name: SEND_EMAIL_QUEUE, worker: sendEmailWorker },
    { name: OPERATIONAL_EVENT_DELIVERY_QUEUE, worker: operationalEventDeliveryWorker },
    { name: PROSPECT_IMPORT_QUEUE, worker: prospectImportWorker },
    { name: GMAIL_SYNC_QUEUE, worker: gmailSyncWorker },
    { name: BILLING_RECONCILIATION_QUEUE, worker: billingReconciliationWorker },
    { name: ACCOUNT_SUMMARY_REFRESH_QUEUE, worker: accountSummaryRefreshWorker },
    { name: ANSWER_ANALYSIS_QUEUE, worker: answerAnalysisWorker },
    { name: WEEKLY_REPORT_QUEUE, worker: weeklyReportWorker },
    { name: MEDIA_INGESTION_QUEUE, worker: mediaIngestionWorker },
    ...(evaluationRunWorker ? [{ name: EVALUATION_RUN_QUEUE, worker: evaluationRunWorker }] : []),
    ...(agentRunWorker ? [{ name: AGENT_RUN_QUEUE, worker: agentRunWorker }] : []),
  ]

  for (const { worker } of workers) {
    worker.on('completed', handleCompletedJob)
    worker.on('failed', handleFailedJob)
  }

  const stopProspectOutboxDispatcher = startProspectOutboxDispatcher()
  const stopHeartbeat = await startOperationalHeartbeat('provider-enabled')

  logger.info({
    action: 'workers.started',
    mode: 'provider-enabled',
    outboundProviderWorkersEnabled: true,
    recurringSchedulersEnabled: env.WORKER_SCHEDULERS_ENABLED,
    embeddingDispatchEnabled: env.EMBEDDING_DISPATCH_ENABLED,
    generationDispatchEnabled: env.GENERATION_DISPATCH_ENABLED,
    generationRecoveryEnabled: env.GENERATION_RECOVERY_ENABLED,
    evaluationRunnerEnabled: env.EVALUATION_RUNNER_ENABLED,
    agentRunnerEnabled: env.AGENT_RUNNER_ENABLED,
    queues: [
      WEEKLY_DIGEST_QUEUE,
      DAILY_ROLLUP_QUEUE,
      EMBED_PLACE_QUEUE,
      EMBED_KNOWLEDGE_ENTRY_QUEUE,
      EMBEDDING_DISPATCH_QUEUE,
      GENERATION_DISPATCH_QUEUE,
      GENERATION_RECOVERY_QUEUE,
      ANALYTICS_ENRICHMENT_QUEUE,
      ANSWER_ANALYSIS_QUEUE,
      WEEKLY_REPORT_QUEUE,
      SEND_EMAIL_QUEUE,
      OPERATIONAL_EVENT_DELIVERY_QUEUE,
      PROSPECT_IMPORT_QUEUE,
      GMAIL_SYNC_QUEUE,
      BILLING_RECONCILIATION_QUEUE,
      ACCOUNT_SUMMARY_REFRESH_QUEUE,
      MEDIA_INGESTION_QUEUE,
      ...(evaluationRunWorker ? [EVALUATION_RUN_QUEUE] : []),
      ...(agentRunWorker ? [AGENT_RUN_QUEUE] : []),
      ...(intakeVerification ? [intakeVerification.queue.name] : []),
    ],
  })

  const shutdown = createShutdownCoordinator({
    onStart: () => logger.info({ action: 'workers.shutdown' }),
    phases: [
      {
        name: 'heartbeat',
        resources: [
          { name: 'prospect-outbox-dispatcher', close: async () => stopProspectOutboxDispatcher() },
          { name: 'operational', close: async () => stopHeartbeat() },
        ],
      },
      {
        name: 'workers',
        resources: workers.map(({ name, worker }) => ({ name, close: () => worker.close() })),
      },
      {
        name: 'scheduler-queues',
        resources: schedulerQueueResources,
      },
      {
        name: 'enqueue-queues',
        resources: [{ name: 'cached', close: closeJobQueues }],
      },
      {
        name: 'connection',
        resources: [{ name: 'bullmq', close: closeBullMQConnection }],
      },
    ],
  })

  registerShutdownSignals(shutdown)

  return {
    analyticsEnrichmentQueue,
    analyticsEnrichmentWorker,
    answerAnalysisQueue,
    answerAnalysisWorker,
    dailyRollupQueue,
    dailyRollupWorker,
    embedKnowledgeEntryWorker,
    embeddingDispatchQueue,
    embeddingDispatchWorker,
    generationDispatchQueue,
    generationDispatchWorker,
    generationRecoveryQueue,
    generationRecoveryWorker,
    embedPlaceQueue,
    embedPlaceWorker,
    sendEmailWorker,
    operationalEventDeliveryWorker,
    operationalEventDeliveryQueue,
    prospectImportQueue,
    prospectImportWorker,
    gmailSyncQueue,
    gmailSyncWorker,
    billingReconciliationQueue,
    billingReconciliationWorker,
    mediaIngestionQueue,
    mediaIngestionWorker,
    evaluationRunWorker,
    evaluationRunQueue,
    agentRunWorker,
    agentRunQueue,
    weeklyReportQueue,
    weeklyReportWorker,
    weeklyDigestQueue,
    weeklyDigestWorker,
    intakeVerification,
    shutdown,
  }
}
