import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'

import { appRouter, createTRPCContext } from '@pathfinder/api'

import { VenueForm } from '../../../../../components/VenueForm'

type EditVenuePageProps = {
  params: Promise<{ venueId: string }>
}

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/venues/edit'),
  })

  return appRouter.createCaller(ctx)
}

export default async function EditVenuePage({ params }: EditVenuePageProps) {
  const { venueId } = await params
  const caller = await createCaller()

  try {
    const venue = await caller.venue.getById({ id: venueId })

    return (
      <main className="min-h-screen bg-slate-50 px-6 py-10">
        <div className="mx-auto max-w-4xl space-y-6">
          <Link
            href={`/venues/${venueId}`}
            className="text-sm font-medium text-cyan-700 hover:text-cyan-800"
          >
            Back to venue
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
