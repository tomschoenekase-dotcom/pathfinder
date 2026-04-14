import Link from 'next/link'
import { TRPCError } from '@trpc/server'
import { appRouter, createTRPCContext } from '@pathfinder/api'

type VenueLandingPageProps = {
  params: Promise<{
    venueSlug: string
  }>
}

type VenueSummary = {
  id: string
  name: string
  description: string | null
  category: string | null
  defaultCenterLat: number | null
  defaultCenterLng: number | null
}

async function loadVenue(slug: string): Promise<VenueSummary | null> {
  const ctx = await createTRPCContext({
    req: new Request(`https://pathfinder.local/${slug}`),
  })

  try {
    return await appRouter.createCaller(ctx).venue.getBySlug({ slug })
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') {
      return null
    }

    throw error
  }
}

export default async function VenueLandingPage({ params }: VenueLandingPageProps) {
  const { venueSlug } = await params
  const venue = await loadVenue(venueSlug)

  if (!venue) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <section className="w-full max-w-xl rounded-[2rem] border border-white/10 bg-slate-900/65 p-8 text-center shadow-2xl shadow-cyan-950/30 backdrop-blur">
          <p className="text-xs uppercase tracking-[0.3em] text-cyan-300">PathFinder</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white">
            Venue unavailable
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">We could not find this venue.</p>
          <Link
            href="/"
            className="mt-6 inline-flex min-h-11 items-center justify-center rounded-full border border-cyan-400/40 px-5 text-sm font-medium text-cyan-100 transition hover:border-cyan-300 hover:bg-cyan-400/10"
          >
            Back to home
          </Link>
        </section>
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center px-4 py-10 sm:px-6">
      <section className="w-full rounded-[2rem] border border-white/10 bg-slate-900/65 p-8 shadow-2xl shadow-cyan-950/30 backdrop-blur sm:p-10">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs uppercase tracking-[0.3em] text-cyan-300">PathFinder</p>
          <span className="inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-200">
            {venue.category ?? 'Venue'}
          </span>
        </div>

        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          {venue.name}
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300 sm:text-base">
          {venue.description ?? 'Ask PathFinder where to go, what to see, and what to do next.'}
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            href={`/${venueSlug}/chat`}
            className="inline-flex min-h-12 items-center justify-center rounded-full bg-cyan-400 px-6 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"
          >
            Start your visit →
          </Link>
          <p className="text-sm text-slate-400">
            Open the live venue guide for directions, highlights, food, and amenities.
          </p>
        </div>
      </section>
    </main>
  )
}
