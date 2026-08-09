import { mergeRouters } from '../../core'

import { adminAnswerAnalysisRouter } from './answer-analysis'
import { adminChatlogsRouter } from './chatlogs'
import { adminClientAnalyticsRouter } from './client-analytics'
import { adminClientManagementRouter } from './client-management'
import { adminClientReadsRouter } from './client-reads'
import { adminCostBudgetRouter } from './cost-budget'
import { adminDigestRouter } from './digest'
import { adminOverviewRouter } from './overview'
import { adminIncidentControlRouter } from './incident-control'
import { adminReportConfigurationRouter } from './report-configuration'
import { adminWeeklyReportsRouter } from './weekly-reports'
import { adminVenueAvailabilityRouter } from './venue-availability'

export const adminRouter = mergeRouters(
  adminOverviewRouter,
  adminIncidentControlRouter,
  adminCostBudgetRouter,
  adminClientReadsRouter,
  adminClientAnalyticsRouter,
  adminClientManagementRouter,
  adminChatlogsRouter,
  adminAnswerAnalysisRouter,
  adminReportConfigurationRouter,
  adminVenueAvailabilityRouter,
  adminWeeklyReportsRouter,
  adminDigestRouter,
)
