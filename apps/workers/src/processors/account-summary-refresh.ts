import { db, refreshAccountSummaryAction, withTenantIsolationBypass } from '@pathfinder/db'

const DEFAULT_BATCH_SIZE = 50

/**
 * Refreshes only durable summaries already marked STALE. A failed refresh leaves
 * the row STALE, so BullMQ retry or the next scheduled scan can recover without
 * losing work. The canonical action's input digest makes replays idempotent.
 */
export async function processStaleAccountSummaries(input?: {
  systemJobId?: string
  batchSize?: number
}) {
  const batchSize = Math.min(Math.max(input?.batchSize ?? DEFAULT_BATCH_SIZE, 1), 100)
  const stale = await withTenantIsolationBypass(() =>
    db.accountSummary.findMany({
      where: { status: 'STALE', tenantId: { not: null } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      distinct: ['tenantId', 'organizationId'],
      take: batchSize,
      select: { tenantId: true, organizationId: true },
    }),
  )
  const systemJobId = input?.systemJobId ?? 'account-summary-refresh-scheduled'
  let refreshed = 0
  for (const summary of stale) {
    // Prisma does not narrow nullable selected fields from a `not: null` filter.
    // Skip defensively if malformed legacy data ever violates the query contract.
    if (!summary.tenantId) continue
    await refreshAccountSummaryAction({
      clientId: summary.tenantId,
      organizationId: summary.organizationId,
      actor: {
        type: 'SYSTEM',
        actorId: 'account-summary-refresh-worker',
        role: 'SYSTEM',
        systemJobId,
      },
    })
    refreshed += 1
  }
  return { scanned: stale.length, refreshed }
}
