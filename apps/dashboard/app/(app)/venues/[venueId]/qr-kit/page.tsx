import Link from 'next/link'
import { notFound } from 'next/navigation'

import { VenueQrKit } from '../../../../../components/VenueQrKit'
import { buildGuestChatUrl } from '../../../../../lib/guest-chat-url'
import { createDashboardCaller } from '../../../../../lib/server-caller'

export default async function VenueQrKitPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params
  const caller = await createDashboardCaller(`/venues/${venueId}/qr-kit`)
  const [venues, lifecycles] = await Promise.all([
    caller.venue.list(),
    caller.portal.getVenueLifecycles(),
  ])
  const venue = venues.find((candidate) => candidate.id === venueId)
  const lifecycle = lifecycles.find((candidate) => candidate.venueId === venueId)
  if (!venue || !lifecycle) notFound()

  const launchReady = lifecycle.lifecycle.state === 'READY' || lifecycle.lifecycle.state === 'LIVE'
  const guestChatUrl = launchReady
    ? buildGuestChatUrl(process.env.NEXT_PUBLIC_WEB_URL, venue.slug, {
        allowLoopbackHttp: process.env.NODE_ENV === 'development',
      })
    : null

  if (!guestChatUrl) {
    return (
      <section className="mx-auto max-w-4xl px-4 py-8 sm:px-7 sm:py-12" role="alert">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
          Launch materials
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-pf-deep">
          QR kit is not available yet
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-pf-deep/70">
          This venue needs a reviewed visitor link before QR materials can be created. No code was
          generated and nothing was published.
        </p>
        <Link
          href={`/?venue=${encodeURIComponent(venue.id)}`}
          className="mt-6 inline-flex min-h-11 items-center text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          Back to Today
        </Link>
      </section>
    )
  }

  const places = await caller.place.list({ venueId })
  const guideItems = places
    .filter((place) => place.isActive && place.visibility === 'PUBLIC')
    .map((place) => ({
      id: place.id,
      name: place.name,
      updatedAt: place.updatedAt.toISOString(),
    }))

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-7 sm:py-12">
      <Link
        href={`/?venue=${encodeURIComponent(venue.id)}`}
        className="mb-7 inline-flex min-h-11 items-center text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent print:hidden"
      >
        Back to Today
      </Link>
      <VenueQrKit
        audience="client"
        venueName={venue.name}
        guestChatUrl={guestChatUrl}
        generatedAt={new Date().toISOString()}
        guideItems={guideItems}
      />
    </div>
  )
}
