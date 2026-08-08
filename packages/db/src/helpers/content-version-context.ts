// Prisma's extended transaction client has an intentionally structural runtime
// shape that is not assignable to its generated TransactionClient type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContentVersionTransaction = any

export type ContentVersionEntityType = 'VENUE' | 'PLACE' | 'KNOWLEDGE_ENTRY' | 'OPERATIONAL_UPDATE'

export type ContentVersionPackageAction = 'APPLY' | 'REVERT'

export type ContentVersionSourceProvenance = {
  sourceType: string
  sourceName?: string
  sourceUrl?: string
  contentOrigin: 'HUMAN_AUTHORED' | 'AI_GENERATED'
  importedAt: string
  humanConfirmedAt: string
  lastReviewedAt: string
}

export type ContentVersionPackageContext = {
  venuePackageId: string
  itemKey: string
  action: ContentVersionPackageAction
  sourceProvenance: ContentVersionSourceProvenance
}

function assertIsoTimestamp(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new Error(`${field} must be an ISO UTC timestamp`)
  }
}

function validatePackageContext(input: ContentVersionPackageContext): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.itemKey,
    )
  ) {
    throw new Error('Content-version package item key must be a UUID')
  }
  const provenance = input.sourceProvenance
  if (provenance.sourceType.trim().length === 0 || provenance.sourceType.length > 64) {
    throw new Error('Content-version source type must contain 1 to 64 characters')
  }
  if (provenance.sourceName !== undefined && provenance.sourceName.length > 200) {
    throw new Error('Content-version source name cannot exceed 200 characters')
  }
  if (provenance.sourceUrl !== undefined) {
    if (provenance.sourceUrl.length > 2_000) {
      throw new Error('Content-version source URL cannot exceed 2000 characters')
    }
    const url = new URL(provenance.sourceUrl)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.includes('%') ||
      url.hash.includes('%') ||
      [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some((key) =>
        /(?:token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-)/iu.test(
          key,
        ),
      )
    ) {
      throw new Error('Content-version source URL must use HTTP(S) and contain no credentials')
    }
  }
  assertIsoTimestamp(provenance.importedAt, 'importedAt')
  assertIsoTimestamp(provenance.humanConfirmedAt, 'humanConfirmedAt')
  assertIsoTimestamp(provenance.lastReviewedAt, 'lastReviewedAt')
}

export async function setContentVersionContext(
  tx: ContentVersionTransaction,
  input: {
    actorId: string
    revertedFromId?: string
    venuePackage?: ContentVersionPackageContext
  },
): Promise<void> {
  if (input.venuePackage) validatePackageContext(input.venuePackage)
  await tx.$executeRaw`SELECT set_config('pathfinder.actor_id', ${input.actorId}, true)`
  await tx.$executeRaw`SELECT set_config(
    'pathfinder.reverted_from_id',
    ${input.revertedFromId ?? ''},
    true
  )`
  await tx.$executeRaw`SELECT set_config(
    'pathfinder.venue_package_id',
    ${input.venuePackage?.venuePackageId ?? ''},
    true
  )`
  await tx.$executeRaw`SELECT set_config(
    'pathfinder.venue_package_item_key',
    ${input.venuePackage?.itemKey ?? ''},
    true
  )`
  await tx.$executeRaw`SELECT set_config(
    'pathfinder.venue_package_action',
    ${input.venuePackage?.action ?? ''},
    true
  )`
  await tx.$executeRaw`SELECT set_config(
    'pathfinder.source_provenance',
    ${input.venuePackage ? JSON.stringify(input.venuePackage.sourceProvenance) : ''},
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
