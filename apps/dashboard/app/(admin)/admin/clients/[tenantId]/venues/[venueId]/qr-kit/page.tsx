export const dynamic = 'force-dynamic'

import { VenueQrKit } from '../../../../../../../../components/VenueQrKit'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'
import { buildGuestChatUrl } from '../../../../../../../../lib/guest-chat-url'

type Props = { params: Promise<{ tenantId: string; venueId: string }> }

export default async function AdminVenueQrKitPage({ params }: Props) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()

  try {
    const data = await caller.admin.getClientVenue({ tenantId, venueId })
    const guestChatUrl = buildGuestChatUrl(process.env.NEXT_PUBLIC_WEB_URL, data.venue.slug, {
      allowLoopbackHttp: process.env.NODE_ENV !== 'production',
    })

    if (!guestChatUrl) {
      return (
        <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
          <h2 className="text-2xl font-semibold text-pf-deep">QR kit is not available</h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/75">
            The public guest origin is not configured safely for this environment. No QR code was
            created. Correct the environment configuration, then reload this exact venue scope.
          </p>
        </section>
      )
    }

    return (
      <VenueQrKit
        venueName={data.venue.name}
        guestChatUrl={guestChatUrl}
        generatedAt={new Date().toISOString()}
        guideItems={data.places
          .filter((place) => place.isActive)
          .map((place) => ({
            id: place.id,
            name: place.name,
            updatedAt: place.updatedAt.toISOString(),
          }))}
      />
    )
  } catch {
    return (
      <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
        <h2 className="text-2xl font-semibold text-pf-deep">QR kit could not be loaded</h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/75">
          No print or launch action occurred. Confirm the exact client and venue scope, then retry.
        </p>
      </section>
    )
  }
}
