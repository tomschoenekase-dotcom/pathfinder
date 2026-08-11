import { env } from '@pathfinder/config'

import { environmentQueueName } from './environment-name'
export { CONTENT_EMBEDDING_MAX_ATTEMPTS } from './embedding-policy'

const queueName = (baseName: string) => environmentQueueName(env.RAILWAY_ENVIRONMENT, baseName)

export const WEEKLY_DIGEST_QUEUE = queueName('weekly-digest')
export const WEEKLY_DIGEST_PROCESS_JOB = 'weekly-digest-process'
export const WEEKLY_DIGEST_SCHEDULER_JOB = 'weekly-digest-scheduler'
export const WEEKLY_DIGEST_RETRY_BACKOFF = 'weekly-digest-retry'

export const ANSWER_ANALYSIS_QUEUE = queueName('answer-analysis')
export const ANSWER_ANALYSIS_PROCESS_JOB = 'answer-analysis-process'
export const ANSWER_ANALYSIS_RECOVERY_JOB = 'answer-analysis-recovery'
export const ANSWER_ANALYSIS_RETRY_BACKOFF = 'answer-analysis-retry'

export const WEEKLY_REPORT_QUEUE = queueName('weekly-report')
export const WEEKLY_REPORT_PROCESS_JOB = 'weekly-report-process'
export const WEEKLY_REPORT_RECOVERY_JOB = 'weekly-report-recovery'
export const WEEKLY_REPORT_RETRY_BACKOFF = 'weekly-report-retry'

export const GENERATION_RECOVERY_QUEUE = queueName('generation-recovery')
export const GENERATION_RECOVERY_SCHEDULER_JOB = 'generation-recovery-scheduler'

export const GENERATION_DISPATCH_QUEUE = queueName('generation-dispatch')
export const GENERATION_DISPATCH_SCHEDULER_JOB = 'generation-dispatch-scheduler'
export const GENERATION_DISPATCH_KICK_JOB = 'generation-dispatch-kick'

export const DAILY_ROLLUP_QUEUE = queueName('daily-rollup')
export const DAILY_ROLLUP_PROCESS_JOB = 'daily-rollup-process'
export const DAILY_ROLLUP_SCHEDULER_JOB = 'daily-rollup-scheduler'
export const DAILY_ROLLUP_RETRY_BACKOFF = 'daily-rollup-retry'

export const EMBED_PLACE_QUEUE = queueName('embed-place')
export const EMBED_PLACE_PROCESS_JOB = 'embed-place-process'
export const EMBED_PLACE_RETRY_BACKOFF = 'embed-place-retry'

export const EMBED_KNOWLEDGE_ENTRY_QUEUE = queueName('embed-knowledge-entry')
export const EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB = 'embed-knowledge-entry-process'
export const EMBED_KNOWLEDGE_ENTRY_RETRY_BACKOFF = 'embed-knowledge-entry-retry'

export const EMBEDDING_DISPATCH_QUEUE = queueName('embedding-dispatch')
export const EMBEDDING_DISPATCH_SCHEDULER_JOB = 'embedding-dispatch-scheduler'

export const ANALYTICS_ENRICHMENT_QUEUE = queueName('analytics-enrichment')
export const ANALYTICS_ENRICHMENT_PROCESS_JOB = 'analytics-enrichment-process'
export const ANALYTICS_ENRICHMENT_SCHEDULER_JOB = 'analytics-enrichment-scheduler'
export const ANALYTICS_ENRICHMENT_RETRY_BACKOFF = 'analytics-enrichment-retry'

export const SEND_EMAIL_QUEUE = queueName('send-email')
export const SEND_WELCOME_EMAIL_JOB = 'send-welcome-email'
export const SEND_WELCOME_EMAIL_RETRY_BACKOFF = 'send-welcome-email-retry'

export const MEDIA_INGESTION_QUEUE = queueName('media-ingestion')
export const MEDIA_INGESTION_PROCESS_JOB = 'media-ingestion-process'
export const MEDIA_INGESTION_RETRY_BACKOFF = 'media-ingestion-retry'

export const EVALUATION_RUN_QUEUE = queueName('evaluation-run')
export const EVALUATION_RUN_PROCESS_JOB = 'evaluation-run-process'
export const EVALUATION_RUN_RETRY_BACKOFF = 'evaluation-run-retry'
