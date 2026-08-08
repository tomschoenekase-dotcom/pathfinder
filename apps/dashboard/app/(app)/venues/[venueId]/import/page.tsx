import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'

import { VenueJsonImporter } from '../../../../../components/VenueJsonImporter'
import { createDashboardCaller } from '../../../../../lib/server-caller'

type ImportVenuePageProps = {
  params: Promise<{ venueId: string }>
}

export default async function ImportVenuePage({ params }: ImportVenuePageProps) {
  const { venueId } = await params
  const { orgRole, sessionClaims } = await auth()
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  const canManage =
    isPlatformAdmin ||
    orgRole === 'org:manager' ||
    orgRole === 'org:admin' ||
    orgRole === 'org:owner'
  if (!canManage) notFound()
  const canPublish = isPlatformAdmin || orgRole === 'org:admin' || orgRole === 'org:owner'
  const caller = await createDashboardCaller('/venues/import')

  try {
    const venue = await caller.venue.getById({ id: venueId })
    const guideMode = venue.guideMode === 'non_location' ? 'non_location' : 'location_aware'

    return (
      <main className="min-h-screen bg-pf-surface px-6 py-10">
        <div className="mx-auto max-w-4xl space-y-6">
          <Link
            href={`/venues/${venueId}`}
            className="text-sm font-medium text-pf-primary hover:text-pf-accent"
          >
            Back to venue
          </Link>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-pf-accent">
              Venue content lifecycle
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-pf-deep">
              Venue packages
            </h1>
          </div>
          <VenueJsonImporter
            venueId={venueId}
            venueName={venue.name}
            guideMode={guideMode}
            canPublish={canPublish}
          />
        </div>
      </main>
    )
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') notFound()
    throw error
  }
}
