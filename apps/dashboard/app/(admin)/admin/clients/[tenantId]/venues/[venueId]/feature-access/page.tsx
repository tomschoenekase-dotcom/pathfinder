export const dynamic = 'force-dynamic'

import { VenueFeatureAccessControl } from '../../../../../../../../components/admin/VenueFeatureAccessControl'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type Props = { params: Promise<{ tenantId: string; venueId: string }> }

export default async function VenueFeatureAccessPage({ params }: Props) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()

  try {
    const [venue, entitlements] = await Promise.all([
      caller.admin.getClientVenue({ tenantId, venueId }),
      caller.admin.listProductEntitlements({ tenantId, venueId }),
    ])
    return (
      <VenueFeatureAccessControl
        tenantId={tenantId}
        venueId={venueId}
        venueName={venue.venue.name}
        entitlements={entitlements}
      />
    )
  } catch {
    return (
      <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
        <h2 className="text-2xl font-semibold text-pf-deep">Feature access could not be loaded</h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/75">
          No entitlement, billing record, or provider setting was changed. Confirm the exact venue
          scope, then retry.
        </p>
      </section>
    )
  }
}
