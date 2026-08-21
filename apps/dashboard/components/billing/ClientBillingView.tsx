'use client'

export type ClientBillingState =
  | 'loading'
  | 'empty'
  | 'pending'
  | 'active'
  | 'past_due'
  | 'grace'
  | 'canceled'
  | 'manual'
  | 'complimentary'

export type ClientBillingInvoice = {
  id: string
  number: string | null
  statusLabel: string
  amountLabel: string
  dateLabel: string
  documentUrl: string | null
}

export type ClientBillingViewModel = {
  planName: string
  arrangementLabel: string
  amountLabel: string | null
  intervalLabel: string | null
  statusDetail: string
  nextBillingLabel: string | null
  paidThroughLabel: string | null
  coveredVenues: ReadonlyArray<{ id: string; name: string }>
  invoices: ReadonlyArray<ClientBillingInvoice>
  canStartCheckout: boolean
  canRetryCheckout: boolean
  canManageBilling: boolean
  canCancel?: boolean
  cancellationPending?: boolean
  addOns?: ReadonlyArray<{
    key: string
    label: string
    description: string
    interested: boolean
  }>
  supportUrl: string
}

type ClientBillingViewProps = {
  state: ClientBillingState
  billing: ClientBillingViewModel | null
  reconciliationWarning?: string | null
  onStartCheckout?: () => void
  onRetryCheckout?: () => void
  onManageBilling?: () => void
  onRequestCancellation?: () => void
  onAddOnInterest?: (featureKey: string) => void
}

const STATE_PRESENTATION: Record<
  Exclude<ClientBillingState, 'loading' | 'empty'>,
  { label: string; symbol: string; classes: string; heading: string }
> = {
  pending: {
    label: 'Confirmation pending',
    symbol: '…',
    classes: 'border-sky-200 bg-sky-50 text-sky-900',
    heading: 'We are confirming your subscription',
  },
  active: {
    label: 'Active',
    symbol: '✓',
    classes: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    heading: 'Your billing is up to date',
  },
  past_due: {
    label: 'Payment needs attention',
    symbol: '!',
    classes: 'border-rose-200 bg-rose-50 text-rose-950',
    heading: 'Please update your payment details',
  },
  grace: {
    label: 'Grace period',
    symbol: '!',
    classes: 'border-amber-200 bg-amber-50 text-amber-950',
    heading: 'Your account is in a payment grace period',
  },
  canceled: {
    label: 'Ending or canceled',
    symbol: '—',
    classes: 'border-slate-200 bg-slate-50 text-slate-800',
    heading: 'Your subscription is ending',
  },
  manual: {
    label: 'Managed by Torchiko',
    symbol: '•',
    classes: 'border-violet-200 bg-violet-50 text-violet-950',
    heading: 'Your billing arrangement is managed directly',
  },
  complimentary: {
    label: 'Complimentary access',
    symbol: '★',
    classes: 'border-indigo-200 bg-indigo-50 text-indigo-950',
    heading: 'Complimentary access is active',
  },
}

function ActionButton({
  children,
  onClick,
}: {
  children: string
  onClick: (() => void) | undefined
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-pf-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function BillingSkeleton() {
  return (
    <section
      aria-label="Billing"
      aria-busy="true"
      className="rounded-3xl border border-pf-primary/10 bg-white p-6 shadow-sm sm:p-8"
    >
      <p role="status" className="text-sm font-medium text-pf-deep/70">
        Loading billing details…
      </p>
      <div className="mt-6 grid animate-pulse gap-4 sm:grid-cols-3" aria-hidden="true">
        <div className="h-24 rounded-2xl bg-pf-surface" />
        <div className="h-24 rounded-2xl bg-pf-surface" />
        <div className="h-24 rounded-2xl bg-pf-surface" />
      </div>
    </section>
  )
}

export function ClientBillingView({
  state,
  billing,
  reconciliationWarning = null,
  onStartCheckout,
  onRetryCheckout,
  onManageBilling,
  onRequestCancellation,
  onAddOnInterest,
}: ClientBillingViewProps) {
  if (state === 'loading') return <BillingSkeleton />

  if (state === 'empty' || !billing) {
    return (
      <section className="rounded-3xl border border-dashed border-pf-light bg-white p-8 text-center shadow-sm">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">Billing</p>
        <h2 className="mt-2 text-xl font-semibold text-pf-deep">No billing arrangement yet</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-pf-deep/65">
          Torchiko has not attached a subscription or manual billing arrangement to this account.
        </p>
        {onStartCheckout ? (
          <div className="mt-6">
            <ActionButton onClick={onStartCheckout}>Choose a plan</ActionButton>
          </div>
        ) : null}
      </section>
    )
  }

  const presentation = STATE_PRESENTATION[state]
  const primaryAction = billing.canRetryCheckout
    ? { label: 'Try payment again', onClick: onRetryCheckout }
    : billing.canStartCheckout
      ? { label: 'Complete payment', onClick: onStartCheckout }
      : billing.canManageBilling
        ? { label: 'Manage billing', onClick: onManageBilling }
        : null

  return (
    <section aria-labelledby="client-billing-heading" className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">Billing</p>
          <h2 id="client-billing-heading" className="mt-1 text-2xl font-semibold text-pf-deep">
            {presentation.heading}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/65">{billing.statusDetail}</p>
        </div>
        <span
          className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${presentation.classes}`}
        >
          <span aria-hidden="true">{presentation.symbol}</span>
          {presentation.label}
        </span>
      </header>

      {reconciliationWarning ? (
        <div role="status" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-semibold text-amber-950">Billing update in progress</p>
          <p className="mt-1 text-sm leading-6 text-amber-900">{reconciliationWarning}</p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-pf-light bg-white p-5 shadow-sm sm:col-span-2">
          <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/75">Current plan</p>
          <p className="mt-2 text-xl font-semibold text-pf-deep">{billing.planName}</p>
          <p className="mt-1 text-sm text-pf-deep/65">{billing.arrangementLabel}</p>
          {billing.amountLabel ? (
            <p className="mt-3 text-sm font-medium text-pf-deep">
              {billing.amountLabel}
              {billing.intervalLabel ? ` ${billing.intervalLabel}` : ''}
            </p>
          ) : null}
        </div>
        <div className="rounded-2xl border border-pf-light bg-pf-surface/55 p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/75">Next billing</p>
          <p className="mt-2 text-sm font-semibold text-pf-deep">
            {billing.nextBillingLabel ?? 'Not scheduled'}
          </p>
        </div>
        <div className="rounded-2xl border border-pf-light bg-pf-surface/55 p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/75">Paid through</p>
          <p className="mt-2 text-sm font-semibold text-pf-deep">
            {billing.paidThroughLabel ?? 'Not available'}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
        <section
          className="rounded-2xl border border-pf-light bg-white p-5"
          aria-labelledby="covered-venues-heading"
        >
          <h3 id="covered-venues-heading" className="font-semibold text-pf-deep">
            Covered venues
          </h3>
          {billing.coveredVenues.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {billing.coveredVenues.map((venue) => (
                <li key={venue.id} className="flex items-center gap-2 text-sm text-pf-deep/75">
                  <span className="h-2 w-2 rounded-full bg-pf-accent" aria-hidden="true" />
                  {venue.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-pf-deep/60">No venues are currently covered.</p>
          )}
        </section>

        <section
          className="min-w-0 rounded-2xl border border-pf-light bg-white p-5"
          aria-labelledby="invoice-history-heading"
        >
          <h3 id="invoice-history-heading" className="font-semibold text-pf-deep">
            Invoices and receipts
          </h3>
          {billing.invoices.length > 0 ? (
            <ul className="mt-3 divide-y divide-pf-light">
              {billing.invoices.map((invoice) => (
                <li
                  key={invoice.id}
                  className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-pf-deep">
                      {invoice.number ?? 'Invoice'} · {invoice.amountLabel}
                    </p>
                    <p className="mt-0.5 text-xs text-pf-deep/75">
                      {invoice.dateLabel} · {invoice.statusLabel}
                    </p>
                  </div>
                  {invoice.documentUrl ? (
                    <a
                      href={invoice.documentUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${invoice.number ?? 'invoice'} in a new tab`}
                      className="inline-flex min-h-11 shrink-0 items-center text-sm font-semibold text-pf-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                    >
                      View document{' '}
                      <span aria-hidden="true" className="ml-1">
                        ↗
                      </span>
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-pf-deep/60">
              No invoices or receipts are available yet.
            </p>
          )}
        </section>
      </div>

      {billing.addOns?.length ? (
        <section
          className="rounded-2xl border border-pf-light bg-white p-5"
          aria-labelledby="billing-add-ons-heading"
        >
          <h3 id="billing-add-ons-heading" className="font-semibold text-pf-deep">
            Interested in more?
          </h3>
          <p className="mt-1 text-sm leading-6 text-pf-deep/65">
            Tell our team what interests you. We will review your venue and contact you with a
            custom price before anything changes.
          </p>
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {billing.addOns.map((addOn) => (
              <li
                key={addOn.key}
                className="flex flex-col rounded-2xl border border-pf-light bg-pf-surface/40 p-4"
              >
                <p className="font-semibold text-pf-deep">{addOn.label}</p>
                <p className="mt-1 flex-1 text-sm leading-6 text-pf-deep/65">{addOn.description}</p>
                <button
                  type="button"
                  disabled={addOn.interested || !onAddOnInterest}
                  onClick={() => onAddOnInterest?.(addOn.key)}
                  className="mt-4 inline-flex min-h-11 items-center justify-center self-start rounded-full border border-pf-primary px-4 py-2 text-sm font-semibold text-pf-primary hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {addOn.interested ? 'Interest recorded' : "I'm interested"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="flex flex-col gap-3 rounded-2xl bg-pf-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-6 text-pf-deep/70">
          Questions about negotiated terms? Contact Torchiko support.
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            href={billing.supportUrl}
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-primary px-5 py-2.5 text-sm font-semibold text-pf-primary transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
          >
            Contact support
          </a>
          {primaryAction ? (
            <ActionButton onClick={primaryAction.onClick}>{primaryAction.label}</ActionButton>
          ) : null}
          {billing.canCancel || billing.cancellationPending ? (
            <button
              type="button"
              onClick={onRequestCancellation}
              disabled={billing.cancellationPending || !onRequestCancellation}
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-rose-300 px-5 py-2.5 text-sm font-semibold text-rose-800 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {billing.cancellationPending ? 'Cancellation scheduled' : 'Cancel subscription'}
            </button>
          ) : null}
        </div>
      </footer>
      <p className="px-1 text-xs leading-5 text-pf-deep/75">
        Card payments are securely processed by Stripe. Torchiko absorbs processing fees; your
        displayed price is your subscription price. Taxes are not being calculated in the current
        sandbox. Custom terms, refunds, and cancellation questions are handled by Torchiko support.{' '}
        <a
          className="font-semibold text-pf-primary underline-offset-2 hover:underline"
          href="https://torchiko.com/privacy"
          target="_blank"
          rel="noreferrer"
        >
          Privacy status
        </a>
        .
      </p>
    </section>
  )
}
