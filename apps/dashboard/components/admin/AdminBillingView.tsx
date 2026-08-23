'use client'

export type AdminBillingState =
  | 'loading'
  | 'empty'
  | 'pending'
  | 'active'
  | 'past_due'
  | 'grace'
  | 'canceled'
  | 'manual'
  | 'complimentary'

export type AdminBillingViewModel = {
  tenant: { id: string; name: string }
  billingModeLabel: string
  planName: string
  amountLabel: string | null
  intervalLabel: string | null
  subscriptionStatusLabel: string
  entitlementStatusLabel: string
  statusDetail: string
  currentPeriodLabel: string | null
  renewalOrCancellationLabel: string | null
  minimumCommitmentLabel: string | null
  coveredVenues: ReadonlyArray<{
    id: string
    name: string
    coverageLabel: string
    amountLabel: string | null
  }>
  provider: {
    customerId: string | null
    customerDashboardUrl: string | null
    subscriptionId: string | null
    subscriptionDashboardUrl: string | null
  }
  invoices: ReadonlyArray<{
    id: string
    number: string | null
    statusLabel: string
    amountLabel: string
    dateLabel: string
    failureSummary: string | null
    documentUrl: string | null
  }>
  override: { label: string; reason: string; expiresLabel: string } | null
  reconciliation: {
    statusLabel: string
    lastCheckedLabel: string | null
    detail: string
    warning: boolean
  }
  timeline: ReadonlyArray<{
    id: string
    occurredAtLabel: string
    title: string
    detail: string
    actorLabel: string
  }>
  recoveryActions: ReadonlyArray<{
    id: string
    label: string
    description: string
    disabled?: boolean
    destructive?: boolean
  }>
}

type AdminBillingViewProps = {
  state: AdminBillingState
  billing: AdminBillingViewModel | null
  onAction?: (actionId: string) => void
}

const STATUS_STYLES: Record<Exclude<AdminBillingState, 'loading' | 'empty'>, string> = {
  pending: 'border-sky-200 bg-sky-50 text-sky-900',
  active: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  past_due: 'border-rose-200 bg-rose-50 text-rose-950',
  grace: 'border-amber-200 bg-amber-50 text-amber-950',
  canceled: 'border-slate-200 bg-slate-50 text-slate-800',
  manual: 'border-violet-200 bg-violet-50 text-violet-950',
  complimentary: 'border-indigo-200 bg-indigo-50 text-indigo-950',
}

function Definition({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0 border-l-2 border-pf-primary/15 pl-3">
      <dt className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-pf-deep/75">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm font-semibold text-pf-deep">{value ?? 'Not set'}</dd>
    </div>
  )
}

function ProviderIdentifier({
  label,
  value,
  dashboardUrl,
}: {
  label: string
  value: string | null
  dashboardUrl: string | null
}) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/75">{label}</p>
      {value ? (
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <code className="max-w-full break-all rounded-lg bg-pf-surface px-2 py-1 text-xs text-pf-deep">
            {value}
          </code>
          {dashboardUrl ? (
            <a
              href={dashboardUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${label} in Stripe Dashboard in a new tab`}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-pf-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
            >
              Open in Stripe{' '}
              <span aria-hidden="true" className="ml-1">
                ↗
              </span>
            </a>
          ) : null}
        </div>
      ) : (
        <p className="mt-1 text-sm text-pf-deep/75">Not linked</p>
      )}
    </div>
  )
}

export function AdminBillingView({ state, billing, onAction }: AdminBillingViewProps) {
  if (state === 'loading') {
    return (
      <section
        aria-label="Client billing operations"
        aria-busy="true"
        className="rounded-2xl border border-pf-light bg-white p-6"
      >
        <p role="status" className="text-sm font-medium text-pf-deep/70">
          Loading billing operations…
        </p>
        <div className="mt-5 h-36 animate-pulse rounded-2xl bg-pf-surface" aria-hidden="true" />
      </section>
    )
  }

  if (state === 'empty' || !billing) {
    return (
      <section className="rounded-2xl border border-dashed border-pf-light bg-white p-8 text-center">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Billing operations
        </p>
        <h2 className="mt-2 text-xl font-semibold text-pf-deep">No billing account</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-pf-deep/65">
          Create an explicit billing arrangement before granting paid access or starting Checkout.
        </p>
      </section>
    )
  }

  return (
    <section aria-labelledby="admin-billing-heading" className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
            Billing operations
          </p>
          <h2 id="admin-billing-heading" className="mt-1 text-2xl font-semibold text-pf-deep">
            {billing.tenant.name}
          </h2>
          <p className="mt-1 text-sm leading-6 text-pf-deep/65">{billing.statusDetail}</p>
        </div>
        <span
          className={`inline-flex w-fit rounded-full border px-3 py-1.5 text-xs font-bold ${STATUS_STYLES[state]}`}
        >
          Status: {billing.subscriptionStatusLabel}
        </span>
      </header>

      {billing.reconciliation.warning ? (
        <div role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <p className="font-semibold text-amber-950">Reconciliation warning</p>
          <p className="mt-1 text-sm leading-6 text-amber-900">{billing.reconciliation.detail}</p>
          <p className="mt-2 text-xs font-medium text-amber-950">
            Last checked: {billing.reconciliation.lastCheckedLabel ?? 'Never'}
          </p>
        </div>
      ) : null}

      <dl className="grid gap-4 rounded-2xl border border-pf-light bg-pf-surface/45 p-5 sm:grid-cols-2 xl:grid-cols-4">
        <Definition label="Billing mode" value={billing.billingModeLabel} />
        <Definition label="Internal plan" value={billing.planName} />
        <Definition label="Entitlements" value={billing.entitlementStatusLabel} />
        <Definition
          label="Commercial amount"
          value={
            billing.amountLabel
              ? `${billing.amountLabel}${billing.intervalLabel ? ` ${billing.intervalLabel}` : ''}`
              : null
          }
        />
        <Definition label="Current period" value={billing.currentPeriodLabel} />
        <Definition label="Renewal / cancellation" value={billing.renewalOrCancellationLabel} />
        <Definition label="Minimum commitment" value={billing.minimumCommitmentLabel} />
        <Definition label="Reconciliation" value={billing.reconciliation.statusLabel} />
      </dl>

      <div className="grid gap-6 xl:grid-cols-2">
        <section
          className="rounded-2xl border border-pf-light bg-white p-5"
          aria-labelledby="provider-links-heading"
        >
          <h3 id="provider-links-heading" className="font-semibold text-pf-deep">
            Provider links
          </h3>
          <div className="mt-4 space-y-5">
            <ProviderIdentifier
              label="Stripe customer"
              value={billing.provider.customerId}
              dashboardUrl={billing.provider.customerDashboardUrl}
            />
            <ProviderIdentifier
              label="Stripe subscription"
              value={billing.provider.subscriptionId}
              dashboardUrl={billing.provider.subscriptionDashboardUrl}
            />
          </div>
        </section>

        <section
          className="rounded-2xl border border-pf-light bg-white p-5"
          aria-labelledby="coverage-heading"
        >
          <h3 id="coverage-heading" className="font-semibold text-pf-deep">
            Venue coverage
          </h3>
          {billing.coveredVenues.length ? (
            <ul className="mt-3 divide-y divide-pf-light">
              {billing.coveredVenues.map((venue) => (
                <li
                  key={venue.id}
                  className="flex items-center justify-between gap-4 py-3 first:pt-0"
                >
                  <span className="text-sm font-medium text-pf-deep">{venue.name}</span>
                  <span className="text-right text-xs font-semibold text-pf-deep/75">
                    {venue.amountLabel ? `${venue.amountLabel} · ` : ''}
                    {venue.coverageLabel}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-pf-deep/75">
              No venues are covered by this arrangement.
            </p>
          )}
        </section>
      </div>

      {billing.override ? (
        <section
          className="rounded-2xl border border-violet-200 bg-violet-50 p-5"
          aria-labelledby="override-heading"
        >
          <h3 id="override-heading" className="font-semibold text-violet-950">
            Active manual override
          </h3>
          <p className="mt-2 text-sm font-semibold text-violet-950">{billing.override.label}</p>
          <p className="mt-1 text-sm leading-6 text-violet-900">
            Reason: {billing.override.reason}
          </p>
          <p className="mt-1 text-xs font-medium text-violet-950">
            Expires: {billing.override.expiresLabel}
          </p>
        </section>
      ) : null}

      <section
        className="rounded-2xl border border-pf-light bg-white p-5"
        aria-labelledby="admin-invoices-heading"
      >
        <h3 id="admin-invoices-heading" className="font-semibold text-pf-deep">
          Invoices and payment health
        </h3>
        {billing.invoices.length ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <thead>
                <tr className="border-b border-pf-light text-xs uppercase tracking-wider text-pf-deep/75">
                  <th scope="col" className="pb-3 pr-4 font-semibold">
                    Invoice
                  </th>
                  <th scope="col" className="pb-3 pr-4 font-semibold">
                    Date
                  </th>
                  <th scope="col" className="pb-3 pr-4 font-semibold">
                    Amount
                  </th>
                  <th scope="col" className="pb-3 pr-4 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="pb-3 font-semibold">
                    Document
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-pf-light">
                {billing.invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="py-3 pr-4 align-top font-semibold text-pf-deep">
                      {invoice.number ?? invoice.id}
                      {invoice.failureSummary ? (
                        <span className="mt-1 block max-w-sm text-xs font-normal leading-5 text-rose-700">
                          {invoice.failureSummary}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-3 pr-4 align-top text-pf-deep/70">{invoice.dateLabel}</td>
                    <td className="py-3 pr-4 align-top text-pf-deep/70">{invoice.amountLabel}</td>
                    <td className="py-3 pr-4 align-top font-medium text-pf-deep">
                      {invoice.statusLabel}
                    </td>
                    <td className="py-3 align-top">
                      {invoice.documentUrl ? (
                        <a
                          href={invoice.documentUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open ${invoice.number ?? 'invoice'} in a new tab`}
                          className="inline-flex min-h-11 items-center font-semibold text-pf-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                        >
                          Open{' '}
                          <span aria-hidden="true" className="ml-1">
                            ↗
                          </span>
                        </a>
                      ) : (
                        <span className="text-pf-deep/75">Unavailable</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-pf-deep/75">No invoice projections are available.</p>
        )}
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section
          className="rounded-2xl border border-pf-light bg-white p-5"
          aria-labelledby="recovery-actions-heading"
        >
          <h3 id="recovery-actions-heading" className="font-semibold text-pf-deep">
            Recovery actions
          </h3>
          {billing.recoveryActions.length ? (
            <ul className="mt-3 space-y-3">
              {billing.recoveryActions.map((action) => (
                <li key={action.id} className="rounded-xl border border-pf-light p-4">
                  <p className="text-sm leading-6 text-pf-deep/65">{action.description}</p>
                  <button
                    type="button"
                    disabled={action.disabled || !onAction}
                    onClick={() => onAction?.(action.id)}
                    className={`mt-3 inline-flex min-h-11 items-center justify-center rounded-full border px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${action.destructive ? 'border-rose-300 text-rose-800 hover:bg-rose-50' : 'border-pf-primary text-pf-primary hover:bg-pf-surface'}`}
                  >
                    {action.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-pf-deep/75">
              No recovery action is currently recommended.
            </p>
          )}
        </section>

        <section
          className="rounded-2xl border border-pf-light bg-white p-5"
          aria-labelledby="billing-timeline-heading"
        >
          <h3 id="billing-timeline-heading" className="font-semibold text-pf-deep">
            Billing audit timeline
          </h3>
          {billing.timeline.length ? (
            <ol className="mt-4 space-y-4 border-l border-pf-light pl-5">
              {billing.timeline.map((event) => (
                <li key={event.id} className="relative">
                  <span
                    className="absolute -left-[1.45rem] top-1.5 h-2 w-2 rounded-full bg-pf-primary ring-4 ring-white"
                    aria-hidden="true"
                  />
                  <p className="text-sm font-semibold text-pf-deep">{event.title}</p>
                  <p className="mt-1 text-sm leading-6 text-pf-deep/65">{event.detail}</p>
                  <p className="mt-1 text-xs text-pf-deep/75">
                    {event.occurredAtLabel} · {event.actorLabel}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-pf-deep/75">No billing events have been recorded.</p>
          )}
        </section>
      </div>
    </section>
  )
}
