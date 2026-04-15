import Link from 'next/link'

import { appRouter, createTRPCContext } from '@pathfinder/api'

import { AiControlsForm } from '../../../components/AiControlsForm'

type AiControlsPageProps = {
  searchParams: Promise<{
    venue?: string | string[]
  }>
}

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/ai-controls'),
  })

  return appRouter.createCaller(ctx)
}

export default async function AiControlsPage({ searchParams }: AiControlsPageProps) {
  const { venue: requestedVenue } = await searchParams
  const caller = await createCaller()
  const venues = await caller.venue.list()

  if (venues.length === 0) {
    return (
      <main className="min-h-screen bg-slate-50 px-6 py-10 lg:px-10">
        <div className="mx-auto max-w-6xl space-y-8">
          <section className="rounded-[2rem] bg-slate-950 px-8 py-10 text-white shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300">
              AI Controls
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight">Venue AI configuration</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
              Control how your venue&apos;s AI assistant behaves for guests.
            </p>
          </section>

          <section className="rounded-[2rem] border border-dashed border-slate-300 bg-white p-10 text-center shadow-sm">
            <h2 className="text-2xl font-semibold text-slate-900">
              You need to create a venue before configuring AI controls.
            </h2>
            <Link
              href="/venues/new"
              className="mt-6 inline-flex min-h-11 items-center rounded-full border border-slate-300 px-5 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
            >
              Create a venue
            </Link>
          </section>
        </div>
      </main>
    )
  }

  const venueQuery = Array.isArray(requestedVenue) ? requestedVenue[0] : requestedVenue
  const initialVenueId = venues.some((venue) => venue.id === venueQuery)
    ? venueQuery!
    : venues[0]!.id
  const [initialConfig, initialPlaces] = await Promise.all([
    caller.venue.getAiConfig({ venueId: initialVenueId }),
    caller.place.list({ venueId: initialVenueId }),
  ])

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <section className="rounded-[2rem] bg-slate-950 px-8 py-10 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300">
            AI Controls
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight">Venue AI configuration</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
            Shape how your venue&apos;s AI assistant responds to guests, what it promotes, and how
            it should sound.
          </p>
        </section>

        <AiControlsForm
          venues={venues.map((venue) => ({ id: venue.id, name: venue.name }))}
          initialVenueId={initialVenueId}
          initialConfig={initialConfig}
          initialPlaces={initialPlaces.map((place) => ({ id: place.id, name: place.name }))}
        />
      </div>
    </main>
  )
}
