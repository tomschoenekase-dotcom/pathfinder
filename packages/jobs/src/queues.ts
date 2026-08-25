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
export const EMBED_COMPANY_KNOWLEDGE_PROCESS_JOB = 'embed-company-knowledge-process'
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
export const SEND_PROSPECT_OUTREACH_JOB = 'send-prospect-outreach'
export const SEND_PROSPECT_OUTREACH_RETRY_BACKOFF = 'send-prospect-outreach-retry'
export const OPERATIONAL_EVENT_DELIVERY_QUEUE = queueName('operational-event-delivery')
export const OPERATIONAL_EVENT_DELIVERY_PROCESS_JOB = 'operational-event-delivery-process'
export const OPERATIONAL_EVENT_DELIVERY_SCHEDULER_JOB = 'operational-event-delivery-scheduler'
export const OPERATIONAL_EVENT_DELIVERY_RETRY_BACKOFF = 'operational-event-delivery-retry'

export const MEDIA_INGESTION_QUEUE = queueName('media-ingestion')
export const MEDIA_INGESTION_PROCESS_JOB = 'media-ingestion-process'
export const MEDIA_INGESTION_RETRY_BACKOFF = 'media-ingestion-retry'

export const EVALUATION_RUN_QUEUE = queueName('evaluation-run')
export const EVALUATION_RUN_PROCESS_JOB = 'evaluation-run-process'
export const EVALUATION_RUN_DISPATCH_JOB = 'evaluation-run-dispatch'
export const EVALUATION_RUN_RETRY_BACKOFF = 'evaluation-run-retry'

export const AGENT_RUN_QUEUE = queueName('agent-run')
export const AGENT_RUN_PROCESS_JOB = 'agent-run-process'
export const AGENT_RUN_RETRY_BACKOFF = 'agent-run-retry'

export const PROSPECT_IMPORT_QUEUE = queueName('prospect-import')
export const PROSPECT_IMPORT_COMMIT_JOB = 'prospect-import-commit'
export const PROSPECT_IMPORT_INSPECT_JOB = 'prospect-import-inspect'
export const PROSPECT_IMPORT_STAGE_JOB = 'prospect-import-stage'
export const PROSPECT_IMPORT_RETRY_BACKOFF = 'prospect-import-retry'
export const GMAIL_SYNC_QUEUE = queueName('gmail-sync')
export const GMAIL_SYNC_NOTIFICATION_JOB = 'gmail-sync-notification'
export const GMAIL_SYNC_RECONCILIATION_JOB = 'gmail-sync-reconciliation'
export const GMAIL_SYNC_WATCH_RENEWAL_JOB = 'gmail-sync-watch-renewal'

export const BILLING_RECONCILIATION_QUEUE = queueName('billing-reconciliation')
export const BILLING_RECONCILIATION_PROCESS_JOB = 'billing-reconciliation-process'
export const BILLING_RECONCILIATION_SCHEDULER_JOB = 'billing-reconciliation-scheduler'

export const ACCOUNT_SUMMARY_REFRESH_QUEUE = queueName('account-summary-refresh')
export const ACCOUNT_SUMMARY_REFRESH_SCHEDULER_JOB = 'account-summary-refresh-scheduler'

export const VOICE_SESSION_RECOVERY_QUEUE = queueName('voice-session-recovery')
export const VOICE_SESSION_RECOVERY_SCHEDULER_JOB = 'voice-session-recovery-scheduler'

export const INTAKE_UPLOAD_VERIFICATION_QUEUE = queueName('intake-upload-verification')
export const INTAKE_UPLOAD_VERIFICATION_PROCESS_JOB = 'intake-upload-verification-process'
export const INTAKE_UPLOAD_VERIFICATION_RECONCILIATION_JOB =
  'intake-upload-verification-reconciliation'

/**
 * Complete BullMQ inventory used for platform-wide operational observation.
 * Every exported queue belongs here even when its worker is policy-disabled, so a
 * disabled runtime cannot also disappear from queue-health evidence.
 */
export const OPERATIONAL_QUEUE_NAMES = Object.freeze([
  WEEKLY_DIGEST_QUEUE,
  ANSWER_ANALYSIS_QUEUE,
  WEEKLY_REPORT_QUEUE,
  GENERATION_RECOVERY_QUEUE,
  GENERATION_DISPATCH_QUEUE,
  DAILY_ROLLUP_QUEUE,
  EMBED_PLACE_QUEUE,
  EMBED_KNOWLEDGE_ENTRY_QUEUE,
  EMBEDDING_DISPATCH_QUEUE,
  ANALYTICS_ENRICHMENT_QUEUE,
  SEND_EMAIL_QUEUE,
  OPERATIONAL_EVENT_DELIVERY_QUEUE,
  MEDIA_INGESTION_QUEUE,
  EVALUATION_RUN_QUEUE,
  AGENT_RUN_QUEUE,
  PROSPECT_IMPORT_QUEUE,
  GMAIL_SYNC_QUEUE,
  BILLING_RECONCILIATION_QUEUE,
  ACCOUNT_SUMMARY_REFRESH_QUEUE,
  VOICE_SESSION_RECOVERY_QUEUE,
  INTAKE_UPLOAD_VERIFICATION_QUEUE,
] as const)
