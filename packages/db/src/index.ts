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
  deferAnswerAnalysisExecution,
  deferWeeklyReportExecution,
  GENERATION_EXECUTION_LEASE_MS,
} from './helpers/generation-execution-claims'
export type {
  AcquireAnswerAnalysisExecutionParams,
  AcquireAnswerAnalysisRecoveryExecutionParams,
  AcquireWeeklyReportExecutionParams,
  AcquireWeeklyReportRecoveryExecutionParams,
  DeferAnswerAnalysisExecutionParams,
  DeferWeeklyReportExecutionParams,
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
export {
  assertGlobalAiAvailable,
  GlobalAiAdmissionError,
  readGlobalAiControl,
} from './helpers/incident-control'
export type { GlobalAiControlState } from './helpers/incident-control'
export {
  assertVenueAiAvailable,
  assertVenueAvailable,
  isVenueUnavailableError,
  VenueUnavailableError,
} from './helpers/venue-availability'
export {
  AI_COST_BUDGET_COVERAGE_VERSION,
  AI_COST_RESERVATION_TTL_MS,
  AiCostBudgetExceededError,
  AiCostBudgetInvariantError,
  AiCostBudgetUnavailableError,
  markAiCostAttemptDispatched,
  releaseUndispatchedAiCostAttempt,
  reconcileExpiredAiCostAttempts,
  reserveAiCostAttempt,
  settleAiCostAttemptAmbiguous,
  settleAiCostAttemptExact,
} from './helpers/ai-cost-budgets'
export { isAiAdmissionControlError } from './helpers/ai-admission-control'
export {
  appendSupportMessageAction,
  createSupportRequestAction,
  SupportActionError,
} from './helpers/support-actions'
export type { SupportActionActor, SupportAttachmentDraft } from './helpers/support-actions'
export {
  ApprovalDecisionActionError,
  recordApprovalDecisionAction,
} from './helpers/approval-decisions'
export type { ApprovalDecisionActor } from './helpers/approval-decisions'
export type {
  AiCostAttemptIdentity,
  AiCostReservationRef,
  ReconcileExpiredAiCostAttemptsResult,
} from './helpers/ai-cost-budgets'
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
export {
  createOrReplayEvaluationCase,
  EvaluationCaseIdentityError,
  EvaluationCaseReplayConflictError,
} from './helpers/evaluation-cases'
export type { EvaluationCaseIdentity } from './helpers/evaluation-cases'
export {
  canonicalEvaluationJson,
  createOrReplayEvaluationRun,
  evaluationRunIdentityHash,
  evaluationSnapshotHash,
  EvaluationRunIdentityError,
  EvaluationRunReplayConflictError,
} from './helpers/evaluation-runs'
export type { EvaluationRunIdentity } from './helpers/evaluation-runs'
export {
  createOrReplayEvaluationResult,
  EvaluationResultIdentityError,
  EvaluationResultReplayConflictError,
} from './helpers/evaluation-results'
export type { EvaluationResultTerminal } from './helpers/evaluation-results'
export { hashEvalObservation } from './helpers/evaluation-hash'
export {
  buildVenueContentSnapshot,
  createVenueContentSnapshot,
  VENUE_CONTENT_SNAPSHOT_SCHEMA_VERSION,
  VenueContentSnapshotError,
} from './helpers/venue-content-snapshot'
export type {
  VenueContentSnapshot,
  VenueContentSnapshotSource,
} from './helpers/venue-content-snapshot'

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
