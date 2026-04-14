export const TENANTED_TABLES = [
  'TenantMembership',
  'TenantFeatureFlag',
  'Venue',
  'Place',
  'VisitorSession',
  'Message',
  'DataAdapter',
  'OperationalUpdate',
  'AnalyticsEvent',
  'GuestSession',
  'DailyRollup',
  'WeeklyDigest',
] as const

export const PLATFORM_TABLES = ['User', 'Tenant', 'AuditLog', 'PlatformConfig'] as const

export type TenantedTable = (typeof TENANTED_TABLES)[number]
export type PlatformTable = (typeof PLATFORM_TABLES)[number]
