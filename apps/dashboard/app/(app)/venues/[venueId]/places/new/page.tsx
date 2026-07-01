import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'

import { PlaceForm } from '../../../../../../components/PlaceForm'
import { createDashboardCaller } from '../../../../../../lib/server-caller'

type NewPlacePageProps = {
  params: Promise<{ venueId: string }>
}

export default async function NewPlacePage({ params }: NewPlacePageProps) {
  const { venueId } = await params
  const caller = await createDashboardCaller('/venues/places/new')

  try {
    const venue = await caller.venue.getById({ id: venueId })
    const venueGuideMode = venue.guideMode === 'non_location' ? 'non_location' : 'location_aware'

    return (
      <main className="min-h-screen bg-pf-surface px-6 py-10">
        <div className="mx-auto max-w-4xl space-y-6">
          <Link
            href={`/venues/${venueId}`}
            className="text-sm font-medium text-pf-primary hover:text-pf-accent"
          >
            Back to venue
          </Link>
          <PlaceForm mode="create" venueId={venueId} venueGuideMode={venueGuideMode} />
        </div>
      </main>
    )
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') {
      notFound()
    }

    throw error
  }
}
