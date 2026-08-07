export { db } from './client'
export { withTenantIsolationBypass } from './middleware/tenant-isolation'
export { writeAuditLog } from './helpers/audit'
export { writeJobRecord, updateJobRecord } from './helpers/job-records'
export type { WriteJobRecordParams } from './helpers/job-records'
export { featureEnabled } from './helpers/feature-flags'
export { handleClerkEvent, mapClerkRoleToTenantRole } from './helpers/membership-sync'
export type { ClerkWebhookEvent } from './helpers/membership-sync'
export {
  searchKnowledgeByEmbedding,
  searchPlacesByEmbedding,
  storeKnowledgeEntryEmbeddingForScope,
  storePlaceEmbeddingForScope,
} from './helpers/semantic-search'
export type { SemanticKnowledgeEntry, SemanticPlace } from './helpers/semantic-search'
export { buildKnowledgeEntryText, buildPlaceText } from './helpers/content-text'

export type {
  AnalyticsEvent,
  JobRecord,
  JobStatus,
  AuditLog,
  DataAdapter,
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
