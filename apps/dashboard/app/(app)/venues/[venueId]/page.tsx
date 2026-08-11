import { redirect } from 'next/navigation'

type Props = { params: Promise<{ venueId: string }> }

/** The portal home owns live state and the guest preview for a selected venue. */
export default async function VenueDetailPage({ params }: Props) {
  const { venueId } = await params
  redirect(`/?venue=${encodeURIComponent(venueId)}`)
}
