import Link from 'next/link'

import { appRouter, createTRPCContext } from '@pathfinder/api'

import { VenueCard } from '../../../components/VenueCard'

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/venues'),
  })

  return appRouter.createCaller(ctx)
}

export default async function VenuesPage() {
  const caller = await createCaller()
  const venues = await caller.venue.list()
  const venuesWithCounts = venues.map((venue) => ({
    ...venue,
    placeCount: venue._count.places,
  }))

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700">
              Dashboard
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-900">Venues</h1>
            <p className="max-w-2xl text-sm leading-6 text-slate-600">
              Manage the venue records and place data that power the public chat experience.
            </p>
          </div>
          <Link
            href="/venues/new"
            className="inline-flex min-h-11 items-center rounded-full bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            New venue
          </Link>
        </div>

        {venuesWithCounts.length === 0 ? (
          <section className="rounded-3xl border border-dashed border-slate-300 bg-white p-10 text-center shadow-sm">
            <h2 className="text-2xl font-semibold text-slate-900">No venues yet</h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Create your first one to start loading places for the chatbot.
            </p>
            <Link
              href="/venues/new"
              className="mt-6 inline-flex min-h-11 items-center rounded-full border border-slate-300 px-5 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
            >
              Create your first venue
            </Link>
          </section>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {venuesWithCounts.map((venue: (typeof venuesWithCounts)[number]) => (
              <VenueCard key={venue.id} venue={venue} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
