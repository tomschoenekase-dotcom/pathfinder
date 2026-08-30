import { createHash } from 'node:crypto'

import { canonicalVenuePackagePayload, type VenuePackagePayload } from '../schemas/venue-package'

/** Authoritative stored VenuePackage payload identity. The canonical payload is a
 * string value, so hashing preserves the established JSON-value envelope used by
 * package creation and lifecycle validation. */
export function venuePackagePayloadHash(venueId: string, payload: VenuePackagePayload): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalVenuePackagePayload(venueId, payload)))
    .digest('hex')
}
