import { redirect } from 'next/navigation'

export default async function ImportVenuePage({
  params,
}: {
  params: Promise<{ venueId: string }>
}) {
  const { venueId } = await params
  redirect(`/?venue=${encodeURIComponent(venueId)}`)
}
