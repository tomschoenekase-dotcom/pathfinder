import { ProspectDetailView } from '../../../../../components/admin/ProspectDetailView'
import { createAdminCaller } from '../../../../../lib/admin-caller'
import Link from 'next/link'
import { AuthenticatedProspectGeographyPanel } from '../../../../../components/admin/ProspectGeographyReviewPanel'

export const dynamic = 'force-dynamic'

export default async function ProspectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ prospectId: string }>
  searchParams: Promise<{ directoryQuery?: string; venue?: string }>
}) {
  const { prospectId } = await params
  const { directoryQuery, venue: requestedVenue } = await searchParams
  const caller = await createAdminCaller()
  const [prospect, intelligence] = await Promise.all([
    caller.admin.getProspect({ organizationId: prospectId }),
    caller.admin.getProspectIntelligence({ organizationId: prospectId }),
  ])
  const selectedVenue = requestedVenue
    ? prospect.venues.find((venue) => venue.id === requestedVenue)
    : prospect.venues.find((venue) => !venue.archivedAt)
  return (
    <>
      <ProspectDetailView
        prospect={prospect}
        intelligence={intelligence}
        directoryQuery={directoryQuery}
      />
      <section
        id="physical-geography"
        className="mt-8 min-w-0 scroll-mt-6"
        aria-label="Native location geography"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-xl font-semibold">Physical locations and research ownership</h2>
          <Link
            href="/admin/prospects/territories"
            className="inline-flex min-h-11 items-center text-sm text-emerald-800 underline"
          >
            Open research territories
          </Link>
        </div>
        <nav aria-label="Select a native location" className="mt-3 flex flex-wrap gap-3">
          {prospect.venues.map((venue) => (
            <Link
              key={venue.id}
              aria-current={venue.id === selectedVenue?.id ? 'page' : undefined}
              href={`?${new URLSearchParams({ venue: venue.id, ...(directoryQuery ? { directoryQuery } : {}) })}#physical-geography`}
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-3 text-sm text-emerald-800 underline focus-visible:outline focus-visible:outline-2"
            >
              {venue.name}
              {venue.archivedAt ? ' (archived)' : ''}
            </Link>
          ))}
        </nav>
        {selectedVenue ? (
          <AuthenticatedProspectGeographyPanel key={selectedVenue.id} venueId={selectedVenue.id} />
        ) : (
          <p className="mt-4 text-sm">
            {requestedVenue
              ? 'That location does not belong to this prospect. Select one of its native locations above.'
              : 'No active native location is available for geography review.'}
          </p>
        )}
      </section>
    </>
  )
}
