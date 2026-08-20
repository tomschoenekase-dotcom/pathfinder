export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { createAdminCaller } from '../../../../../../../lib/admin-caller'
import { VenueAvailabilityControl } from '../../../../../../../components/VenueAvailabilityControl'
import { SecondLayerEntitlementControl } from '../../../../../../../components/admin/SecondLayerEntitlementControl'

type AdminVenueDetailPageProps = {
  params: Promise<{ tenantId: string; venueId: string }>
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border-l-2 border-pf-primary/20 px-4 py-2 first:border-l-0 first:pl-0">
      <p className="text-[0.68rem] font-bold uppercase tracking-[0.15em] text-pf-deep/40">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">{value}</p>
    </div>
  )
}

function formatGuideMode(mode: string): string {
  return mode.replace(/_/g, ' ')
}

function formatItemType(place: { type: string; itemType: string | null }): string {
  return (place.itemType ?? place.type).replace(/_/g, ' ')
}

function elapsedHours(start: Date, end: Date | null): string {
  if (!end) return 'Not reached'
  const hours = Math.max(0, (end.getTime() - start.getTime()) / 3_600_000)
  return hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(hours < 10 ? 1 : 0)} hr`
}

export default async function AdminVenueDetailPage({ params }: AdminVenueDetailPageProps) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()

  let data: Awaited<
    ReturnType<Awaited<ReturnType<typeof createAdminCaller>>['admin']['getClientVenue']>
  >
  let availability: Awaited<
    ReturnType<Awaited<ReturnType<typeof createAdminCaller>>['admin']['getVenueAvailability']>
  >
  let secondLayer: Awaited<
    ReturnType<Awaited<ReturnType<typeof createAdminCaller>>['admin']['getSecondLayerEntitlement']>
  >
  try {
    const results = await Promise.all([
      caller.admin.getClientVenue({ tenantId, venueId }),
      caller.admin.getVenueAvailability({ tenantId, venueId }),
      caller.admin.getSecondLayerEntitlement({ tenantId, venueId }),
    ])
    data = results[0]
    availability = results[1]
    secondLayer = results[2]
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
    <div className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
            Venue control room
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
            Venue overview
          </h2>
          {venue.description ? (
            <p className="mt-1 max-w-2xl text-sm leading-6 text-pf-deep/55">{venue.description}</p>
          ) : (
            <p className="mt-1 text-sm text-pf-deep/55">No venue description has been added.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-pf-deep/50">
          <span
            className={`rounded-full px-3 py-1 font-bold uppercase tracking-wider ${venue.isActive ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}
          >
            {venue.isActive ? 'Live' : 'Paused'}
          </span>
          <span className="rounded-full bg-pf-surface px-3 py-1">
            {formatGuideMode(venue.guideMode)}
          </span>
          {venue.category ? <span>{venue.category}</span> : null}
        </div>
      </header>

      {!venue.isActive || places.length === 0 ? (
        <section
          className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3"
          aria-label="Venue warnings"
        >
          <p className="text-sm font-semibold text-amber-950">Guest experience needs attention</p>
          <p className="mt-0.5 text-sm text-amber-900/75">
            {!venue.isActive
              ? 'Guest access and venue-scoped processing are paused.'
              : 'This venue has no public guide items yet.'}
          </p>
        </section>
      ) : null}

      <VenueAvailabilityControl
        scope="admin"
        tenantId={tenantId}
        venueName={venue.name}
        venueId={venue.id}
        initialState={{
          isActive: availability.isActive,
          updatedAt: availability.updatedAt.toISOString(),
        }}
      />

      <SecondLayerEntitlementControl
        tenantId={tenantId}
        venueId={venueId}
        venueName={venue.name}
        initialEnabled={secondLayer.secondLayerEnabled}
        initialUpdatedAt={secondLayer.updatedAt.toISOString()}
      />

      <section
        className="grid grid-cols-2 gap-y-5 rounded-2xl border border-pf-light bg-pf-surface/45 px-5 py-4 lg:grid-cols-4"
        aria-label="Venue summary"
      >
        <StatCard label="Guide items" value={venue._count.places} />
        <StatCard label="Sessions (7d)" value={engagement7d.sessions} />
        <StatCard label="Messages (7d)" value={engagement7d.messages} />
        <StatCard
          label="Default center"
          value={
            hasCenter
              ? `${venue.defaultCenterLat!.toFixed(4)}, ${venue.defaultCenterLng!.toFixed(4)}`
              : 'Not set'
          }
        />
      </section>

      {data.support.activeRequests > 0 ? (
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-sky-200 bg-sky-50 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-sky-950">
              {data.support.activeRequests} open support request
              {data.support.activeRequests === 1 ? '' : 's'}
            </p>
            <p className="mt-1 text-sm text-sky-900/75">
              Client questions and change requests are waiting in this venue’s Support workspace.
            </p>
          </div>
          <Link
            href={`/admin/clients/${tenantId}/venues/${venueId}/support-operations`}
            className="inline-flex min-h-11 items-center rounded-xl bg-pf-deep px-4 text-sm font-semibold text-white"
          >
            Review support requests
          </Link>
        </section>
      ) : null}

      <section
        className="rounded-2xl border border-pf-light bg-pf-white p-5"
        aria-labelledby="onboarding-operations-heading"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-pf-primary">
              Remote onboarding
            </p>
            <h2
              id="onboarding-operations-heading"
              className="mt-1 text-xl font-semibold text-pf-deep"
            >
              Collection through release
            </h2>
            <p className="mt-1 text-sm text-pf-deep/55">
              Durable source, question, QA, and package evidence for this venue. Client actions
              never publish.
            </p>
          </div>
          <Link
            href={`/admin/clients/${tenantId}/venues/${venueId}/intake`}
            className="inline-flex min-h-11 items-center rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white"
          >
            Open intake review
          </Link>
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [
              'Materials',
              `${data.onboarding.materials.reviewable} reviewable · ${data.onboarding.materials.checking} checking`,
            ],
            ['Source proposals', data.onboarding.proposedSources.toString()],
            ['Open questions', data.onboarding.openQuestions.toString()],
            [
              'QA',
              `${data.onboarding.qa.status.replaceAll('_', ' ').toLowerCase()} · ${data.onboarding.qa.passed} passed · ${data.onboarding.qa.failed} failed`,
            ],
            ['Draft packages', data.onboarding.packages.draft.toString()],
            ['Approved packages', data.onboarding.packages.approved.toString()],
            ['Applied packages', data.onboarding.packages.applied.toString()],
            ['Release', data.onboarding.release.released ? 'Released' : 'Not released'],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl bg-pf-surface p-4">
              <dt className="text-xs font-bold uppercase tracking-[0.12em] text-pf-deep/45">
                {label}
              </dt>
              <dd className="mt-2 text-sm font-semibold text-pf-deep">{value}</dd>
            </div>
          ))}
        </dl>
        {data.onboarding.materials.needsAttention ||
        data.onboarding.qa.failed ||
        data.onboarding.qa.operationalIssues ? (
          <p
            className="mt-4 rounded-xl bg-amber-50 p-4 text-sm font-medium text-amber-950"
            role="status"
          >
            Needs attention: {data.onboarding.materials.needsAttention} material issue(s),{' '}
            {data.onboarding.qa.failed} QA failure(s), and {data.onboarding.qa.operationalIssues}{' '}
            operational QA issue(s).
          </p>
        ) : null}
        <nav
          aria-label="Onboarding operator workflows"
          className="mt-4 flex flex-wrap gap-3 text-sm font-semibold text-pf-primary"
        >
          <Link href={`/admin/clients/${tenantId}/venues/${venueId}/support-operations`}>
            Questions and corrections
          </Link>
          <Link href={`/admin/clients/${tenantId}/venues/${venueId}/packages`}>
            Reviewed packages
          </Link>
          <Link href={`/admin/clients/${tenantId}/venues/${venueId}/evaluations`}>QA evidence</Link>
          <Link href={`/admin/clients/${tenantId}/venues/${venueId}/deployment-manifest`}>
            Release artifact
          </Link>
        </nav>
        <div className="mt-6 border-t border-pf-light pt-5">
          <h3 className="font-semibold text-pf-deep">Timing and learning signals</h3>
          <p className="mt-1 text-sm text-pf-deep/55">
            Computed only from durable domain records—not page views or browser activity.
          </p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-pf-deep/50">Venue to first source</dt>
              <dd className="mt-1 font-semibold">
                {elapsedHours(
                  data.onboarding.metrics.venueCreatedAt,
                  data.onboarding.metrics.firstSourceAt,
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-pf-deep/50">First source to reviewed package</dt>
              <dd className="mt-1 font-semibold">
                {data.onboarding.metrics.firstSourceAt
                  ? elapsedHours(
                      data.onboarding.metrics.firstSourceAt,
                      data.onboarding.metrics.firstReviewedPackageAt,
                    )
                  : 'Not started'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-pf-deep/50">Source corrections</dt>
              <dd className="mt-1 font-semibold">{data.onboarding.metrics.correctionCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-pf-deep/50">Missing-knowledge requests</dt>
              <dd className="mt-1 font-semibold">
                {data.onboarding.metrics.missingKnowledgeRequestCount}
              </dd>
            </div>
          </dl>
          {data.onboarding.metrics.repeatedMissingKnowledge.length ? (
            <div className="mt-4 rounded-xl bg-pf-surface p-4">
              <p className="text-sm font-semibold text-pf-deep">Repeated missing knowledge</p>
              <ul className="mt-2 space-y-1 text-sm text-pf-deep/65">
                {data.onboarding.metrics.repeatedMissingKnowledge.map((item) => (
                  <li key={item.prompt}>
                    {item.prompt} · {item.count} requests
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-pf-deep">Operator workflows</h2>
          <p className="mt-1 text-sm text-pf-deep/55">
            The same tools are grouped in the workspace navigation for quick repeat access.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            {
              href: `/admin/clients/${tenantId}/venues/${venueId}/media`,
              title: 'Media lab',
              body: 'Turn a ZIP of photos, video, audio, and notes into reviewed venue JSON.',
            },
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
              className="rounded-2xl border border-pf-light bg-pf-white p-5 transition hover:border-pf-accent hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
            >
              <h2 className="text-lg font-semibold tracking-tight text-pf-deep">{item.title}</h2>
              <p className="mt-2 text-sm leading-6 text-pf-deep/60">{item.body}</p>
              <span className="mt-4 inline-flex text-sm font-semibold text-pf-primary">
                Open workflow{' '}
                <span aria-hidden="true" className="ml-1">
                  →
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-pf-deep">Guide content</h2>
            <p className="mt-1 text-sm text-pf-deep/55">
              Granular knowledge available to this venue experience.
            </p>
          </div>
          <span className="text-sm text-pf-deep/50">{places.length} total</span>
        </div>

        {places.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-pf-light bg-pf-white p-8 text-center text-sm text-pf-deep/60 shadow-sm">
            This venue has no points of interest yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-pf-light bg-pf-white">
            <table className="min-w-[44rem] w-full text-left text-sm">
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
