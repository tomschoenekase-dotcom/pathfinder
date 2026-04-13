import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'

import { appRouter, createTRPCContext } from '@pathfinder/api'

import { PlaceRow } from '../../../../components/PlaceRow'

type VenueDetailPageProps = {
  params: Promise<{
    venueId: string
  }>
}

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/venues/detail'),
  })

  return appRouter.createCaller(ctx)
}

export default async function VenueDetailPage({ params }: VenueDetailPageProps) {
  const { venueId } = await params
  const caller = await createCaller()

  try {
    const [venue, places] = await Promise.all([
      caller.venue.getById({ id: venueId }),
      caller.place.list({ venueId }),
    ])

    return (
      <main className="min-h-screen bg-slate-50 px-6 py-10">
        <div className="mx-auto max-w-6xl space-y-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-3">
              <Link href="/venues" className="text-sm font-medium text-cyan-700 hover:text-cyan-800">
                Back to venues
              </Link>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700">
                  {venue.category ?? 'Venue'}
                </p>
                <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-900">
                  {venue.name}
                </h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
                  {venue.description ?? 'No description added yet.'}
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <Link
                href={`/venues/${venue.id}/edit`}
                className="inline-flex min-h-11 items-center rounded-full border border-slate-300 bg-white px-5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Edit venue
              </Link>
              <Link
                href={`/venues/${venue.id}/places/new`}
                className="inline-flex min-h-11 items-center rounded-full bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                Add place
              </Link>
            </div>
          </div>

          <section className="grid gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Places</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{venue._count.places}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Latitude</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">
                {venue.defaultCenterLat ?? 'Not set'}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Longitude</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">
                {venue.defaultCenterLng ?? 'Not set'}
              </p>
            </div>
          </section>

          <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-6 py-4">
              <h2 className="text-xl font-semibold text-slate-900">Places</h2>
            </div>

            {places.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <p className="text-lg font-medium text-slate-900">No places yet</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Add POIs, amenities, and landmarks so the public chat can answer venue questions.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">Name</th>
                      <th className="px-4 py-3 font-medium">Type</th>
                      <th className="px-4 py-3 font-medium">Area</th>
                      <th className="px-4 py-3 font-medium">Distance</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {places.map((place) => (
                      <PlaceRow key={place.id} place={place} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </main>
    )
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') {
      notFound()
    }

    throw error
  }
}
