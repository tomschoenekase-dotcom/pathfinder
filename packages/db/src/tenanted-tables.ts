export const TENANTED_TABLES = [
  'TenantMembership',
  'TenantFeatureFlag',
  'Venue',
  'Place',
  'VenueKnowledgeEntry',
  'VisitorSession',
  'Message',
  'DataAdapter',
  'OperationalUpdate',
  'AnalyticsEvent',
  'DailyRollup',
  'WeeklyDigest',
  'QuestionCluster',
  'EngagementQuestion',
] as const

export const PLATFORM_TABLES = ['User', 'Tenant', 'AuditLog', 'PlatformConfig'] as const

export type TenantedTable = (typeof TENANTED_TABLES)[number]
export type PlatformTable = (typeof PLATFORM_TABLES)[number]
