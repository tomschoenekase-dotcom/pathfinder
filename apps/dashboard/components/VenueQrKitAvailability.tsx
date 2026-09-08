import Link from 'next/link'

import { VenueQrKit } from './VenueQrKit'

export type VenueQrKitGuideItem = {
  id: string
  name: string
  updatedAt: string
}

export type VenueQrKitAvailabilityProps = {
  venueId: string
  venueName: string
  lifecycleState: string
  guestChatUrl: string | null
  generatedAt: string
  guideItems: VenueQrKitGuideItem[]
}

export function isVenueQrKitAvailable(
  lifecycleState: string,
  guestChatUrl: string | null,
): boolean {
  return (lifecycleState === 'READY' || lifecycleState === 'LIVE') && guestChatUrl !== null
}

export function VenueQrKitAvailability({
  venueId,
  venueName,
  lifecycleState,
  guestChatUrl,
  generatedAt,
  guideItems,
}: VenueQrKitAvailabilityProps) {
  const available = isVenueQrKitAvailable(lifecycleState, guestChatUrl)
  if (!available || guestChatUrl === null) {
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
          href={`/?venue=${encodeURIComponent(venueId)}`}
          className="mt-6 inline-flex min-h-11 items-center text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          Back to Today
        </Link>
      </section>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-7 sm:py-12">
      <Link
        href={`/?venue=${encodeURIComponent(venueId)}`}
        className="mb-7 inline-flex min-h-11 items-center text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent print:hidden"
      >
        Back to Today
      </Link>
      <VenueQrKit
        audience="client"
        venueName={venueName}
        guestChatUrl={guestChatUrl}
        generatedAt={generatedAt}
        guideItems={guideItems}
      />
    </div>
  )
}
