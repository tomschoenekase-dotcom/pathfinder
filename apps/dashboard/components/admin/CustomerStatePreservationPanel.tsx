import type { CustomerStatePreservationContext } from '@pathfinder/contracts/customer-state-preservation'

type CustomerStatePreservationPanelProps = {
  context: CustomerStatePreservationContext
}

const STATE_LABELS: Record<
  CustomerStatePreservationContext['venues'][number]['reviewState'],
  string
> = {
  ACTIVE_SERVICE: 'Active service',
  PRESERVED_STATE: 'Preserved state',
  RESTORATION_REVIEW: 'Restoration review',
  OFFBOARDING_REVIEW: 'Offboarding review',
  LIMITED_EVIDENCE: 'Limited evidence',
}

function dateTime(value: Date): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

export function CustomerStatePreservationPanel({ context }: CustomerStatePreservationPanelProps) {
  return (
    <section
      aria-labelledby="customer-state-preservation-title"
      className="rounded-2xl border border-pf-light bg-white p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
            Return-path evidence
          </p>
          <h3
            id="customer-state-preservation-title"
            className="mt-1 text-xl font-semibold text-pf-deep"
          >
            Preserved customer state
          </h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
            Review what remains available before any seasonal return or reactivation decision.
            Historical offboarding evidence stays visible without overriding current active state.
          </p>
        </div>
        <span className="rounded-full border border-pf-light bg-pf-surface px-3 py-1 text-xs font-bold uppercase tracking-wider text-pf-deep">
          {context.summary.venueCount} venue{context.summary.venueCount === 1 ? '' : 's'}
        </span>
      </div>

      <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
        <p className="font-semibold">Human review remains required</p>
        <p className="mt-1">
          No automatic reactivation or customer contact is authorized. Retention, pause fees, and
          reactivation fees remain unresolved.
        </p>
      </div>

      {context.evidenceBounded ? (
        <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
          Historical plan evidence exceeded this bounded view. Review the full plan history before
          deciding.
        </p>
      ) : null}

      {context.venues.length === 0 ? (
        <p className="mt-5 rounded-xl border border-dashed border-pf-light p-6 text-center text-sm text-pf-deep/75">
          No venue state is available for reactivation review.
        </p>
      ) : (
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          {context.venues.map((venue) => (
            <article key={venue.venueId} className="rounded-xl border border-pf-light p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="font-semibold text-pf-deep">{venue.venueName}</h4>
                  <p className="mt-1 text-sm text-pf-deep/70">
                    {venue.operationalMaterialPreserved
                      ? 'Operational material is preserved.'
                      : 'Only the venue record is currently evidenced.'}
                  </p>
                </div>
                <span className="rounded-full bg-pf-surface px-3 py-1 text-xs font-bold uppercase tracking-wider text-pf-deep">
                  {STATE_LABELS[venue.reviewState]}
                </span>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-pf-deep/65">Places</dt>
                  <dd className="font-semibold text-pf-deep">{venue.material.placeRecordCount}</dd>
                </div>
                <div>
                  <dt className="text-pf-deep/65">Knowledge</dt>
                  <dd className="font-semibold text-pf-deep">
                    {venue.material.knowledgeRecordCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-pf-deep/65">Packages</dt>
                  <dd className="font-semibold text-pf-deep">
                    {venue.material.packageRecordCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-pf-deep/65">Manifests</dt>
                  <dd className="font-semibold text-pf-deep">
                    {venue.material.manifestRecordCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-pf-deep/65">Bot configuration</dt>
                  <dd className="font-semibold text-pf-deep">
                    {venue.material.botConfigurationRecordPreserved ? 'Preserved' : 'Not recorded'}
                  </dd>
                </div>
                <div>
                  <dt className="text-pf-deep/65">Export records</dt>
                  <dd className="font-semibold text-pf-deep">
                    {venue.material.exportArtifactCount}
                  </dd>
                </div>
              </dl>

              {venue.latestOffboardingPlan ? (
                <p className="mt-4 border-t border-pf-light pt-3 text-xs leading-5 text-pf-deep/70">
                  Latest retained plan:{' '}
                  {venue.latestOffboardingPlan.status.toLowerCase().replaceAll('_', ' ')} · updated{' '}
                  {dateTime(venue.latestOffboardingPlan.updatedAt)} ·{' '}
                  {venue.latestOffboardingPlan.completedRevocationCount} completed revocation record
                  {venue.latestOffboardingPlan.completedRevocationCount === 1 ? '' : 's'}
                </p>
              ) : (
                <p className="mt-4 border-t border-pf-light pt-3 text-xs text-pf-deep/70">
                  No retained offboarding plan for this venue.
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
