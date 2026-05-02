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
    <main className="min-h-screen bg-pf-surface px-6 py-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
              Dashboard
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-pf-deep">Venues</h1>
            <p className="max-w-2xl text-sm leading-6 text-pf-deep/60">
              Manage the venue records and guide item data that power the public chat experience.
            </p>
          </div>
          <Link
            href="/venues/new"
            className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent"
          >
            New venue
          </Link>
        </div>

        {venuesWithCounts.length === 0 ? (
          <section className="rounded-3xl border border-dashed border-pf-light bg-pf-white p-10 text-center shadow-sm">
            <h2 className="text-2xl font-semibold text-pf-deep">No venues yet</h2>
            <p className="mt-3 text-sm leading-6 text-pf-deep/60">
              Create your first one to start loading guide items for the chatbot.
            </p>
            <Link
              href="/venues/new"
              className="mt-6 inline-flex min-h-11 items-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
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
