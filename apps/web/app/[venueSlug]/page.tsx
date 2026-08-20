import Link from 'next/link'
import { notFound } from 'next/navigation'
import { appRouter, createTRPCContext } from '@pathfinder/api'

import { TorchikoIcon } from '@pathfinder/ui/brand'
import { VenueTemporarilyUnavailable } from '../../components/VenueTemporarilyUnavailable'
import { classifyPublicVenueLookupError } from '../../lib/public-venue-error'

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

type VenueLookup =
  | { status: 'ready'; venue: VenueSummary }
  | { status: 'not-found' }
  | { status: 'temporarily-unavailable' }

async function loadVenue(slug: string): Promise<VenueLookup> {
  const ctx = await createTRPCContext({
    req: new Request(`https://pathfinder.local/${slug}`),
  })

  try {
    const venue = await appRouter.createCaller(ctx).venue.getBySlug({ slug })
    return { status: 'ready', venue }
  } catch (error) {
    const failure = classifyPublicVenueLookupError(error)
    if (failure === 'not-found' || failure === 'temporarily-unavailable') {
      return { status: failure }
    }

    throw error
  }
}

export default async function VenueLandingPage({ params }: VenueLandingPageProps) {
  const { venueSlug } = await params
  const lookup = await loadVenue(venueSlug)

  if (lookup.status === 'not-found') {
    notFound()
  }

  if (lookup.status === 'temporarily-unavailable') {
    return <VenueTemporarilyUnavailable />
  }

  const venue = lookup.venue

  return (
    <main className="flex min-h-screen items-center justify-center bg-pf-surface px-4 py-12 sm:px-6">
      <section className="w-full max-w-lg">
        <div className="rounded-3xl border border-pf-light bg-pf-white p-8 shadow-sm sm:p-10">
          <div className="flex flex-wrap items-center gap-3">
            <TorchikoIcon className="h-8 w-8" />
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
            Torchiko
          </Link>
        </p>
      </section>
    </main>
  )
}
