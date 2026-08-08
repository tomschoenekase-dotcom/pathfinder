export { db } from './client'
export { withTenantIsolationBypass } from './middleware/tenant-isolation'
export { writeAuditLog, writeAuditLogStrict } from './helpers/audit'
export {
  lockContentVersionEntity,
  lockOperationalUpdateCapacity,
  setContentVersionContext,
} from './helpers/content-version-context'
export type {
  ContentVersionPackageAction,
  ContentVersionPackageContext,
  ContentVersionSourceProvenance,
} from './helpers/content-version-context'
export { lockVenueContentMutation, lockVenueReportMutation } from './helpers/venue-content-lock'
export {
  findTerminalJobRecordEvidence,
  writeJobRecord,
  updateJobRecord,
} from './helpers/job-records'
export {
  acquireAnswerAnalysisExecution,
  acquireAnswerAnalysisRecoveryExecution,
  acquireWeeklyReportExecution,
  acquireWeeklyReportRecoveryExecution,
  GENERATION_EXECUTION_LEASE_MS,
} from './helpers/generation-execution-claims'
export type {
  AcquireAnswerAnalysisExecutionParams,
  AcquireAnswerAnalysisRecoveryExecutionParams,
  AcquireWeeklyReportExecutionParams,
  AcquireWeeklyReportRecoveryExecutionParams,
  GenerationExecutionAcquisition,
  GenerationRecoveryExecutionAcquisition,
} from './helpers/generation-execution-claims'
export {
  discoverExpiredGenerationExecutions,
  GENERATION_RECOVERY_MAX_PER_TYPE,
} from './helpers/generation-recovery'
export type {
  ExpiredAnswerAnalysisExecution,
  ExpiredGenerationExecutions,
  ExpiredWeeklyReportExecution,
} from './helpers/generation-recovery'
export {
  acquireEmbeddingWork,
  EMBEDDING_WORK_LEASE_MS,
  releaseEmbeddingWork,
} from './helpers/embedding-work-claims'
export {
  acknowledgeEmbeddingDispatch,
  EMBEDDING_DISPATCH_BATCH_SIZE,
  EMBEDDING_DISPATCH_LEASE_MS,
  failEmbeddingDispatch,
  leaseEmbeddingDispatchBatch,
} from './helpers/embedding-dispatches'
export type { LeasedEmbeddingDispatch } from './helpers/embedding-dispatches'
export {
  adoptLegacyNullLeaseGenerationDispatches,
  deferGenerationRequestDispatch,
  failGenerationRequestDispatch,
  GENERATION_DISPATCH_BATCH_SIZE,
  GENERATION_DISPATCH_DEFER_MS,
  GENERATION_DISPATCH_LEASE_MS,
  GENERATION_DISPATCH_MAX_ERROR_LENGTH,
  leaseGenerationRequestDispatches,
  settleProgressedGenerationRequestDispatch,
  settleGenerationRequestDispatch,
} from './helpers/generation-request-dispatches'
export type {
  ExactGenerationRequestDispatch,
  LeasedGenerationRequestDispatch,
} from './helpers/generation-request-dispatches'
export {
  EMBEDDING_FRESHNESS_CANARY_MAX,
  insertEmbeddingFreshnessCanary,
} from './helpers/embedding-freshness-canary'
export type { EmbeddingFreshnessCanaryTarget } from './helpers/embedding-freshness-canary'
export type {
  AcquireEmbeddingWorkParams,
  EmbeddingWorkAcquisition,
} from './helpers/embedding-work-claims'
export type {
  JobFailureDisposition,
  TerminalJobRecordEvidence,
  WriteJobRecordParams,
} from './helpers/job-records'
export { featureEnabled } from './helpers/feature-flags'
export { checkDatabaseConnection } from './helpers/health'
export {
  CLERK_WEBHOOK_EVENT_TYPE_MAX_LENGTH,
  CLERK_WEBHOOK_PROVIDER_EVENT_ID_MAX_LENGTH,
  CLERK_WEBHOOK_TRANSACTION_MAX_ATTEMPTS,
  ClerkWebhookReceiptConflictError,
  beginWelcomeEmailDeliveryAttempt,
  getWelcomeEmailDeliveryState,
  handleClerkEvent,
  isClerkWebhookReceiptConflictError,
  markWelcomeEmailDeliveryComplete,
  mapClerkRoleToTenantRole,
} from './helpers/membership-sync'
export type {
  ClerkWebhookEvent,
  ClerkWebhookProcessingResult,
  VerifiedClerkEventIdentity,
  WelcomeEmailDeliveryState,
} from './helpers/membership-sync'
export {
  searchKnowledgeByEmbedding,
  searchPlacesByEmbedding,
  storeKnowledgeEntryEmbeddingForScope,
  storePlaceEmbeddingForScope,
} from './helpers/semantic-search'
export type { SemanticKnowledgeEntry, SemanticPlace } from './helpers/semantic-search'
export {
  findVenuePackageKnowledgeSemanticDuplicates,
  findVenuePackagePlaceSemanticDuplicates,
  getVenuePackageSemanticCoverage,
} from './helpers/venue-package-semantic-duplicates'
export type {
  SemanticVectorCoverage,
  VenuePackageSemanticCoverage,
  VenuePackageSemanticDuplicateCandidate,
  VenuePackageSemanticDuplicateMatch,
} from './helpers/venue-package-semantic-duplicates'
export { buildKnowledgeEntryText, buildPlaceText } from './helpers/content-text'
export { embeddingSourceHash } from './helpers/embedding-identity'
export type { EmbeddingSourceEntity } from './helpers/embedding-identity'
export { repairCompleteClaimMissingVector } from './helpers/embedding-claim-repair'
export type { RepairCompleteClaimResult } from './helpers/embedding-claim-repair'

export type {
  AnalyticsEvent,
  JobRecord,
  JobStatus,
  AuditLog,
  ClerkWebhookReceipt,
  DailyRollup,
  MembershipStatus,
  Message,
  MessageRole,
  OperationalUpdate,
  OperationalUpdateSeverity,
  Place,
  PlatformConfig,
  QuestionCluster,
  Tenant,
  TenantFeatureFlag,
  TenantMembership,
  TenantRole,
  TenantStatus,
  User,
  Venue,
  VenueKnowledgeEntry,
  VisitorSession,
  WeeklyDigest,
  WeeklyDigestStatus,
} from '@prisma/client'
export type { WriteAuditLogParams } from './helpers/audit'
