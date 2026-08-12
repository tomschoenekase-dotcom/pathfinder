export { db } from './client'
export { withTenantIsolationBypass } from './middleware/tenant-isolation'
export { writeAuditLog, writeAuditLogStrict } from './helpers/audit'
export {
  AgentIdentityConfigurationError,
  createDisabledAgentIdentity,
  disableAgentIdentity,
  editDisabledAgentIdentity,
} from './helpers/agent-identity-configuration-actions'
export type {
  AgentIdentityConfigurationActor,
  AgentIdentityConfigurationScope,
} from './helpers/agent-identity-configuration-actions'
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
  normalizeSupportMissingInformation,
  SUPPORT_TRIAGE_MISSING_INFORMATION_ITEM_MAX,
  SUPPORT_TRIAGE_MISSING_INFORMATION_MAX,
  triageSupportRequestAction,
} from './helpers/support-triage-actions'
export type { SupportTriageActor } from './helpers/support-triage-actions'
export {
  linkSupportRequestDraftPackageAction,
  SupportPackageHandoffError,
} from './helpers/support-package-handoffs'
export type { SupportPackageHandoffActor } from './helpers/support-package-handoffs'
export {
  SupportStatusTransitionError,
  transitionSupportRequestStatusAction,
} from './helpers/support-status-transitions'
export type { SupportStatusTransitionActor } from './helpers/support-status-transitions'
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
  isVerifiedEvaluationRunIdentity,
  evaluationRunIdentityHash,
  evaluationSnapshotHash,
  EvaluationRunIdentityError,
  EvaluationRunReplayConflictError,
} from './helpers/evaluation-runs'
export type { EvaluationRunIdentity } from './helpers/evaluation-runs'
export {
  claimEvaluationRunAttempt,
  failEvaluationRunAttempt,
  finishEvaluationRunAttempt,
  isEvaluationRunCancellationRequested,
  markEvaluationRunQueued,
  renewEvaluationRunLease,
  requestEvaluationRunCancellation,
} from './helpers/evaluation-run-lifecycle'
export type { EvaluationRunAttemptClaim } from './helpers/evaluation-run-lifecycle'
export {
  EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY,
  isEvaluationRuntimeDurablyEnabled,
} from './helpers/evaluation-runtime-admission'
export {
  createOrReplayEvaluationResult,
  EvaluationResultIdentityError,
  EvaluationResultReplayConflictError,
} from './helpers/evaluation-results'
export type { EvaluationResultTerminal } from './helpers/evaluation-results'
export {
  EvaluationRunCostReservationError,
  persistEvaluationResultWithCostReservation,
  persistEvaluationResultWithLease,
  reserveEvaluationRunCaseCost,
} from './helpers/evaluation-run-cost-reservations'
export type { EvaluationRunCostReservationAcquisition } from './helpers/evaluation-run-cost-reservations'
export { hashEvalCase, hashEvalObservation } from './helpers/evaluation-hash'
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
export {
  AiConfigurationActionError,
  configurationOverrideFromRow,
  configurationValuesFromRow,
  resetAiWorkloadConfigurationOverrideAction,
  saveAiWorkloadConfigurationOverrideAction,
} from './helpers/ai-workload-configuration-actions'
export type {
  AiConfigurationActionClient,
  AiConfigurationActionErrorCode,
  AiConfigurationHumanActor,
  AiConfigurationScope,
  AiConfigurationValues,
} from './helpers/ai-workload-configuration-actions'
export {
  buildOperationalUpdatePreview,
  createOperationalUpdateAction,
  expireOperationalUpdateAction,
  MAX_GUEST_OPERATIONAL_UPDATES,
  OperationalUpdateActionError,
  operationalUpdateActionSelect,
  scheduleOperationalUpdateAction,
  updateOperationalUpdateAction,
} from './helpers/operational-update-actions'
export type {
  OperationalUpdateActionClient,
  OperationalUpdateActionErrorCode,
  OperationalUpdateActionResult,
  OperationalUpdateFields,
  OperationalUpdateHumanActor,
  OperationalUpdatePreview,
} from './helpers/operational-update-actions'
export {
  createIntakeProposal,
  IntakeActionError,
  intakeProposalInput,
  interviewProposalInput,
  interviewSubmissionInput,
  linkIntakePackageDraft,
  listIntakeProposals,
  websiteProposalInput,
} from './helpers/intake-actions'
export type {
  IntakeActionClient,
  IntakeActionErrorCode,
  IntakeProposalInput,
} from './helpers/intake-actions'
export {
  addUniversalContentRevisionAction,
  buildUniversalContentPreview,
  createUniversalContentAction,
  retireUniversalContentAction,
  UniversalContentActionError,
} from './helpers/universal-content-actions'
export type {
  UniversalContentActionClient,
  UniversalContentActionErrorCode,
  UniversalContentActionResult,
  UniversalContentHumanActor,
  UniversalContentPreview,
} from './helpers/universal-content-actions'
export {
  confirmContentCurrentAction,
  ContentHumanReviewError,
} from './helpers/content-human-review-actions'
export {
  bulkCreateLegacyKnowledgeAction,
  bulkCreateLegacyPlacesAction,
  createLegacyKnowledgeAction,
  createLegacyPlaceAction,
  legacyKnowledgeSelect,
  legacyPlaceSelect,
  LegacyContentActionError,
  retireLegacyKnowledgeAction,
  retireLegacyPlaceAction,
  updateLegacyKnowledgeAction,
  updateLegacyPlaceAction,
} from './helpers/legacy-content-actions'
export type {
  LegacyContentActionClient,
  LegacyContentActionErrorCode,
  LegacyContentActor,
} from './helpers/legacy-content-actions'
export type {
  ContentHumanReviewActor,
  ContentHumanReviewClient,
  ContentHumanReviewEntityType,
  ContentHumanReviewErrorCode,
  ContentHumanReviewProvenanceRepair,
  ContentHumanReviewResult,
} from './helpers/content-human-review-actions'
export {
  createVenueAction,
  normalizeVenueSlug,
  venueCreateSelect,
  venueListSelect,
  VenueActionError,
} from './helpers/venue-create-action'
export type {
  CreateVenueActionInput,
  VenueActionClient,
  VenueHumanActor,
  VenueInitialContent,
} from './helpers/venue-create-action'
export {
  deleteVenueAction,
  updateVenueAction,
  updateVenueAiConfigAction,
  updateVenueChatDesignAction,
  venueAiConfigSelect,
  venueChatDesignSelect,
} from './helpers/venue-actions'
export type {
  UpdateVenueAiConfigFields,
  UpdateVenueChatDesignFields,
  UpdateVenueFields,
} from './helpers/venue-actions'
