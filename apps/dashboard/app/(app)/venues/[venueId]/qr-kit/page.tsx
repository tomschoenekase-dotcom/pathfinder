import Link from 'next/link'
import { notFound } from 'next/navigation'

import { VenueQrKit } from '../../../../../components/VenueQrKit'
import { buildGuestChatUrl } from '../../../../../lib/guest-chat-url'
import { createDashboardCaller } from '../../../../../lib/server-caller'

type VenueQrKitPageProps = { params: Promise<{ venueId: string }> }

export default async function VenueQrKitPage({ params }: VenueQrKitPageProps) {
  const { venueId } = await params
  const caller = await createDashboardCaller('/venues/qr-kit')
  const [venue, places] = await Promise.all([
    caller.venue.getById({ id: venueId }),
    caller.place.list({ venueId }),
  ])
  const guestChatUrl = buildGuestChatUrl(process.env.NEXT_PUBLIC_WEB_URL, venue.slug, {
    allowLoopbackHttp: process.env.NODE_ENV === 'development',
  })

  if (!guestChatUrl) notFound()

  return (
    <main className="min-h-screen bg-pf-surface px-6 py-10 print:bg-white print:p-0">
      <div className="mx-auto max-w-7xl">
        <Link
          href={`/venues/${venueId}`}
          className="mb-6 inline-flex text-sm font-medium text-pf-primary hover:text-pf-accent print:hidden"
        >
          &larr; Back to venue
        </Link>
        <VenueQrKit
          venueName={venue.name}
          guestChatUrl={guestChatUrl}
          generatedAt={new Date().toISOString()}
          guideItems={places
            .filter((place) => place.isActive)
            .map((place) => ({
              id: place.id,
              name: place.name,
              updatedAt: place.updatedAt.toISOString(),
            }))}
        />
      </div>
    </main>
  )
}
