import { mergeRouters } from '../../core'

import { adminAnswerAnalysisRouter } from './answer-analysis'
import { adminAiWorkloadConfigurationRouter } from './ai-workload-configuration'
import { adminAgentOperationsRouter } from './agent-operations'
import { adminAgentApprovalDecisionsRouter } from './agent-approval-decisions'
import { adminChatlogsRouter } from './chatlogs'
import { adminClientAnalyticsRouter } from './client-analytics'
import { adminClientManagementRouter } from './client-management'
import { adminClientSearchRouter } from './client-search'
import { adminClientReadsRouter } from './client-reads'
import { adminCostBudgetRouter } from './cost-budget'
import { adminDigestRouter } from './digest'
import { adminDeploymentManifestReviewRouter } from './deployment-manifest-review'
import { adminEvaluationOperationsRouter } from './evaluation-operations'
import { adminExternalCredentialsRouter } from './external-credentials'
import { adminFreshnessAuditRouter } from './freshness-audit'
import { adminOverviewRouter } from './overview'
import { adminOffboardingPlansRouter } from './offboarding-plans'
import { adminOffboardingExportPreviewRouter } from './offboarding-export-preview'
import { adminIncidentControlRouter } from './incident-control'
import { adminIntakeOperationsRouter } from './intake-operations'
import { adminReportConfigurationRouter } from './report-configuration'
import { adminSupportOperationsRouter } from './support-operations'
import { adminUniversalContentRouter } from './universal-content'
import { adminWeeklyReportsRouter } from './weekly-reports'
import { adminWeeklyReportLifecycleRouter } from './weekly-report-lifecycle'
import { adminVenueAvailabilityRouter } from './venue-availability'

export const adminRouter = mergeRouters(
  adminOverviewRouter,
  adminOffboardingPlansRouter,
  adminOffboardingExportPreviewRouter,
  adminAgentOperationsRouter,
  adminAgentApprovalDecisionsRouter,
  adminIncidentControlRouter,
  adminIntakeOperationsRouter,
  adminCostBudgetRouter,
  adminEvaluationOperationsRouter,
  adminExternalCredentialsRouter,
  adminFreshnessAuditRouter,
  adminSupportOperationsRouter,
  adminUniversalContentRouter,
  adminClientReadsRouter,
  adminClientAnalyticsRouter,
  adminClientManagementRouter,
  adminClientSearchRouter,
  adminChatlogsRouter,
  adminAnswerAnalysisRouter,
  adminAiWorkloadConfigurationRouter,
  adminReportConfigurationRouter,
  adminVenueAvailabilityRouter,
  adminWeeklyReportsRouter,
  adminWeeklyReportLifecycleRouter,
  adminDigestRouter,
  adminDeploymentManifestReviewRouter,
)
