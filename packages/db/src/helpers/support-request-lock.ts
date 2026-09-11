import type { db } from '../client'

type TransactionClient = Parameters<Parameters<typeof db.$transaction>[0]>[0]

/** Shared first lock for support request mutations and completion evidence reads. */
export async function lockSupportRequest(
  tx: Pick<TransactionClient, '$executeRaw'>,
  tenantId: string,
  requestId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:support-request:${tenantId}:${requestId}`}, 0))`
}
