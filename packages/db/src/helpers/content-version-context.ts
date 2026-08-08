// Prisma's extended transaction client has an intentionally structural runtime
// shape that is not assignable to its generated TransactionClient type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContentVersionTransaction = any

export type ContentVersionEntityType = 'VENUE' | 'PLACE' | 'KNOWLEDGE_ENTRY' | 'OPERATIONAL_UPDATE'

export async function setContentVersionContext(
  tx: ContentVersionTransaction,
  input: { actorId: string; revertedFromId?: string },
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('pathfinder.actor_id', ${input.actorId}, true)`
  await tx.$executeRaw`SELECT set_config(
    'pathfinder.reverted_from_id',
    ${input.revertedFromId ?? ''},
    true
  )`
}

async function lockAdvisoryKey(tx: ContentVersionTransaction, lockKey: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
}

export async function lockContentVersionEntity(
  tx: ContentVersionTransaction,
  input: { tenantId: string; entityType: ContentVersionEntityType; entityId: string },
): Promise<void> {
  const lockKey = `${input.tenantId}:${input.entityType}:${input.entityId}`
  await lockAdvisoryKey(tx, lockKey)

  if (input.entityType === 'VENUE') {
    await tx.$queryRaw`SELECT id FROM venues
      WHERE tenant_id = ${input.tenantId} AND id = ${input.entityId}
      FOR UPDATE`
  } else if (input.entityType === 'PLACE') {
    await tx.$queryRaw`SELECT id FROM places
      WHERE tenant_id = ${input.tenantId} AND id = ${input.entityId}
      FOR UPDATE`
  } else if (input.entityType === 'KNOWLEDGE_ENTRY') {
    await tx.$queryRaw`SELECT id FROM venue_knowledge_entries
      WHERE tenant_id = ${input.tenantId} AND id = ${input.entityId}
      FOR UPDATE`
  } else {
    await tx.$queryRaw`SELECT id FROM operational_updates
      WHERE tenant_id = ${input.tenantId} AND id = ${input.entityId}
      FOR UPDATE`
  }
}

export async function lockOperationalUpdateCapacity(
  tx: ContentVersionTransaction,
  input: { tenantId: string; venueId: string },
): Promise<void> {
  const lockKey = `operational-update-capacity:${input.tenantId}:${input.venueId}`
  await lockAdvisoryKey(tx, lockKey)
}
