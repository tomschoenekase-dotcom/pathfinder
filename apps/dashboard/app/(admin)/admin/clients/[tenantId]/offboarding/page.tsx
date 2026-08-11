export const dynamic = 'force-dynamic'

import { OffboardingDraftForm } from '../../../../../../components/admin/OffboardingDraftForm'
import { OffboardingExportManifestPreview } from '../../../../../../components/admin/OffboardingExportManifestPreview'
import { createAdminCaller } from '../../../../../../lib/admin-caller'

type OffboardingPageProps = { params: Promise<{ tenantId: string }> }

function label(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function dateTime(value: Date): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

export default async function OffboardingPage({ params }: OffboardingPageProps) {
  const { tenantId } = await params
  const caller = await createAdminCaller()
  const [client, summaries] = await Promise.all([
    caller.admin.getClient({ tenantId }),
    caller.admin.listOffboardingPlans({ tenantId, limit: 25 }),
  ])
  const plans = await Promise.all(
    summaries.items.map((plan) => caller.admin.getOffboardingPlan({ tenantId, planId: plan.id })),
  )
  const venueNames = new Map(client.venues.map((venue) => [venue.id, venue.name]))

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Client governance
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
          Offboarding plans
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Review scoped planning records, revocation evidence, and export artifact metadata. This
          console cannot execute revocations, mark a plan complete, or delete data.
        </p>
        <a
          href="#export-manifest-preview"
          className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-pf-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          Preview export manifest metadata
        </a>
      </header>

      <section
        aria-labelledby="offboarding-boundary-title"
        className="rounded-2xl border border-amber-200 bg-amber-50 p-5"
      >
        <h3 id="offboarding-boundary-title" className="font-semibold text-amber-950">
          No deletion is included
        </h3>
        <p className="mt-1 text-sm leading-6 text-amber-950">
          Retention policy remains unresolved. Plans and evidence are preserved; this surface has no
          delete, revoke, execute, cancel, or complete action.
        </p>
      </section>

      <OffboardingExportManifestPreview
        tenantId={tenantId}
        venues={client.venues.map((venue) => ({ id: venue.id, name: venue.name }))}
      />

      <section
        aria-labelledby="new-offboarding-draft"
        className="rounded-2xl border border-pf-light bg-pf-surface/40 p-5 sm:p-6"
      >
        <h3 id="new-offboarding-draft" className="text-lg font-semibold text-pf-deep">
          Create a planning draft
        </h3>
        <p className="mt-1 mb-5 text-sm leading-6 text-pf-deep/75">
          A successful submission creates a REQUESTED record only.
        </p>
        <OffboardingDraftForm
          tenantId={tenantId}
          venues={client.venues.map((venue) => ({ id: venue.id, name: venue.name }))}
        />
      </section>

      <section aria-labelledby="offboarding-history" className="space-y-4">
        <div>
          <h3 id="offboarding-history" className="text-xl font-semibold text-pf-deep">
            Plan history
          </h3>
          <p className="mt-1 text-sm text-pf-deep/75">Showing up to 25 most recent plans.</p>
        </div>
        {plans.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-pf-light p-8 text-center text-sm text-pf-deep/75">
            No offboarding plans have been recorded for this client.
          </p>
        ) : (
          plans.map((plan) => (
            <article
              key={plan.id}
              className="rounded-2xl border border-pf-light bg-white p-5 sm:p-6"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="font-semibold text-pf-deep">Plan {plan.id}</h4>
                  <p className="mt-1 text-sm text-pf-deep/75">
                    Requested {dateTime(plan.requestedAt)} · {plan.venueTargets.length} target
                    {plan.venueTargets.length === 1 ? '' : 's'}
                  </p>
                </div>
                <span className="rounded-full border border-pf-light bg-pf-surface px-3 py-1 text-xs font-bold uppercase tracking-wider text-pf-deep">
                  {label(plan.status)}
                </span>
              </div>

              <div className="mt-5 grid gap-5 xl:grid-cols-2">
                <div>
                  <h5 className="text-sm font-semibold text-pf-deep">
                    Required revocation targets
                  </h5>
                  <ul className="mt-2 grid gap-1 text-sm text-pf-deep/75 sm:grid-cols-2">
                    {plan.revocationTargets.map((target) => (
                      <li key={target}>• {label(target)}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h5 className="text-sm font-semibold text-pf-deep">Requested exports</h5>
                  {plan.exportKinds.length ? (
                    <ul className="mt-2 text-sm text-pf-deep/75">
                      {plan.exportKinds.map((kind) => (
                        <li key={kind}>• {label(kind)}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-pf-deep/75">No exports requested.</p>
                  )}
                </div>
              </div>

              <div className="mt-5 space-y-3">
                {plan.venueTargets.map((target) => (
                  <div
                    key={target.id}
                    className="rounded-xl border border-pf-light bg-pf-surface/35 p-4"
                  >
                    <h5 className="font-semibold text-pf-deep">
                      {venueNames.get(target.venueId) ?? `Venue ${target.venueId}`}
                    </h5>
                    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="font-medium text-pf-deep">Revocation evidence</dt>
                        <dd className="mt-1 text-pf-deep/75">
                          {target.revocationEvidence.length
                            ? `${target.revocationEvidence.length} append-only record${target.revocationEvidence.length === 1 ? '' : 's'}`
                            : 'No evidence recorded'}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium text-pf-deep">Export artifacts</dt>
                        <dd className="mt-1 text-pf-deep/75">
                          {target.exportArtifacts.length
                            ? `${target.exportArtifacts.length} metadata record${target.exportArtifacts.length === 1 ? '' : 's'}`
                            : 'No artifact metadata recorded'}
                        </dd>
                      </div>
                    </dl>
                    {target.revocationEvidence.length ? (
                      <ul className="mt-3 space-y-2 border-t border-pf-light pt-3">
                        {target.revocationEvidence.map((evidence) => (
                          <li key={evidence.id} className="text-xs leading-5 text-pf-deep/75">
                            <span className="font-semibold text-pf-deep">
                              {label(evidence.target)} · {label(evidence.outcome)}
                            </span>{' '}
                            — evidence {evidence.evidenceReference}
                            {evidence.errorCode ? ` · error ${evidence.errorCode}` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {target.exportArtifacts.length ? (
                      <ul className="mt-3 space-y-2 border-t border-pf-light pt-3">
                        {target.exportArtifacts.map((artifact) => (
                          <li key={artifact.id} className="text-xs leading-5 text-pf-deep/75">
                            <span className="font-semibold text-pf-deep">
                              {label(artifact.kind)} · metadata recorded
                            </span>{' '}
                            — artifact {artifact.artifactReference} · SHA-256 {artifact.contentHash}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  )
}
