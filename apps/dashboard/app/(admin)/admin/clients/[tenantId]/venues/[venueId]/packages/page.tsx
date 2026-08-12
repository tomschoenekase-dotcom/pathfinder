export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type PackageOperationsPageProps = {
  params: Promise<{ tenantId: string; venueId: string }>
  searchParams: Promise<{ packageId?: string; cursorAt?: string; cursorId?: string }>
}

function statusLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase()
}

export default async function PackageOperationsPage({
  params,
  searchParams,
}: PackageOperationsPageProps) {
  const [{ tenantId, venueId }, query] = await Promise.all([params, searchParams])
  const caller = await createAdminCaller()
  const cursorComplete = Boolean(query.cursorAt && query.cursorId)
  const page = await caller.admin.listVenuePackagesForReview({
    tenantId,
    venueId,
    limit: 25,
    ...(cursorComplete ? { cursorAt: query.cursorAt!, cursorId: query.cursorId! } : {}),
  })
  const selectedId = query.packageId ?? page.items[0]?.id ?? null
  const selected = selectedId
    ? await caller.admin
        .getVenuePackageForReview({ tenantId, venueId, packageId: selectedId })
        .catch(() => null)
    : null
  const base = `/admin/clients/${tenantId}/venues/${venueId}/packages`

  return (
    <div className="space-y-7">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Venue packages
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
          Review immutable deployment drafts
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Inspect the exact stored payload, validation report, and lifecycle evidence. This surface
          is read-only: approval, apply, revert, package creation, and support handoff remain in
          their separately authorized workflows.
        </p>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(16rem,0.7fr)_minmax(0,1.3fr)]">
        <section aria-labelledby="package-list-heading" className="space-y-3">
          <h3 id="package-list-heading" className="font-semibold text-pf-deep">
            Package history
          </h3>
          {page.items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-pf-light p-6 text-sm text-pf-deep/70">
              No venue-package drafts have been recorded for this venue.
            </div>
          ) : (
            <ul className="space-y-2">
              {page.items.map((pkg) => (
                <li key={pkg.id}>
                  <Link
                    href={`${base}?packageId=${encodeURIComponent(pkg.id)}`}
                    aria-current={selectedId === pkg.id ? 'page' : undefined}
                    className="block rounded-2xl border border-pf-light bg-white p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-semibold text-pf-deep">{statusLabel(pkg.status)}</span>
                      <span className="text-xs text-pf-deep/70">
                        {pkg.createdAt.toLocaleDateString()}
                      </span>
                    </span>
                    <span className="mt-2 block text-xs text-pf-deep/70">
                      Schema {pkg.schemaVersion} {' \u00b7 '} {pkg.errorCount} errors {' \u00b7 '}{' '}
                      {pkg.warningCount} warnings {' \u00b7 '} semantic scan{' '}
                      {pkg.semanticStatus.toLowerCase()}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <nav aria-label="Venue-package history pages" className="flex justify-between gap-2">
            {cursorComplete ? (
              <Link href={base} className="text-sm font-semibold text-pf-primary underline">
                Back to newest
              </Link>
            ) : (
              <span />
            )}
            {page.nextCursor ? (
              <Link
                href={`${base}?${new URLSearchParams({
                  cursorAt: page.nextCursor.createdAt,
                  cursorId: page.nextCursor.id,
                }).toString()}`}
                className="text-sm font-semibold text-pf-primary underline"
              >
                Older packages
              </Link>
            ) : null}
          </nav>
        </section>

        <section aria-labelledby="package-detail-heading" className="min-w-0 space-y-4">
          <h3 id="package-detail-heading" className="font-semibold text-pf-deep">
            Exact review evidence
          </h3>
          {!selectedId ? (
            <p className="rounded-2xl border border-dashed border-pf-light p-6 text-sm text-pf-deep/70">
              Select a package after a draft is recorded.
            </p>
          ) : !selected ? (
            <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-6">
              <h4 className="font-semibold text-rose-950">Package evidence unavailable</h4>
              <p className="mt-1 text-sm text-rose-900">
                The selected package could not be verified in this exact tenant and venue scope. No
                state was changed.
              </p>
            </div>
          ) : (
            <>
              <dl className="grid gap-3 rounded-2xl border border-pf-light bg-white p-5 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-pf-deep/70">
                    Status
                  </dt>
                  <dd className="mt-1 font-semibold text-pf-deep">
                    {statusLabel(selected.status)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-pf-deep/70">
                    Updated
                  </dt>
                  <dd className="mt-1 text-sm text-pf-deep">
                    {selected.updatedAt.toLocaleString()}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs font-semibold uppercase tracking-wider text-pf-deep/70">
                    Payload identity
                  </dt>
                  <dd className="mt-1 break-all font-mono text-xs text-pf-deep">
                    {selected.payloadHash}
                  </dd>
                </div>
              </dl>
              <div
                tabIndex={0}
                aria-label="Stored venue-package payload JSON"
                className="max-h-[32rem] overflow-auto rounded-2xl bg-slate-950 p-4 text-xs text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              >
                <pre className="min-w-max whitespace-pre-wrap break-words">
                  {JSON.stringify(selected.payload, null, 2)}
                </pre>
              </div>
              <div className="rounded-2xl border border-pf-light bg-white p-5">
                <h4 className="font-semibold text-pf-deep">Validation evidence</h4>
                <p className="mt-2 text-sm text-pf-deep/75">
                  {selected.validationReport.errors.length} errors {' \u00b7 '}{' '}
                  {selected.validationReport.warnings.length} warnings {' \u00b7 '} semantic scan{' '}
                  {selected.validationReport.semanticDuplicateScan.status.toLowerCase()}
                </p>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
