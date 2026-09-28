import Link from 'next/link'
import { redirect } from 'next/navigation'

import { isFeatureEnabled } from '@pathfinder/config/feature-flags'

import tochiDevelopmentManifest from '../../../../../assets/characters/tochi/v0-development/manifest.json'
import { AiControlsForm } from '../../../components/AiControlsForm'
import { PortalPage, portalTextLink } from '../../../components/portal/PortalPrimitives'
import { createDashboardCaller } from '../../../lib/server-caller'

type AiControlsPageProps = {
  searchParams: Promise<{
    venue?: string | string[]
  }>
}

export default async function AiControlsPage({ searchParams }: AiControlsPageProps) {
  const { venue: requestedVenue } = await searchParams
  const caller = await createDashboardCaller('/ai-controls')
  const venues = await caller.venue.list()

  if (venues.length === 0) redirect('/onboarding/setup')

  const venueQuery = Array.isArray(requestedVenue) ? requestedVenue[0] : requestedVenue
  const initialVenueId = venues.some((venue) => venue.id === venueQuery)
    ? venueQuery!
    : venues[0]!.id
  const configurations = await Promise.all(
    venues.map(async (venue) => ({
      id: venue.id,
      name: venue.name,
      configuration: await caller.venue.getBotConfiguration({ venueId: venue.id }),
      profiles: await caller.venue.listPersonalityProfiles({ venueId: venue.id }),
    })),
  )

  const characterRolloutVisible =
    isFeatureEnabled('venueCharacterMode') &&
    isFeatureEnabled('characterRegistry') &&
    isFeatureEnabled('tochiVenueCharacter')
  const previewAsset = tochiDevelopmentManifest.assets.find(
    (asset) => asset.id === tochiDevelopmentManifest.selectionPreviewAssetId,
  )
  const tochiDevelopmentPreview =
    characterRolloutVisible && previewAsset
      ? {
          src: `${tochiDevelopmentManifest.publicBasePath}/${previewAsset.path}`,
          width: previewAsset.width,
          height: previewAsset.height,
        }
      : null

  return (
    <PortalPage
      title="Guide tone and answers"
      description={
        <>
          How your visitor guide sounds and how much it says. Colours, logo and photo are in{' '}
          <Link
            href={`/look-and-feel?venue=${encodeURIComponent(initialVenueId)}`}
            className={portalTextLink}
          >
            Look &amp; feel
          </Link>
          .
        </>
      }
    >
      <AiControlsForm
        initialVenueId={initialVenueId}
        venues={configurations}
        tochiDevelopmentPreview={tochiDevelopmentPreview}
      />
    </PortalPage>
  )
}
