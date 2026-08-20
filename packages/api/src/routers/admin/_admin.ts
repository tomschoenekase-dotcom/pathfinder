import { mergeRouters } from '../../core'

import { adminAnswerAnalysisRouter } from './answer-analysis'
import { adminAttentionConsoleRouter } from './attention-console'
import { adminAiWorkloadConfigurationRouter } from './ai-workload-configuration'
import { adminAgentOperationsRouter } from './agent-operations'
import { adminAgentBridgeOperationsRouter } from './agent-bridge-operations'
import { adminAgentIdentityConfigurationRouter } from './agent-identity-configuration'
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
import { adminKnowledgeProposalsRouter } from './knowledge-proposals'
import { adminProductEntitlementsRouter } from './product-entitlements'
import { adminOperationsReadinessRouter } from './operations-readiness'

export const adminRouter = mergeRouters(
  adminOverviewRouter,
  adminAttentionConsoleRouter,
  adminKnowledgeProposalsRouter,
  adminProductEntitlementsRouter,
  adminOperationsReadinessRouter,
  adminOffboardingPlansRouter,
  adminOffboardingExportPreviewRouter,
  adminOffboardingExportFinalizationRouter,
  adminAgentOperationsRouter,
  adminAgentBridgeOperationsRouter,
  adminAgentIdentityConfigurationRouter,
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
)
