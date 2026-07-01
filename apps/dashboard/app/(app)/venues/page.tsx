import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createDashboardCaller } from '../../../lib/server-caller'

export default async function VenuesPage() {
  const caller = await createDashboardCaller('/venues')
  const venues = await caller.venue.list()

  if (venues.length > 0) {
    redirect(`/venues/${venues[0]!.id}`)
  }

  return (
    <main className="min-h-screen bg-pf-surface px-6 py-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
            Dashboard
          </p>
          <h1 className="text-4xl font-semibold tracking-tight text-pf-deep">Your Chatbot</h1>
          <p className="max-w-2xl text-sm leading-6 text-pf-deep/60">
            Set up your AI guide to start answering guest questions.
          </p>
        </div>

        <section className="rounded-3xl border border-dashed border-pf-light bg-pf-white p-10 text-center shadow-sm">
          <h2 className="text-2xl font-semibold text-pf-deep">No chatbot set up yet</h2>
          <p className="mt-3 text-sm leading-6 text-pf-deep/60">
            Create your chatbot to start loading guide items and talking to guests.
          </p>
          <Link
            href="/venues/new"
            className="mt-6 inline-flex min-h-11 items-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
          >
            Create your chatbot
          </Link>
        </section>
      </div>
    </main>
  )
}
