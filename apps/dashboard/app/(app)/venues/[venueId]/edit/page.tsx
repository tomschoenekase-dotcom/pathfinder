import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'

import { VenueForm } from '../../../../../components/VenueForm'
import { createDashboardCaller } from '../../../../../lib/server-caller'

type EditVenuePageProps = {
  params: Promise<{ venueId: string }>
}

export default async function EditVenuePage({ params }: EditVenuePageProps) {
  const { venueId } = await params
  const caller = await createDashboardCaller('/venues/edit')

  try {
    const venue = await caller.venue.getById({ id: venueId })

    return (
      <main className="min-h-screen bg-pf-surface px-6 py-10">
        <div className="mx-auto max-w-4xl space-y-6">
          <Link
            href={`/venues/${venueId}`}
            className="text-sm font-medium text-pf-primary hover:text-pf-accent"
          >
            ← Back to chatbot
          </Link>
          <VenueForm
            mode="edit"
            venueId={venueId}
            initialValues={{
              name: venue.name,
              slug: venue.slug,
              description: venue.description ?? '',
              guideNotes: venue.guideNotes ?? '',
              category: venue.category ?? '',
              guideMode: venue.guideMode === 'non_location' ? 'non_location' : 'location_aware',
              defaultCenterLat: venue.defaultCenterLat ?? undefined,
              defaultCenterLng: venue.defaultCenterLng ?? undefined,
            }}
          />
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
