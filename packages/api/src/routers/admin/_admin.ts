import { mergeRouters } from '../../core'

import { adminAnswerAnalysisRouter } from './answer-analysis'
import { adminChatlogsRouter } from './chatlogs'
import { adminClientAnalyticsRouter } from './client-analytics'
import { adminClientManagementRouter } from './client-management'
import { adminClientReadsRouter } from './client-reads'
import { adminDigestRouter } from './digest'
import { adminOverviewRouter } from './overview'
import { adminReportConfigurationRouter } from './report-configuration'
import { adminWeeklyReportsRouter } from './weekly-reports'

export const adminRouter = mergeRouters(
  adminOverviewRouter,
  adminClientReadsRouter,
  adminClientAnalyticsRouter,
  adminClientManagementRouter,
  adminChatlogsRouter,
  adminAnswerAnalysisRouter,
  adminReportConfigurationRouter,
  adminWeeklyReportsRouter,
  adminDigestRouter,
)
