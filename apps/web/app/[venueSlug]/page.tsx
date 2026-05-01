import Link from 'next/link'
import { TRPCError } from '@trpc/server'
import { appRouter, createTRPCContext } from '@pathfinder/api'

import { PathFinderIcon } from '../../components/PathFinderBrand'

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
      <main className="flex min-h-screen items-center justify-center bg-pf-surface px-6">
        <section className="w-full max-w-md rounded-3xl border border-pf-light bg-pf-white p-10 text-center shadow-sm">
          <PathFinderIcon className="mx-auto h-12 w-12" />
          <h1 className="mt-5 text-2xl font-semibold tracking-tight text-pf-deep">
            Venue not found
          </h1>
          <p className="mt-3 text-sm leading-6 text-pf-deep/60">
            We couldn&apos;t find this venue. Check the link and try again.
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
          >
            Back to home
          </Link>
        </section>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-pf-surface px-4 py-12 sm:px-6">
      <section className="w-full max-w-lg">
        <div className="rounded-3xl border border-pf-light bg-pf-white p-8 shadow-sm sm:p-10">
          <div className="flex flex-wrap items-center gap-3">
            <PathFinderIcon className="h-8 w-8" />
            {venue.category ? (
              <span className="rounded-full border border-pf-light bg-pf-surface px-3 py-1 text-xs font-semibold uppercase tracking-widest text-pf-primary">
                {venue.category}
              </span>
            ) : null}
          </div>

          <h1 className="mt-5 text-4xl font-light tracking-tight text-pf-deep sm:text-5xl">
            {venue.name}
          </h1>
          <p className="mt-4 text-base leading-7 text-pf-deep/60">
            {venue.description ?? 'Ask your guide where to go, what to see, and what to do next.'}
          </p>

          <div className="mt-8">
            <Link
              href={`/${venueSlug}/chat`}
              className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-pf-primary px-7 text-sm font-semibold text-white transition hover:bg-pf-accent sm:w-auto"
            >
              Open your guide &rarr;
            </Link>
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-pf-deep/30">
          Powered by{' '}
          <Link href="/" className="font-medium text-pf-deep/40 hover:text-pf-primary">
            PathFinder
          </Link>
        </p>
      </section>
    </main>
  )
}
