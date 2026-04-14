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
