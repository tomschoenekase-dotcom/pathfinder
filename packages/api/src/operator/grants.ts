import type { McpCapability, VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import type { OperatorCapability } from '@pathfinder/contracts/operator-mcp'

import type { OperatorDatabase } from './audit'
import type { VerifiedOperatorGrant } from './oauth'

/** Every out-of-scope or missing target looks the same, so scope checks never leak existence. */
export class OperatorNotFoundError extends Error {
  readonly code = 'NOT_FOUND'
  constructor() {
    super('Not found')
  }
}

/** A tenant has more venues than one read scope can carry; refusing is safer than a silent subset. */
export class OperatorScopeTooLargeError extends Error {
  readonly code = 'SCOPE_TOO_LARGE'
  constructor() {
    super('Tenant has more venues than a single read scope supports')
  }
}

export const OPERATOR_READ_SCOPE_VENUE_LIMIT = 500

export class OperatorCapabilityError extends Error {
  readonly code = 'CAPABILITY_DENIED'
  constructor() {
    super('Capability not granted')
  }
}

export function assertGrantCapability(
  grant: VerifiedOperatorGrant,
  capability: OperatorCapability,
): void {
  if (!grant.capabilities.includes(capability)) throw new OperatorCapabilityError()
}

export function grantCoversTenant(grant: VerifiedOperatorGrant, tenantId: string): boolean {
  return grant.allTenants || grant.tenantIds.includes(tenantId)
}

/** The tenant must be inside the grant and exist; otherwise the caller sees NOT_FOUND. */
export async function assertTenantInGrant(
  grant: VerifiedOperatorGrant,
  tenantId: string,
  database: OperatorDatabase,
): Promise<void> {
  if (!grantCoversTenant(grant, tenantId)) throw new OperatorNotFoundError()
  const tenant = await database.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })
  if (!tenant) throw new OperatorNotFoundError()
}

export async function assertVenueInGrant(
  grant: VerifiedOperatorGrant,
  tenantId: string,
  venueId: string,
  database: OperatorDatabase,
): Promise<void> {
  await assertTenantInGrant(grant, tenantId, database)
  const venue = await database.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true },
  })
  if (!venue) throw new OperatorNotFoundError()
}

/**
 * A read-only credential scope built per call from the consented grant, so existing read services
 * enforce their own tenant and venue checks. `credentialId` is the grant ID; it carries no write
 * capability and is never persisted as an external credential.
 */
export async function buildOperatorReadScope(
  grant: VerifiedOperatorGrant,
  tenantId: string,
  capabilities: readonly McpCapability[],
  database: OperatorDatabase,
): Promise<VerifiedMcpCredentialScope> {
  await assertTenantInGrant(grant, tenantId, database)
  if (capabilities.some((capability) => !capability.endsWith(':read'))) {
    throw new Error('Operator read scopes carry read capabilities only')
  }
  const venues = await database.venue.findMany({
    where: { tenantId },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: OPERATOR_READ_SCOPE_VENUE_LIMIT + 1,
  })
  if (venues.length > OPERATOR_READ_SCOPE_VENUE_LIMIT) throw new OperatorScopeTooLargeError()
  return {
    credentialId: grant.grantId,
    tenantId,
    clientId: tenantId,
    venueIds: venues.map((venue) => venue.id),
    capabilities: [...new Set(capabilities)],
  }
}
