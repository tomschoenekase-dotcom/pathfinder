import { buildGmailBodyRetentionDryRun } from '@pathfinder/contracts/google-workspace-source'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

type EmailBodyRetentionClient = Pick<typeof db, 'prospectEmailMessage'>

/**
 * Produces a bounded, read-only inventory. It neither removes bodies nor changes retention state;
 * any executor remains blocked on a separately approved policy and rollout.
 */
export async function inspectGmailBodyRetentionDryRun(
  input: { now?: Date; limit?: number } = {},
  client: EmailBodyRetentionClient = db,
) {
  const now = input.now ?? new Date()
  const limit = Math.max(1, Math.min(input.limit ?? 10_000, 100_000))
  const rows = await withTenantIsolationBypass(() =>
    client.prospectEmailMessage.findMany({
      where: { providerAccount: { provider: 'GMAIL' } },
      orderBy: { id: 'asc' },
      take: limit,
      select: {
        id: true,
        bodyRetentionState: true,
        textBody: true,
        htmlBody: true,
        bodyExpiresAt: true,
      },
    }),
  )
  return {
    generatedAt: now.toISOString(),
    limit,
    ...buildGmailBodyRetentionDryRun(
      rows.map((row) => ({
        id: row.id,
        state: row.bodyRetentionState,
        hasTextBody: row.textBody !== null,
        hasHtmlBody: row.htmlBody !== null,
        expiresAt: row.bodyExpiresAt,
      })),
      now,
    ),
  }
}
