import { redirect } from 'next/navigation'

export default async function EditPlacePage({
  params,
}: {
  params: Promise<{ venueId: string; placeId: string }>
}) {
  const { venueId } = await params
  redirect(`/?venue=${encodeURIComponent(venueId)}`)
}
