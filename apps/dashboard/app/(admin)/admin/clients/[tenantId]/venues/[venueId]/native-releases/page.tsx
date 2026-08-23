export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { NativeContentConvergenceCard } from '../../../../../../../../components/admin/NativeContentConvergenceCard'
import { NativeVenueDeploymentCreateForm } from '../../../../../../../../components/admin/NativeVenueDeploymentCreateForm'
import { NativeVenueDeploymentDetail } from '../../../../../../../../components/admin/NativeVenueDeploymentDetail'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

function code(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  if ('data' in error && error.data && typeof error.data === 'object' && 'code' in error.data)
    return typeof error.data.code === 'string' ? error.data.code : null
  return 'code' in error && typeof error.code === 'string' ? error.code : null
}

function label(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase()
}

export default async function NativeReleasesPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; venueId: string }>
  searchParams: Promise<{ releaseId?: string; cursor?: string }>
}) {
  const [{ tenantId, venueId }, query] = await Promise.all([params, searchParams])
  const caller = await createAdminCaller()
  const [page, convergence] = await Promise.all([
    caller.admin.listNativeVenueDeployments({
      tenantId,
      venueId,
      limit: 20,
      cursor: query.cursor ?? null,
    }),
    caller.admin.getNativeContentConvergence({ tenantId, venueId }).catch(() => null),
  ])
  const selectedId = query.releaseId ?? (page.items[0]?.id ? String(page.items[0].id) : null)
  let selected: Awaited<ReturnType<typeof caller.admin.getNativeVenueDeployment>> | null = null
  let selectedError: 'NOT_FOUND' | 'UNAVAILABLE' | null = null
  if (selectedId) {
    try {
      selected = await caller.admin.getNativeVenueDeployment({
        tenantId,
        venueId,
        releaseId: selectedId,
        issueLimit: 20,
      })
    } catch (error) {
      selectedError = code(error) === 'NOT_FOUND' ? 'NOT_FOUND' : 'UNAVAILABLE'
    }
  }
  const base = `/admin/clients/${tenantId}/venues/${venueId}/native-releases`

  return (
    <div className="space-y-7">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Native FULL releases
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
          Review native deployment evidence
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          NATIVE_CORE_V1 releases are separate from compatibility venue packages. Each lifecycle
          action uses the authoritative stored version and server-provided eligibility.
        </p>
      </header>

      <NativeContentConvergenceCard convergence={convergence} />

      <NativeVenueDeploymentCreateForm tenantId={tenantId} venueId={venueId} />

      <div className="grid gap-5 xl:grid-cols-[minmax(16rem,0.7fr)_minmax(0,1.3fr)]">
        <section aria-labelledby="native-history-heading" className="space-y-3">
          <h3 id="native-history-heading" className="font-semibold text-pf-deep">
            Native release history
          </h3>
          {page.items.length ? (
            <ul className="space-y-2">
              {page.items.map((release) => {
                const releaseId = String(release.id)
                return (
                  <li key={releaseId}>
                    <Link
                      href={`${base}?releaseId=${encodeURIComponent(releaseId)}`}
                      aria-current={selectedId === releaseId ? 'page' : undefined}
                      className="block rounded-2xl border border-pf-light bg-white p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="font-semibold text-pf-deep">
                          {label(String(release.status))}
                        </span>
                        <span className="text-xs text-pf-deep/70">
                          {new Date(String(release.createdAt)).toLocaleDateString()}
                        </span>
                      </span>
                      <span className="mt-2 block text-xs text-pf-deep/70">
                        {String(release.profile)}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="rounded-2xl border border-dashed border-pf-light p-6 text-sm text-pf-deep/70">
              No native FULL releases have been recorded for this venue.
            </p>
          )}
          <nav aria-label="Native release history pages" className="flex justify-between gap-2">
            {query.cursor ? (
              <Link href={base} className="text-sm font-semibold text-pf-primary underline">
                Back to newest
              </Link>
            ) : (
              <span />
            )}
            {page.nextCursor ? (
              <Link
                href={`${base}?cursor=${encodeURIComponent(page.nextCursor)}`}
                className="text-sm font-semibold text-pf-primary underline"
              >
                Older releases
              </Link>
            ) : null}
          </nav>
        </section>

        <section aria-labelledby="native-detail-heading" className="min-w-0 space-y-4">
          <h3 id="native-detail-heading" className="font-semibold text-pf-deep">
            Exact native release
          </h3>
          {!selectedId ? (
            <p className="rounded-2xl border border-dashed border-pf-light p-6 text-sm text-pf-deep/70">
              Select a release after a native FULL draft is recorded.
            </p>
          ) : selected ? (
            <NativeVenueDeploymentDetail tenantId={tenantId} venueId={venueId} release={selected} />
          ) : (
            <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-6">
              <h4 className="font-semibold text-rose-950">
                {selectedError === 'NOT_FOUND'
                  ? 'Native release no longer available'
                  : 'Native release unavailable'}
              </h4>
              <p className="mt-1 text-sm text-rose-900">
                {selectedError === 'NOT_FOUND'
                  ? 'The selected release is not available in this exact client and venue scope.'
                  : 'The selected native release could not be loaded.'}{' '}
                Lifecycle actions remain disabled. No state was changed.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
