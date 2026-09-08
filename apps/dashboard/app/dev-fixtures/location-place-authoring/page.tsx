import { notFound } from 'next/navigation'
import { VenueLocationAuthoring } from '../../../components/admin/VenueLocationAuthoring'
import { TRPCProvider } from '../../../lib/trpc'

export const metadata = { title: 'Location place authoring fixture' }

export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound()
  const revision = new Date('2026-09-07T00:00:00Z')
  return (
    <TRPCProvider scopeKey="location-place-authoring-fixture">
      <main className="mx-auto max-w-6xl px-4 py-8" data-fixture="location-place-authoring">
        <h1 className="mb-5 text-xl font-semibold">Synthetic location review fixture</h1>
        <VenueLocationAuthoring
          tenantId="fixture-tenant"
          venueId="fixture-venue"
          venueName="Garden Museum"
          floors={[]}
          places={[
            {
              id: 'fixture-place',
              name: 'Garden restrooms beside the east courtyard and accessible entrance',
            },
          ]}
          initialLocations={[
            {
              id: '11111111-1111-4111-8111-111111111111',
              stableKey: 'garden-restrooms',
              kind: 'RESTROOM',
              displayName: 'Garden restrooms',
              description: 'Reviewed destination beside the east courtyard.',
              visibility: 'PUBLIC',
              floorId: null,
              parentLocationId: null,
              primaryPlaceId: 'unavailable-fixture-place',
              coordinates: null,
              mapAnchor: null,
              externalMapReference: null,
              isActive: false,
              verifiedAt: revision,
              updatedAt: revision,
            },
          ]}
        />
      </main>
    </TRPCProvider>
  )
}
