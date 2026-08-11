import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'
import { TONE_PRESET_REGISTRY, resolveEffectiveTone } from '@pathfinder/contracts/tone-presets'

import { createDashboardCaller } from '../../../../lib/server-caller'
import { ContentHistoryPanel } from '../../../../components/ContentHistoryPanel'
import { DeletedContentHistoryPanel } from '../../../../components/DeletedContentHistoryPanel'
import { DeletedVenueHistoryPanel } from '../../../../components/DeletedVenueHistoryPanel'
import { VenueAvailabilityControl } from '../../../../components/VenueAvailabilityControl'
import { VenueGuestAccessPanel } from '../../../../components/VenueGuestAccessPanel'
import { buildGuestChatUrl } from '../../../../lib/guest-chat-url'

type VenueDetailPageProps = {
  params: Promise<{
    venueId: string
  }>
  searchParams: Promise<{
    onboarded?: string
  }>
}

function formatCoordinate(value: number | null): string {
  if (value === null) {
    return 'Not set'
  }

  return value.toFixed(5)
}

function TypeBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex rounded-full border border-pf-light bg-pf-surface px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
      {label}
    </span>
  )
}

function GuideNotes({ notes }: { notes: string | null }) {
  if (!notes) {
    return <p className="text-sm leading-6 text-pf-deep/50">No guide notes configured yet.</p>
  }

  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-sm font-medium text-pf-primary marker:hidden">
        <span className="group-open:hidden">Expand notes</span>
        <span className="hidden group-open:inline">Collapse notes</span>
      </summary>
      <p className="mt-3 line-clamp-3 text-sm leading-6 text-pf-deep/60 group-open:line-clamp-none">
        {notes}
      </p>
    </details>
  )
}

export default async function VenueDetailPage({ params, searchParams }: VenueDetailPageProps) {
  const { venueId } = await params
  const { onboarded } = await searchParams
  const justOnboarded = onboarded === '1'
  const caller = await createDashboardCaller('/venues/detail')
  const { orgRole, sessionClaims } = await auth()
  const canRestoreDeletedVenues = orgRole === 'org:admin' || orgRole === 'org:owner'
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  const canManageVenuePackages =
    isPlatformAdmin ||
    orgRole === 'org:manager' ||
    orgRole === 'org:admin' ||
    orgRole === 'org:owner'

  try {
    const venue = await caller.venue.getById({ id: venueId })
    const [aiConfig, places] = await Promise.all([
      caller.venue.getAiConfig({ venueId }),
      caller.place.list({ venueId }),
    ])
    const guestChatUrl = buildGuestChatUrl(process.env.NEXT_PUBLIC_WEB_URL, venue.slug, {
      allowLoopbackHttp: process.env.NODE_ENV === 'development',
    })
    const isLocationAware = venue.guideMode !== 'non_location'
    const hasCompleteCenter =
      venue.defaultCenterLat !== null &&
      Number.isFinite(venue.defaultCenterLat) &&
      venue.defaultCenterLng !== null &&
      Number.isFinite(venue.defaultCenterLng)

    const activePlacesCount = places.filter((place) => place.isActive).length
    const enabledKnowledgeCount = venue._count.knowledgeEntries
    const featuredPlace =
      aiConfig.aiFeaturedPlaceId !== null && aiConfig.aiFeaturedPlaceId !== undefined
        ? (places.find((place) => place.id === aiConfig.aiFeaturedPlaceId) ?? null)
        : null

    return (
      <main className="min-h-screen bg-pf-surface px-6 py-10">
        <div className="mx-auto max-w-7xl space-y-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <Link href="/" className="text-sm font-medium text-pf-primary hover:text-pf-accent">
                ← Overview
              </Link>
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-pf-accent">
                    Your chatbot
                  </p>
                  <TypeBadge label={venue.category ?? 'Venue'} />
                </div>
                <h1 className="mt-2 text-4xl font-semibold tracking-tight text-pf-deep">
                  {venue.name}
                </h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-pf-deep/60">
                  {venue.description ?? 'No description added yet.'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href={`/venues/${venue.id}/edit`}
                className="inline-flex min-h-11 items-center rounded-full border border-pf-light bg-pf-white px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
              >
                Edit venue
              </Link>
              <Link
                href={`/venues/${venue.id}/knowledge`}
                className="inline-flex min-h-11 items-center rounded-full border border-pf-light bg-pf-white px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
              >
                Knowledge Base
              </Link>
              {canManageVenuePackages ? (
                <Link
                  href={`/venues/${venue.id}/import`}
                  className="inline-flex min-h-11 items-center rounded-full border border-pf-light bg-pf-white px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
                >
                  Venue packages
                </Link>
              ) : null}
              <Link
                href={`/venues/${venue.id}/places/new`}
                className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent"
              >
                Add guide item
              </Link>
            </div>
          </div>

          {justOnboarded ? (
            <section className="rounded-[1.75rem] border border-emerald-200 bg-emerald-50 px-6 py-5">
              <p className="text-sm font-semibold text-emerald-800">Your venue is set up.</p>
              <p className="mt-1 text-sm leading-6 text-emerald-700">
                Add public content when it improves the AI guide. Review and test the guest
                experience before sharing it with guests.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link
                  href={`/venues/${venueId}/places/new`}
                  className="inline-flex min-h-9 items-center rounded-full bg-emerald-700 px-4 text-sm font-medium text-white transition hover:bg-emerald-800"
                >
                  Add guide item
                </Link>
                <Link
                  href={`/venues/${venueId}/knowledge`}
                  className="inline-flex min-h-9 items-center rounded-full border border-emerald-300 bg-white px-4 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50"
                >
                  Manage Knowledge
                </Link>
                <Link
                  href="/ai-controls"
                  className="inline-flex min-h-9 items-center rounded-full border border-emerald-300 bg-white px-4 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50"
                >
                  Configure AI guide
                </Link>
              </div>
            </section>
          ) : null}

          <VenueGuestAccessPanel
            venueId={venue.id}
            venueName={venue.name}
            guestChatUrl={guestChatUrl}
            isVenueActive={venue.isActive}
            activePlacesCount={activePlacesCount}
            enabledKnowledgeCount={enabledKnowledgeCount}
            guideMode={isLocationAware ? 'location_aware' : 'non_location'}
            hasCompleteCenter={hasCompleteCenter}
          />

          {canManageVenuePackages ? (
            <VenueAvailabilityControl
              scope="tenant"
              venueName={venue.name}
              venueId={venue.id}
              initialState={{
                isActive: venue.isActive,
                updatedAt: venue.updatedAt.toISOString(),
              }}
            />
          ) : null}

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <article className="rounded-[1.75rem] border border-pf-light bg-pf-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-pf-deep/30">Slug</p>
              <p className="mt-2 font-mono text-sm text-pf-deep">{venue.slug}</p>
            </article>
            <article className="rounded-[1.75rem] border border-pf-light bg-pf-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-pf-deep/30">AI tone</p>
              <p className="mt-2 text-lg font-semibold text-pf-deep">
                {TONE_PRESET_REGISTRY[resolveEffectiveTone(aiConfig).preset].label}
              </p>
            </article>
            <article className="rounded-[1.75rem] border border-pf-light bg-pf-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-pf-deep/30">
                Guide experience
              </p>
              <p className="mt-2 text-lg font-semibold text-pf-deep">
                {isLocationAware ? 'Location-aware guide' : 'Guide without visitor location'}
              </p>
            </article>
            {isLocationAware ? (
              <>
                <article className="rounded-[1.75rem] border border-pf-light bg-pf-white p-6 shadow-sm">
                  <p className="text-xs uppercase tracking-[0.18em] text-pf-deep/30">
                    Center latitude
                  </p>
                  <p className="mt-2 font-mono text-sm text-pf-deep">
                    {formatCoordinate(venue.defaultCenterLat)}
                  </p>
                </article>
                <article className="rounded-[1.75rem] border border-pf-light bg-pf-white p-6 shadow-sm">
                  <p className="text-xs uppercase tracking-[0.18em] text-pf-deep/30">
                    Center longitude
                  </p>
                  <p className="mt-2 font-mono text-sm text-pf-deep">
                    {formatCoordinate(venue.defaultCenterLng)}
                  </p>
                </article>
              </>
            ) : null}
            <article className="rounded-[1.75rem] border border-pf-light bg-pf-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-pf-deep/30">
                Active guide items
              </p>
              <p className="mt-2 text-2xl font-semibold text-pf-deep">{activePlacesCount}</p>
            </article>
            <article className="rounded-[1.75rem] border border-pf-light bg-pf-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-pf-deep/30">
                Enabled Knowledge entries
              </p>
              <p className="mt-2 text-2xl font-semibold text-pf-deep">{enabledKnowledgeCount}</p>
            </article>
            <article className="rounded-[1.75rem] border border-pf-light bg-pf-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-pf-deep/30">
                Featured guide item
              </p>
              <p className="mt-2 text-lg font-semibold text-pf-deep">
                {featuredPlace?.name ?? 'Not selected'}
              </p>
            </article>
          </section>

          <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
            <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Guide notes</h2>
            <div className="mt-4">
              <GuideNotes notes={aiConfig.aiGuideNotes ?? null} />
            </div>
          </section>

          <ContentHistoryPanel entityType="VENUE" entityId={venue.id} title="Venue history" />
          <DeletedContentHistoryPanel venueId={venue.id} />
          {canRestoreDeletedVenues ? <DeletedVenueHistoryPanel /> : null}

          <section className="overflow-hidden rounded-[2rem] border border-pf-light bg-pf-white shadow-sm">
            <div className="border-b border-pf-light px-6 py-5">
              <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Guide Items</h2>
              <p className="mt-2 text-sm leading-6 text-pf-deep/60">
                Review the guide items powering the venue guide.
              </p>
            </div>

            {places.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <p className="text-lg font-medium text-pf-deep">No guide items yet</p>
                <p className="mt-2 text-sm leading-6 text-pf-deep/60">
                  Knowledge can answer general questions without a guide item. Add one when a place,
                  exhibit, or service should have its own card.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-pf-surface text-left text-pf-deep/50">
                    <tr>
                      <th className="px-6 py-3 font-medium">Name</th>
                      <th className="px-6 py-3 font-medium">Category</th>
                      <th className="px-6 py-3 font-medium">Status</th>
                      {isLocationAware ? (
                        <th className="px-6 py-3 font-medium">Coordinates</th>
                      ) : null}
                      <th className="px-6 py-3 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {places.map((place) => (
                      <tr
                        key={place.id}
                        className="border-t border-pf-light transition-colors hover:bg-pf-surface"
                      >
                        <td className="px-6 py-4 align-top">
                          <div className="font-medium text-pf-deep">{place.name}</div>
                          <p className="mt-1 text-xs text-pf-deep/50">
                            {place.areaName ?? 'Unknown area'}
                          </p>
                        </td>
                        <td className="px-6 py-4 align-top">
                          <TypeBadge label={place.type} />
                        </td>
                        <td className="px-6 py-4 align-top">
                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                              place.isActive
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-pf-surface text-pf-deep/40'
                            }`}
                          >
                            {place.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        {isLocationAware ? (
                          <td className="px-6 py-4 align-top">
                            <p className="font-mono text-xs text-pf-deep/60">
                              {place.lat != null && place.lng != null
                                ? `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`
                                : 'Not set'}
                            </p>
                          </td>
                        ) : null}
                        <td className="px-6 py-4 text-right align-top">
                          <Link
                            href={`/venues/${place.venueId}/places/${place.id}/edit`}
                            className="inline-flex min-h-11 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
                          >
                            Edit
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
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
