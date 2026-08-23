export const dynamic = 'force-dynamic'

import { VenueLocationAuthoring } from '../../../../../../../../components/admin/VenueLocationAuthoring'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type Props = { params: Promise<{ tenantId: string; venueId: string }> }

export default async function VenueLocationsPage({ params }: Props) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()
  try {
    const workspace = await caller.admin.getVenueLocationAuthoring({ tenantId, venueId })
    return (
      <VenueLocationAuthoring
        tenantId={tenantId}
        venueId={venueId}
        venueName={workspace.venue.name}
        floors={workspace.floors}
        initialLocations={workspace.locations}
        connectionCount={workspace.connections.length}
        proposals={workspace.proposals}
      />
    )
  } catch {
    return (
      <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
        <h2 className="text-2xl font-semibold text-pf-deep">
          Location authoring could not be loaded
        </h2>
        <p className="mt-2 text-sm text-pf-deep/75">
          No anchor was changed. Confirm the exact client and venue scope, then retry.
        </p>
      </section>
    )
  }
}
