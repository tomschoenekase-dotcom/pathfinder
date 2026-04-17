import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'

import { appRouter, createTRPCContext } from '@pathfinder/api'
import { CopyUrlButton } from '../../../../components/CopyUrlButton'

type VenueDetailPageProps = {
  params: Promise<{
    venueId: string
  }>
  searchParams: Promise<{
    onboarded?: string
  }>
}

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/venues/detail'),
  })

  return appRouter.createCaller(ctx)
}

const TONE_LABELS: Record<string, string> = {
  FRIENDLY: 'Friendly',
  PROFESSIONAL: 'Professional',
  PLAYFUL: 'Playful',
}

function formatCoordinate(value: number | null): string {
  if (value === null) {
    return 'Not set'
  }

  return value.toFixed(5)
}

function TypeBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
      {label}
    </span>
  )
}

function GuideNotes({ notes }: { notes: string | null }) {
  if (!notes) {
    return <p className="text-sm leading-6 text-slate-500">No guide notes configured yet.</p>
  }

  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-sm font-medium text-cyan-700 marker:hidden">
        <span className="group-open:hidden">Expand notes</span>
        <span className="hidden group-open:inline">Collapse notes</span>
      </summary>
      <p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-600 group-open:line-clamp-none">
        {notes}
      </p>
    </details>
  )
}

export default async function VenueDetailPage({ params, searchParams }: VenueDetailPageProps) {
  const { venueId } = await params
  const { onboarded } = await searchParams
  const justOnboarded = onboarded === '1'
  const caller = await createCaller()

  try {
    const venue = await caller.venue.getById({ id: venueId })
    const [aiConfig, places] = await Promise.all([
      caller.venue.getAiConfig({ venueId }),
      caller.place.list({ venueId }),
    ])
    const webUrl = process.env.NEXT_PUBLIC_WEB_URL
    const guestChatUrl = webUrl
      ? `${webUrl}/${venue.slug}/chat`
      : `your-domain.com/${venue.slug}/chat`

    const activePlacesCount = places.filter((place) => place.isActive).length
    const featuredPlace =
      aiConfig.aiFeaturedPlaceId !== null && aiConfig.aiFeaturedPlaceId !== undefined
        ? (places.find((place) => place.id === aiConfig.aiFeaturedPlaceId) ?? null)
        : null

    return (
      <main className="min-h-screen bg-slate-50 px-6 py-10">
        <div className="mx-auto max-w-7xl space-y-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <Link
                href="/venues"
                className="text-sm font-medium text-cyan-700 hover:text-cyan-800"
              >
                Back to venues
              </Link>
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700">
                    Venue management
                  </p>
                  <TypeBadge label={venue.category ?? 'Venue'} />
                </div>
                <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-900">
                  {venue.name}
                </h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
                  {venue.description ?? 'No description added yet.'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href={`/venues/${venue.id}/edit`}
                className="inline-flex min-h-11 items-center rounded-full border border-slate-300 bg-white px-5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Edit venue
              </Link>
              <Link
                href={`/ai-controls?venue=${venue.id}`}
                className="inline-flex min-h-11 items-center rounded-full border border-slate-300 bg-white px-5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                AI Controls
              </Link>
              {webUrl ? (
                <a
                  href={guestChatUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center rounded-full border border-cyan-300 bg-cyan-50 px-5 text-sm font-medium text-cyan-700 transition hover:bg-cyan-100"
                >
                  Test AI chat
                </a>
              ) : null}
              <Link
                href={`/venues/${venue.id}/places/new`}
                className="inline-flex min-h-11 items-center rounded-full bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                Add place
              </Link>
            </div>
          </div>

          {justOnboarded ? (
            <section className="rounded-[1.75rem] border border-emerald-200 bg-emerald-50 px-6 py-5">
              <p className="text-sm font-semibold text-emerald-800">Your venue is set up.</p>
              <p className="mt-1 text-sm leading-6 text-emerald-700">
                Add more places to improve the AI guide, then share the chat URL with your guests.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link
                  href={`/venues/${venueId}/places/new`}
                  className="inline-flex min-h-9 items-center rounded-full bg-emerald-700 px-4 text-sm font-medium text-white transition hover:bg-emerald-800"
                >
                  Add more places
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

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <article className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm md:col-span-2 xl:col-span-3">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Guest chat URL</p>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="break-all font-mono text-sm text-slate-700">{guestChatUrl}</p>
                {webUrl ? <CopyUrlButton url={guestChatUrl} /> : null}
              </div>
            </article>
            <article className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Slug</p>
              <p className="mt-2 font-mono text-sm text-slate-700">{venue.slug}</p>
            </article>
            <article className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">AI tone</p>
              <p className="mt-2 text-lg font-semibold text-slate-900">
                {TONE_LABELS[aiConfig.aiTone ?? 'FRIENDLY'] ?? 'Friendly'}
              </p>
            </article>
            <article className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Active places</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{activePlacesCount}</p>
            </article>
            <article className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Center latitude</p>
              <p className="mt-2 font-mono text-sm text-slate-700">
                {formatCoordinate(venue.defaultCenterLat)}
              </p>
            </article>
            <article className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Center longitude</p>
              <p className="mt-2 font-mono text-sm text-slate-700">
                {formatCoordinate(venue.defaultCenterLng)}
              </p>
            </article>
            <article className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Featured place</p>
              <p className="mt-2 text-lg font-semibold text-slate-900">
                {featuredPlace?.name ?? 'Not selected'}
              </p>
            </article>
          </section>

          <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Guide notes</h2>
            <div className="mt-4">
              <GuideNotes notes={aiConfig.aiGuideNotes ?? null} />
            </div>
          </section>

          <section className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-6 py-5">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Places</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Review the landmarks and amenities powering the venue guide.
              </p>
            </div>

            {places.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <p className="text-lg font-medium text-slate-900">No places yet</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Add POIs, amenities, and landmarks so the public chat can answer venue questions.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-6 py-3 font-medium">Name</th>
                      <th className="px-6 py-3 font-medium">Category</th>
                      <th className="px-6 py-3 font-medium">Status</th>
                      <th className="px-6 py-3 font-medium">Coordinates</th>
                      <th className="px-6 py-3 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {places.map((place) => (
                      <tr
                        key={place.id}
                        className="border-t border-slate-200 transition-colors hover:bg-slate-50"
                      >
                        <td className="px-6 py-4 align-top">
                          <div className="font-medium text-slate-900">{place.name}</div>
                          <p className="mt-1 text-xs text-slate-500">
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
                                : 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {place.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="px-6 py-4 align-top">
                          <p className="font-mono text-xs text-slate-600">
                            {place.lat.toFixed(5)}, {place.lng.toFixed(5)}
                          </p>
                        </td>
                        <td className="px-6 py-4 text-right align-top">
                          <Link
                            href={`/venues/${place.venueId}/places/${place.id}/edit`}
                            className="inline-flex min-h-11 items-center rounded-full border border-slate-300 px-4 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
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
