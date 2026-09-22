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
    const venueAsset = await caller.admin.getVenueLaunchAsset({ tenantId, venueId })
    const guestChatUrl = venueAsset
      ? buildGuestChatUrl(process.env.NEXT_PUBLIC_WEB_URL, data.venue.slug)
      : null

    if (!guestChatUrl) {
      return (
        <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
          <h2 className="text-2xl font-semibold text-pf-deep">QR kit is not available</h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/75">
            This venue has no current public visitor guide source or secure guest URL. No QR code
            was created. Confirm the venue release and public origin, then reload this venue.
          </p>
        </section>
      )
    }

    return (
      <VenueQrKit
        venueName={data.venue.name}
        guestChatUrl={guestChatUrl}
        venueAsset={venueAsset}
        generatedAt={new Date().toISOString()}
        guideItems={[]}
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
