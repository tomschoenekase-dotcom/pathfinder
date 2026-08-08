export const TENANTED_TABLES = [
  'TenantMembership',
  'TenantFeatureFlag',
  'Venue',
  'Place',
  'VenueKnowledgeEntry',
  'VenueContentImportReceipt',
  'VisitorSession',
  'AiUsageEvent',
  'AiUsageDailyRollup',
  'Message',
  'DataAdapter',
  'OperationalUpdate',
  'AnalyticsEvent',
  'DailyRollup',
  'WeeklyDigest',
  'QuestionCluster',
  'EngagementQuestion',
  'EngagementQuestionResponse',
  'AdminChatlogNote',
  'WeeklyReport',
  'AnswerAnalysisSnapshot',
  'GenerationRequestDispatch',
  'VenueWeeklyTheme',
  'MediaIngestionProject',
  'MediaIngestionAsset',
  'EmbeddingWorkClaim',
  'EmbeddingDispatch',
] as const

export const PLATFORM_TABLES = ['User', 'Tenant', 'PlatformConfig', 'ClerkWebhookReceipt'] as const

// Models in this list deliberately support both tenant-attributed and
// platform-wide rows. They must remain explicit because neither silently
// treating them as platform tables nor forcing tenant scope is correct.
export const SHARED_SCOPE_TABLES = ['AuditLog', 'JobRecord'] as const

export type TenantedTable = (typeof TENANTED_TABLES)[number]
export type PlatformTable = (typeof PLATFORM_TABLES)[number]
export type SharedScopeTable = (typeof SHARED_SCOPE_TABLES)[number]
