export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { createAdminCaller } from '../../../../../../../lib/admin-caller'

type AdminVenueDetailPageProps = {
  params: Promise<{ tenantId: string; venueId: string }>
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-pf-light bg-pf-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-widest text-pf-deep/40">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-pf-deep">{value}</p>
    </div>
  )
}

function formatGuideMode(mode: string): string {
  return mode.replace(/_/g, ' ')
}

function formatItemType(place: { type: string; itemType: string | null }): string {
  return (place.itemType ?? place.type).replace(/_/g, ' ')
}

export default async function AdminVenueDetailPage({ params }: AdminVenueDetailPageProps) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()

  let data: Awaited<
    ReturnType<Awaited<ReturnType<typeof createAdminCaller>>['admin']['getClientVenue']>
  >
  try {
    data = await caller.admin.getClientVenue({ tenantId, venueId })
  } catch {
    return (
      <div className="space-y-6">
        <Link
          href={`/admin/clients/${tenantId}`}
          className="text-sm font-medium text-pf-primary hover:text-pf-accent"
        >
          ← Back to client
        </Link>
        <div className="rounded-3xl border border-pf-light bg-pf-white p-10 text-center shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight text-pf-deep">Venue not found</h1>
          <p className="mt-2 text-sm text-pf-deep/60">This venue record does not exist.</p>
        </div>
      </div>
    )
  }

  const { venue, places, engagement7d } = data
  const hasCenter = venue.defaultCenterLat != null && venue.defaultCenterLng != null

  return (
    <div className="space-y-10">
      <Link
        href={`/admin/clients/${tenantId}`}
        className="text-sm font-medium text-pf-primary hover:text-pf-accent"
      >
        ← Back to client
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-4xl font-semibold tracking-tight text-pf-deep">{venue.name}</h1>
          {venue.isActive ? null : (
            <span className="inline-flex rounded-full border border-pf-light bg-pf-surface px-3 py-1 text-xs font-semibold uppercase tracking-wider text-pf-deep/50">
              Inactive
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-pf-deep/50">
          <span className="rounded-full bg-pf-surface px-2 py-0.5 font-mono">{venue.slug}</span>
          <span>{formatGuideMode(venue.guideMode)}</span>
          {venue.category ? <span>{venue.category}</span> : null}
          {venue.aiGuideName ? <span>Guide: {venue.aiGuideName}</span> : null}
          {venue.aiTone ? <span>Tone: {venue.aiTone}</span> : null}
        </div>
        {venue.description ? (
          <p className="max-w-2xl text-sm leading-6 text-pf-deep/60">{venue.description}</p>
        ) : null}
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Points of interest" value={venue._count.places} />
        <StatCard label="Sessions (7d)" value={engagement7d.sessions} />
        <StatCard label="Messages (7d)" value={engagement7d.messages} />
        <StatCard
          label="Default center"
          value={
            hasCenter
              ? `${venue.defaultCenterLat!.toFixed(4)}, ${venue.defaultCenterLng!.toFixed(4)}`
              : '—'
          }
        />
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {[
          {
            href: `/admin/clients/${tenantId}/venues/${venueId}/chatlogs`,
            title: 'Chatlog review',
            body: 'Browse transcripts, captured answers, notable flags, and private notes.',
          },
          {
            href: `/admin/clients/${tenantId}/venues/${venueId}/analysis`,
            title: 'Answer analysis',
            body: 'Generate AI summaries from collected visitor answers.',
          },
          {
            href: `/admin/clients/${tenantId}/venues/${venueId}/reports`,
            title: 'Reports',
            body: 'Draft, edit, and publish client-facing reports for any date range.',
          },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-2xl border border-pf-light bg-pf-white p-5 shadow-sm transition hover:border-pf-accent"
          >
            <h2 className="text-lg font-semibold tracking-tight text-pf-deep">{item.title}</h2>
            <p className="mt-2 text-sm leading-6 text-pf-deep/60">{item.body}</p>
            <span className="mt-4 inline-flex text-sm font-medium text-pf-primary">Open</span>
          </Link>
        ))}
      </section>

      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Points of interest</h2>
          <span className="text-sm text-pf-deep/50">{places.length} total</span>
        </div>

        {places.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-pf-light bg-pf-white p-8 text-center text-sm text-pf-deep/60 shadow-sm">
            This venue has no points of interest yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-pf-light bg-pf-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-pf-light text-xs uppercase tracking-wider text-pf-deep/40">
                <tr>
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Type</th>
                  <th className="px-4 py-3 font-semibold">Area</th>
                  <th className="px-4 py-3 font-semibold">Coords</th>
                  <th className="px-4 py-3 font-semibold">Score</th>
                </tr>
              </thead>
              <tbody>
                {places.map((place) => (
                  <tr key={place.id} className="border-b border-pf-light/60 last:border-0">
                    <td className="px-4 py-3 text-pf-deep">
                      {place.name}
                      {place.isActive ? null : (
                        <span className="ml-2 text-xs text-pf-deep/40">(inactive)</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-pf-deep/70">{formatItemType(place)}</td>
                    <td className="px-4 py-3 text-pf-deep/70">{place.areaName ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-pf-deep/50">
                      {place.lat != null && place.lng != null
                        ? `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-pf-deep/70">{place.importanceScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
