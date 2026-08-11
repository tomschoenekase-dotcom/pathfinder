import { mergeRouters } from '../../core'

import { adminAnswerAnalysisRouter } from './answer-analysis'
import { adminAgentOperationsRouter } from './agent-operations'
import { adminAgentApprovalDecisionsRouter } from './agent-approval-decisions'
import { adminChatlogsRouter } from './chatlogs'
import { adminClientAnalyticsRouter } from './client-analytics'
import { adminClientManagementRouter } from './client-management'
import { adminClientSearchRouter } from './client-search'
import { adminClientReadsRouter } from './client-reads'
import { adminCostBudgetRouter } from './cost-budget'
import { adminDigestRouter } from './digest'
import { adminEvaluationOperationsRouter } from './evaluation-operations'
import { adminFreshnessAuditRouter } from './freshness-audit'
import { adminOverviewRouter } from './overview'
import { adminOffboardingPlansRouter } from './offboarding-plans'
import { adminIncidentControlRouter } from './incident-control'
import { adminReportConfigurationRouter } from './report-configuration'
import { adminSupportOperationsRouter } from './support-operations'
import { adminUniversalContentRouter } from './universal-content'
import { adminWeeklyReportsRouter } from './weekly-reports'
import { adminVenueAvailabilityRouter } from './venue-availability'

export const adminRouter = mergeRouters(
  adminOverviewRouter,
  adminOffboardingPlansRouter,
  adminAgentOperationsRouter,
  adminAgentApprovalDecisionsRouter,
  adminIncidentControlRouter,
  adminCostBudgetRouter,
  adminEvaluationOperationsRouter,
  adminFreshnessAuditRouter,
  adminSupportOperationsRouter,
  adminUniversalContentRouter,
  adminClientReadsRouter,
  adminClientAnalyticsRouter,
  adminClientManagementRouter,
  adminClientSearchRouter,
  adminChatlogsRouter,
  adminAnswerAnalysisRouter,
  adminReportConfigurationRouter,
  adminVenueAvailabilityRouter,
  adminWeeklyReportsRouter,
  adminDigestRouter,
)
