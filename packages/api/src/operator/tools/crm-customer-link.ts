import { grantCoversTenant } from '../grants'
import type { VerifiedOperatorGrant } from '../oauth'

type Legacy = { tenantId: string; venueId: string | null; convertedAt: Date }
type Relationship = {
  tenantId: string
  startedAt: Date
  locationConversions: Array<{
    tenantId: string
    venueId: string
    venue: { tenantId: string }
  }>
}

/** Canonical links win; ambiguous or out-of-grant identities remain redacted. */
export function projectCustomerLink(
  legacy: Legacy | null,
  relationships: Relationship[],
  grant: VerifiedOperatorGrant,
) {
  if (relationships.length === 0) {
    if (!legacy) return null
    const covered = grantCoversTenant(grant, legacy.tenantId)
    return {
      tenantId: covered ? legacy.tenantId : null,
      venueId: covered ? legacy.venueId : null,
      convertedAt: legacy.convertedAt.toISOString(),
    }
  }
  const relationship = relationships[0]!
  const covered = relationships.length === 1 && grantCoversTenant(grant, relationship.tenantId)
  const location =
    relationship.locationConversions.length === 1 ? relationship.locationConversions[0] : undefined
  const validLocation =
    location?.tenantId === relationship.tenantId &&
    location.venue.tenantId === relationship.tenantId
  return {
    tenantId: covered ? relationship.tenantId : null,
    venueId: covered && validLocation ? location!.venueId : null,
    convertedAt: relationship.startedAt.toISOString(),
  }
}
