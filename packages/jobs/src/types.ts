export type WeeklyDigestJobPayload = {
  tenantId: string
  weekStart: string
  weekEnd: string
  digestId: string
}

export type DailyRollupJobPayload = {
  tenantId: string
  date: string
}

export type EmbedPlaceJobPayload = {
  placeId: string
  tenantId: string
}

export type AnalyticsEnrichmentJobPayload = {
  tenantId: string
  // UTC day to enrich (topic tagging, place interest, unique visitors). Clusters
  // run over a rolling window ending on this day.
  date: string
}
