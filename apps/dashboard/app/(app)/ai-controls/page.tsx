import Link from 'next/link'

import { isFeatureEnabled } from '@pathfinder/config/feature-flags'

import tochiDevelopmentManifest from '../../../../../assets/characters/tochi/v0-development/manifest.json'
import { AiControlsForm } from '../../../components/AiControlsForm'
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

  if (venues.length === 0) {
    return (
      <div className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
        <div className="mx-auto max-w-6xl space-y-8">
          <section className="rounded-[2rem] bg-pf-deep px-8 py-10 text-white shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-widest text-pf-light">
              Venue Bot
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight">
              Visitor conversation settings
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-pf-light/90">
              Configure the public guide your visitors use. This is separate from Tochi in your
              private client portal.
            </p>
          </section>

          <section className="rounded-[2rem] border border-dashed border-pf-light bg-pf-white p-10 text-center shadow-sm">
            <h2 className="text-2xl font-semibold text-pf-deep">
              Create a venue before configuring Venue Bot.
            </h2>
            <Link
              href="/venues/new"
              className="mt-6 inline-flex min-h-11 items-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
            >
              Create a venue
            </Link>
          </section>
        </div>
      </div>
    )
  }

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
    <div className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <section className="rounded-[2rem] bg-pf-deep px-8 py-10 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-pf-light">Venue Bot</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight">
            Visitor conversation settings
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-pf-light/90">
            Choose how your public visitor guide appears and communicates. Venue Bot is separate
            from Tochi in your private client portal.
          </p>
        </section>

        <AiControlsForm
          initialVenueId={initialVenueId}
          venues={configurations}
          tochiDevelopmentPreview={tochiDevelopmentPreview}
        />
      </div>
    </div>
  )
}
