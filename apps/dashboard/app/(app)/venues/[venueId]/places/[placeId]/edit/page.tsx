import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'

import { appRouter, createTRPCContext } from '@pathfinder/api'

import { PlaceForm } from '../../../../../../../components/PlaceForm'

type EditPlacePageProps = {
  params: Promise<{ venueId: string; placeId: string }>
}

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/venues/places/edit'),
  })

  return appRouter.createCaller(ctx)
}

export default async function EditPlacePage({ params }: EditPlacePageProps) {
  const { venueId, placeId } = await params
  const caller = await createCaller()

  try {
    const [place, venue] = await Promise.all([
      caller.place.getById({ id: placeId }),
      caller.venue.getById({ id: venueId }),
    ])
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
          <PlaceForm
            mode="edit"
            placeId={placeId}
            venueId={venueId}
            venueGuideMode={venueGuideMode}
            initialValues={{
              id: place.id,
              venueId: place.venueId,
              name: place.name,
              type: place.type,
              itemType:
                place.itemType === null || place.itemType === undefined
                  ? ''
                  : (place.itemType as
                      | 'physical_place'
                      | 'exhibit'
                      | 'room'
                      | 'sculpture'
                      | 'service_step'
                      | 'faq'
                      | 'amenity'
                      | 'policy'
                      | 'activity'
                      | 'general_info'),
              shortDescription: place.shortDescription ?? '',
              longDescription: place.longDescription ?? '',
              lat: place.lat ?? undefined,
              lng: place.lng ?? undefined,
              tags: place.tags,
              importanceScore: place.importanceScore,
              areaName: place.areaName ?? '',
              hours: place.hours ?? '',
              photoUrl: place.photoUrl ?? '',
              isActive: place.isActive,
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
