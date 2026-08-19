import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function IntakePage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params
  redirect(`/venues/${encodeURIComponent(venueId)}/onboarding`)
}
