import Link from 'next/link'
import type { PublicVenueMediaItem } from '@pathfinder/contracts'

import { selectVenueMediaForPresentation } from '../lib/venue-media-presentation'
import { VenueMediaShowcase } from './VenueMediaShowcase'

export type VenueArrivalSummary = {
  name: string
  description: string | null
  category: string | null
}

export function VenueArrival({
  venue,
  venueSlug,
  media,
  mediaStatus,
}: {
  venue: VenueArrivalSummary
  venueSlug: string
  media: PublicVenueMediaItem[]
  mediaStatus: 'ready' | 'unavailable'
}) {
  const presentedMedia = selectVenueMediaForPresentation(media)
  const hasMedia = presentedMedia.length > 0

  return (
    <main className="min-h-screen bg-pf-surface px-4 py-8 sm:px-6 sm:py-12 lg:py-16">
      <section
        className={`mx-auto grid w-full max-w-6xl items-center gap-8 lg:gap-14 ${hasMedia ? 'lg:grid-cols-[minmax(0,1.15fr)_minmax(22rem,.85fr)]' : 'min-h-[calc(100vh-8rem)] max-w-2xl'}`}
      >
        {hasMedia ? <VenueMediaShowcase venueName={venue.name} items={presentedMedia} /> : null}

        <div className="min-w-0 border-t border-pf-light pt-7 lg:border-l lg:border-t-0 lg:py-8 lg:pl-12">
          <div className="flex flex-wrap items-center gap-3">
            <span className="h-px w-8 bg-pf-primary/45" aria-hidden="true" />
            {venue.category ? (
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
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
              className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-pf-primary px-7 text-sm font-semibold text-white transition hover:bg-pf-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-pf-primary sm:w-auto"
            >
              Open your guide &rarr;
            </Link>
          </div>

          {mediaStatus === 'unavailable' ? (
            <p className="mt-5 text-xs leading-5 text-pf-deep/55" role="status">
              Venue photos are temporarily unavailable. Your guide is ready.
            </p>
          ) : null}

          <p className="mt-8 text-xs text-pf-deep/40">
            Powered by{' '}
            <Link href="/" className="font-medium hover:text-pf-primary">
              Torchiko
            </Link>
          </p>
        </div>
      </section>
    </main>
  )
}
