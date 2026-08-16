export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { MediaIngestionWorkbench } from '../../../../../../../../components/admin/MediaIngestionWorkbench'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

export default async function AdminVenueMediaPage({
  params,
}: {
  params: Promise<{ tenantId: string; venueId: string }>
}) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()
  const [venueData, projects] = await Promise.all([
    caller.admin.getClientVenue({ tenantId, venueId }),
    caller.mediaIngestion.list({ tenantId, venueId }),
  ])

  return (
    <div className="space-y-8">
      <Link
        href={`/admin/clients/${tenantId}/venues/${venueId}`}
        className="text-sm font-medium text-pf-primary hover:text-pf-accent"
      >
        ← Back to {venueData.venue.name}
      </Link>
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
          Venue media lab
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-pf-deep">
          Build the guide from a visit
        </h1>
        <p className="max-w-3xl text-sm leading-6 text-pf-deep/60">
          Upload once, preserve the evidence trail, answer only the questions that matter, and
          review import-ready Torchico JSON before anything reaches the venue.
        </p>
      </header>
      <MediaIngestionWorkbench
        tenantId={tenantId}
        venueId={venueId}
        venueName={venueData.venue.name}
        initialProjects={projects}
      />
    </div>
  )
}
