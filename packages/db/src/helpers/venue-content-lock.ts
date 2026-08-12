// Extended and interactive clients share this structural raw-SQL surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TransactionClient = any

/** Serializes authoritative place/knowledge mutations for one tenant venue. */
export async function lockVenueContentMutation(
  tx: TransactionClient,
  scope: { tenantId: string; venueId: string },
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext('pathfinder:venue-content:' || ${scope.tenantId}),
      hashtext(${scope.venueId})
    )
  `
}

/** Serializes report configuration changes with new report requests. */
export async function lockVenueReportMutation(
  tx: TransactionClient,
  input: { tenantId: string; venueId: string },
): Promise<void> {
  const lockKey = `venue-report:${input.tenantId}:${input.venueId}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
}

/** Serializes one public guest session/turn lifecycle without exposing its bearer token. */
export async function lockGuestChatTurnMutation(
  tx: TransactionClient,
  input: { tenantId: string; lockId: string },
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext('pathfinder:guest-chat:' || ${input.tenantId}),
      hashtext(${input.lockId})
    )
  `
}
