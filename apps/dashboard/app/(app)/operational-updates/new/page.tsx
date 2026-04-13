import Link from 'next/link'

import { appRouter, createTRPCContext } from '@pathfinder/api'

import { OperationalUpdateForm } from '../../../../components/OperationalUpdateForm'

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/operational-updates/new'),
  })

  return appRouter.createCaller(ctx)
}

export default async function NewOperationalUpdatePage() {
  const caller = await createCaller()
  const venues = await caller.venue.list()

  return (
    <div className="px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-4xl">
        {venues.length === 0 ? (
          <section className="rounded-[2rem] border border-dashed border-slate-300 bg-white px-6 py-12 text-center shadow-sm">
            <h1 className="text-2xl font-semibold text-slate-950">Create a venue first</h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Operational alerts are scoped to a venue, so you need at least one venue before publishing updates.
            </p>
            <Link
              href="/venues/new"
              className="mt-6 inline-flex min-h-11 items-center rounded-full bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              Add a venue
            </Link>
          </section>
        ) : (
          <OperationalUpdateForm venues={venues.map((venue: { id: string; name: string }) => ({ id: venue.id, name: venue.name }))} />
        )}
      </div>
    </div>
  )
}
