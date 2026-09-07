import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'

import { isFeatureEnabled } from '@pathfinder/config/feature-flags'

import tochiDevelopmentManifest from '../../../../../assets/characters/tochi/v0-development/manifest.json'
import { AiControlsForm } from '../../../components/AiControlsForm'
import { ChatDesignForm } from '../../../components/ChatDesignForm'
import { createDashboardCaller } from '../../../lib/server-caller'

type AiControlsPageProps = {
  searchParams: Promise<{
    venue?: string | string[]
  }>
}

export default async function AiControlsPage({ searchParams }: AiControlsPageProps) {
  const { orgRole, sessionClaims } = await auth()
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  const canEditBranding =
    isPlatformAdmin ||
    orgRole === 'org:admin' ||
    orgRole === 'org:manager' ||
    orgRole === 'org:owner'
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

        <section
          aria-labelledby="chat-design-heading"
          className="rounded-[2rem] border border-pf-light bg-white p-6 shadow-sm sm:p-8"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-pf-primary">
            Branding
          </p>
          <h2 id="chat-design-heading" className="mt-2 text-2xl font-semibold text-pf-deep">
            Customize the visitor chat
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
            Choose a built-in colour theme, accent, and typeface for this venue’s public visitor
            guide. Changes save to the venue and appear in the visitor chat immediately.
          </p>
          <div className="mt-6">
            <ChatDesignForm
              venues={venues}
              canEdit={canEditBranding}
              initialVenueId={initialVenueId}
            />
          </div>
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
