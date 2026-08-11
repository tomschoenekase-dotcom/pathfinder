import { redirect } from 'next/navigation'

export default async function NewPlacePage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params
  redirect(`/?venue=${encodeURIComponent(venueId)}`)
}
