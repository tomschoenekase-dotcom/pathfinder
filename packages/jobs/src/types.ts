export type WeeklyDigestJobPayload = {
  tenantId: string
  weekStart: string
  weekEnd: string
  digestId: string
}

export type AnswerAnalysisJobPayload = {
  tenantId: string
  venueId: string
  rangeStart: string
  rangeEnd: string
  snapshotId: string
}

export type AnswerAnalysisRecoveryJobPayload = AnswerAnalysisJobPayload & {
  observedLeaseToken: string
}

export type WeeklyReportJobPayload = {
  tenantId: string
  venueId: string
  weekStart: string
  weekEnd: string
  reportId: string
}

export type WeeklyReportRecoveryJobPayload = WeeklyReportJobPayload & {
  observedLeaseToken: string
}

export type GenerationDispatchKickJobPayload = {
  dispatchId: string
}

export type DailyRollupJobPayload = {
  tenantId: string
  date: string
}

export type EmbedPlaceJobPayload = {
  placeId: string
  tenantId: string
  contentUpdatedAt: string
}

export type EmbedKnowledgeEntryJobPayload = {
  entryId: string
  tenantId: string
  contentUpdatedAt: string
}

export type AnalyticsEnrichmentJobPayload = {
  tenantId: string
  // UTC day to enrich (topic tagging, place interest, unique visitors). Clusters
  // run over a rolling window ending on this day.
  date: string
}

export type SendWelcomeEmailJobPayload = {
  tenantId: string
  deliveryId: string
  to: string
  recipientName: string | null
  orgName: string
}

/** Carries only durable identity. The worker reloads the frozen approved snapshot. */
export type SendProspectOutreachJobPayload = {
  sendItemId: string
}

export type OperationalEventDeliveryJobPayload = Record<string, never>

export type MediaIngestionJobPayload = {
  tenantId: string
  venueId: string
  projectId: string
  uploadAttemptId: string
}

/** Carries only the immutable run identity. The worker reloads and verifies the
 * frozen manifest rather than accepting cases or prompts through Redis. */
export type EvaluationRunJobPayload = {
  tenantId: string
  venueId: string
  runId: string
  runIdentityHash: string
}

/** Carries only durable identity. Prompts, scopes, and model policy are always
 * reloaded from Postgres by the worker and are never trusted from Redis. */
export type AgentRunJobPayload = {
  tenantId: string
  runId: string
}
