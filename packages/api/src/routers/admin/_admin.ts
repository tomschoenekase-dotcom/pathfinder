import { mergeRouters } from '../../core'

import { adminAnswerAnalysisRouter } from './answer-analysis'
import { adminAttentionConsoleRouter } from './attention-console-router'
import { adminAiWorkloadConfigurationRouter } from './ai-workload-configuration'
import { adminAgentOperationsRouter } from './agent-operations'
import { adminAgentBridgeOperationsRouter } from './agent-bridge-operations'
import { adminAgentIdentityConfigurationRouter } from './agent-identity-configuration'
import { adminSupportOpenPolicyRouter } from './support-open-policy'
import { adminSupportCompletionApprovalRouter } from './support-completion-approval'
import { adminSupportDraftApprovalRouter } from './support-package-draft-approval'
import { adminSupportApplicationApprovalRouter } from './support-package-application-approval'
import { adminSupportReversionApprovalRouter } from './support-package-reversion-approval'
import { adminSupportHandoffSupersessionApprovalRouter } from './support-package-handoff-supersession-approval'
import { adminAgentApprovalDecisionsRouter } from './agent-approval-decisions'
import { adminAgentRunCancellationRouter } from './agent-run-cancellation'
import { adminAgentQuestionsRouter } from './agent-questions'
import { adminAgentTaskRequestsRouter } from './agent-task-requests'
import { adminAgentOutcomesRouter } from './agent-outcomes'
import { adminChatlogsRouter } from './chatlogs'
import { adminClientAnalyticsRouter } from './client-analytics'
import { adminClientManagementRouter } from './client-management'
import { adminClientSearchRouter } from './client-search'
import { adminClientDirectorySearchRouter } from './client-directory-search'
import { adminClientReadsRouter } from './client-reads'
import { adminCostBudgetRouter } from './cost-budget'
import { adminDigestRouter } from './digest'
import { adminDeploymentManifestReviewRouter } from './deployment-manifest-review'
import { adminEvaluationOperationsRouter } from './evaluation-operations'
import { adminExternalCredentialsRouter } from './external-credentials'
import { adminFreshnessAuditRouter } from './freshness-audit'
import { adminGuestDesignRouter } from './guest-design'
import { adminOverviewRouter } from './overview'
import { adminOffboardingPlansRouter } from './offboarding-plans'
import { adminOffboardingExportPreviewRouter } from './offboarding-export-preview'
import { adminOffboardingExportFinalizationRouter } from './offboarding-export-finalization'
import { adminIncidentControlRouter } from './incident-control'
import { adminCustomerAccessExecutionRouter } from './customer-access-execution'
import { adminIntakeOperationsRouter } from './intake-operations'
import { adminIntakeUploadReviewRouter } from './intake-upload-review'
import { adminLegacyContentRouter } from './legacy-content'
import { adminNativeVenueDeploymentsRouter } from './native-venue-deployments'
import { adminNativeDeploymentEvaluationsRouter } from './native-deployment-evaluations'
import { adminReportConfigurationRouter } from './report-configuration'
import { adminSupportOperationsRouter } from './support-operations'
import { adminSupportManualLoopRouter } from './support-manual-loop'
import { adminSupportAgentRunLineageRouter } from './support-agent-run-lineage'
import { adminSupportAttachmentsRouter } from './support-attachments'
import { adminSupportReviewedDraftRouter } from './support-reviewed-drafts'
import { adminUniversalContentRouter } from './universal-content'
import { adminWeeklyReportsRouter } from './weekly-reports'
import { adminWeeklyReportLifecycleRouter } from './weekly-report-lifecycle'
import { adminVenueAvailabilityRouter } from './venue-availability'
import { adminVenuePackageOperationsRouter } from './venue-package-operations'
import { adminSecondLayerRouter } from './second-layer'
import { adminTochiRolloutRouter } from './tochi-rollout'
import { adminTerminalRedrivePreviewRouter } from './terminal-redrive-preview'
import { adminOperationalEvidenceRouter } from './guest-chat-incident-evidence'
import { adminKnowledgeProposalsRouter } from './knowledge-proposals'
import { adminLocationAuthoringRouter } from './location-authoring'
import { adminLocationAvailabilityRouter } from './location-availability'
import { adminLocationAuthoringApplicationRouter } from './location-proposal-application'
import { adminLocationFloorAuthoringRouter } from './location-floor-authoring'
import { adminLocationConnectionAuthoringRouter } from './location-connection-authoring'
import { adminProductEntitlementsRouter } from './product-entitlements'
import { adminProspectCrmRouter } from './prospect-crm'
import { adminOperationsReadinessRouter } from './operations-readiness'
import { adminBillingRouter } from './billing'
import { adminBillingRolloutRouter } from './billing-rollout'
import { adminBillingPortfolioRouter } from './billing-portfolio'
import { adminCompanyBrainRouter } from './company-brain'
import { adminPlatformWorkerPolicyCredentialsRouter } from './platform-worker-policy-credentials'
import { adminUnitEconomicsRouter } from './unit-economics'
import { adminGuestAnswerAttributionsRouter } from './guest-answer-attributions'
import { adminRetentionDispositionPreviewRouter } from './retention-disposition-preview'
import { adminPublicInterestRouter } from './public-interest'
import { adminReleaseEvidenceRouter } from './release-evidence'

export const adminRouter = mergeRouters(
  adminOverviewRouter,
  adminAttentionConsoleRouter,
  adminKnowledgeProposalsRouter,
  adminLocationAuthoringRouter,
  adminLocationAvailabilityRouter,
  adminLocationAuthoringApplicationRouter,
  adminLocationFloorAuthoringRouter,
  adminLocationConnectionAuthoringRouter,
  adminProductEntitlementsRouter,
  adminProspectCrmRouter,
  adminOperationsReadinessRouter,
  adminBillingRouter,
  adminBillingRolloutRouter,
  adminBillingPortfolioRouter,
  adminCompanyBrainRouter,
  adminPlatformWorkerPolicyCredentialsRouter,
  adminUnitEconomicsRouter,
  adminGuestAnswerAttributionsRouter,
  adminRetentionDispositionPreviewRouter,
  adminPublicInterestRouter,
  adminReleaseEvidenceRouter,
  adminOffboardingPlansRouter,
  adminOffboardingExportPreviewRouter,
  adminOffboardingExportFinalizationRouter,
  adminAgentOperationsRouter,
  adminAgentBridgeOperationsRouter,
  adminAgentIdentityConfigurationRouter,
  adminSupportOpenPolicyRouter,
  adminSupportCompletionApprovalRouter,
  adminSupportDraftApprovalRouter,
  adminSupportApplicationApprovalRouter,
  adminSupportReversionApprovalRouter,
  adminSupportHandoffSupersessionApprovalRouter,
  adminAgentApprovalDecisionsRouter,
  adminAgentRunCancellationRouter,
  adminAgentQuestionsRouter,
  adminAgentTaskRequestsRouter,
  adminAgentOutcomesRouter,
  adminIncidentControlRouter,
  adminIntakeOperationsRouter,
  adminIntakeUploadReviewRouter,
  adminLegacyContentRouter,
  adminNativeVenueDeploymentsRouter,
  adminNativeDeploymentEvaluationsRouter,
  adminCostBudgetRouter,
  adminEvaluationOperationsRouter,
  adminExternalCredentialsRouter,
  adminFreshnessAuditRouter,
  adminGuestDesignRouter,
  adminSupportOperationsRouter,
  adminSupportManualLoopRouter,
  adminSupportAgentRunLineageRouter,
  adminSupportAttachmentsRouter,
  adminSupportReviewedDraftRouter,
  adminUniversalContentRouter,
  adminClientReadsRouter,
  adminClientAnalyticsRouter,
  adminClientManagementRouter,
  adminClientSearchRouter,
  adminClientDirectorySearchRouter,
  adminChatlogsRouter,
  adminAnswerAnalysisRouter,
  adminAiWorkloadConfigurationRouter,
  adminReportConfigurationRouter,
  adminVenueAvailabilityRouter,
  adminVenuePackageOperationsRouter,
  adminSecondLayerRouter,
  adminWeeklyReportsRouter,
  adminWeeklyReportLifecycleRouter,
  adminDigestRouter,
  adminDeploymentManifestReviewRouter,
  adminTochiRolloutRouter,
  adminTerminalRedrivePreviewRouter,
  adminOperationalEvidenceRouter,
  adminCustomerAccessExecutionRouter,
)
