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
  coveredVenues: ReadonlyArray<{ id: string; name: string; amountLabel: string | null }>
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
    classes: 'border-tk-rule bg-white text-tk-ink',
    heading: 'We are confirming your subscription',
  },
  active: {
    label: 'Active',
    symbol: '✓',
    classes: 'border-tk-rule bg-white text-tk-ink',
    heading: 'Your billing is up to date',
  },
  past_due: {
    label: 'Payment needs attention',
    symbol: '!',
    classes: 'border-tk-ember/40 bg-tk-ember-wash text-tk-ember-text',
    heading: 'Please update your payment details',
  },
  grace: {
    label: 'Grace period',
    symbol: '!',
    classes: 'border-tk-ember/40 bg-tk-ember-wash text-tk-ember-text',
    heading: 'Your account is in a payment grace period',
  },
  canceled: {
    label: 'Ending or canceled',
    symbol: '—',
    classes: 'border-tk-rule bg-white text-tk-ink',
    heading: 'Your subscription is ending',
  },
  manual: {
    label: 'Managed by Torchiko',
    symbol: '•',
    classes: 'border-tk-rule bg-white text-tk-ink',
    heading: 'Your billing arrangement is managed directly',
  },
  complimentary: {
    label: 'Complimentary access',
    symbol: '★',
    classes: 'border-tk-rule bg-white text-tk-ink',
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
      className="inline-flex min-h-11 items-center justify-center rounded-lg bg-tk-ink px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-tk-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
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
      className="rounded-xl border border-tk-rule bg-white p-6 sm:p-8"
    >
      <p role="status" className="text-sm font-medium text-tk-soft">
        Loading billing details…
      </p>
      <div className="mt-6 grid animate-pulse gap-4 sm:grid-cols-3" aria-hidden="true">
        <div className="h-24 rounded-lg bg-tk-paper" />
        <div className="h-24 rounded-lg bg-tk-paper" />
        <div className="h-24 rounded-lg bg-tk-paper" />
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
      <section className="rounded-xl border border-dashed border-tk-rule bg-white p-8 text-center">
        <p className="text-sm font-medium text-tk-soft">Billing</p>
        <h2 className="mt-2 text-xl font-semibold text-tk-ink">No billing arrangement yet</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-tk-soft">
          Torchiko will show your agreed price and secure payment link here once your arrangement is
          ready.
        </p>
        <a
          href="/support"
          className="mt-5 inline-flex min-h-11 items-center text-sm font-semibold text-tk-focus underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus"
        >
          Contact Torchiko
        </a>
      </section>
    )
  }

  const presentation = STATE_PRESENTATION[state]
  const primaryAction = billing.canRetryCheckout
    ? { label: 'Update payment details', onClick: onRetryCheckout }
    : billing.canStartCheckout
      ? { label: 'Complete payment', onClick: onStartCheckout }
      : billing.canManageBilling
        ? { label: 'Manage billing', onClick: onManageBilling }
        : null

  return (
    <section aria-labelledby="client-billing-heading" className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-tk-soft">Billing</p>
          <h2
            id="client-billing-heading"
            className="mt-1 font-portal text-[1.45rem] leading-tight text-tk-ink"
          >
            {presentation.heading}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-tk-soft">{billing.statusDetail}</p>
        </div>
        <span
          className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${presentation.classes}`}
        >
          <span aria-hidden="true">{presentation.symbol}</span>
          {presentation.label}
        </span>
      </header>

      {reconciliationWarning ? (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-semibold text-amber-950">Billing update in progress</p>
          <p className="mt-1 text-sm leading-6 text-amber-900">{reconciliationWarning}</p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-tk-rule bg-white p-5 sm:col-span-2">
          <p className="text-sm text-tk-soft">Current plan</p>
          <p className="mt-2 text-xl font-semibold text-tk-ink">{billing.planName}</p>
          <p className="mt-1 text-sm text-tk-soft">{billing.arrangementLabel}</p>
          {billing.amountLabel ? (
            <p className="mt-3 text-sm font-medium text-tk-ink">
              {billing.amountLabel}
              {billing.intervalLabel ? ` ${billing.intervalLabel}` : ''}
            </p>
          ) : null}
        </div>
        <div className="rounded-lg border border-tk-rule bg-tk-paper p-5">
          <p className="text-sm text-tk-soft">Next billing</p>
          <p className="mt-2 text-sm font-semibold text-tk-ink">
            {billing.nextBillingLabel ?? 'Not scheduled'}
          </p>
        </div>
        <div className="rounded-lg border border-tk-rule bg-tk-paper p-5">
          <p className="text-sm text-tk-soft">Paid through</p>
          <p className="mt-2 text-sm font-semibold text-tk-ink">
            {billing.paidThroughLabel ?? 'Not available'}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
        <section
          className="rounded-lg border border-tk-rule bg-white p-5"
          aria-labelledby="covered-venues-heading"
        >
          <h3 id="covered-venues-heading" className="font-semibold text-tk-ink">
            Covered venues
          </h3>
          {billing.coveredVenues.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {billing.coveredVenues.map((venue) => (
                <li
                  key={venue.id}
                  className="flex items-center justify-between gap-3 text-sm text-tk-soft"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-tk-ink" aria-hidden="true" />
                    <span className="truncate">{venue.name}</span>
                  </span>
                  {venue.amountLabel ? (
                    <span className="shrink-0 font-semibold text-tk-ink">{venue.amountLabel}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-tk-soft">No venues are currently covered.</p>
          )}
        </section>

        <section
          className="min-w-0 rounded-lg border border-tk-rule bg-white p-5"
          aria-labelledby="invoice-history-heading"
        >
          <h3 id="invoice-history-heading" className="font-semibold text-tk-ink">
            Invoices and receipts
          </h3>
          {billing.invoices.length > 0 ? (
            <ul className="mt-3 divide-y divide-tk-rule">
              {billing.invoices.map((invoice) => (
                <li
                  key={invoice.id}
                  className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-tk-ink">
                      {invoice.number ?? 'Invoice'} · {invoice.amountLabel}
                    </p>
                    <p className="mt-0.5 text-xs text-tk-soft">
                      {invoice.dateLabel} · {invoice.statusLabel}
                    </p>
                  </div>
                  {invoice.documentUrl ? (
                    <a
                      href={invoice.documentUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${invoice.number ?? 'invoice'} in a new tab`}
                      className="inline-flex min-h-11 shrink-0 items-center text-sm font-semibold text-tk-focus underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus"
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
            <p className="mt-3 text-sm text-tk-soft">No invoices or receipts are available yet.</p>
          )}
        </section>
      </div>

      {billing.addOns?.length ? (
        <section
          className="rounded-lg border border-tk-rule bg-white p-5"
          aria-labelledby="billing-add-ons-heading"
        >
          <h3 id="billing-add-ons-heading" className="font-semibold text-tk-ink">
            Interested in more?
          </h3>
          <p className="mt-1 text-sm leading-6 text-tk-soft">
            Tell our team what interests you. We will review your venue and contact you with a
            custom price before anything changes.
          </p>
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {billing.addOns.map((addOn) => (
              <li
                key={addOn.key}
                className="flex flex-col rounded-lg border border-tk-rule bg-tk-paper p-4"
              >
                <p className="font-semibold text-tk-ink">{addOn.label}</p>
                <p className="mt-1 flex-1 text-sm leading-6 text-tk-soft">{addOn.description}</p>
                <button
                  type="button"
                  disabled={addOn.interested || !onAddOnInterest}
                  onClick={() => onAddOnInterest?.(addOn.key)}
                  className="mt-4 inline-flex min-h-11 items-center justify-center self-start rounded-full border border-pf-primary px-4 py-2 text-sm font-semibold text-tk-focus hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {addOn.interested ? 'Interest recorded' : "I'm interested"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="flex flex-col gap-3 rounded-lg bg-tk-paper px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-6 text-tk-soft">
          Questions about negotiated terms? Contact Torchiko support.
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            href={billing.supportUrl}
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-primary px-5 py-2.5 text-sm font-semibold text-tk-focus transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus focus-visible:ring-offset-2"
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
      <p className="px-1 text-xs leading-5 text-tk-soft">
        Card payments are securely processed by Stripe. Torchiko absorbs processing fees; your
        displayed price is your subscription price before any applicable tax. Custom terms, refunds,
        and cancellation questions are handled by Torchiko support.{' '}
        <a
          className="font-semibold text-tk-focus underline-offset-2 hover:underline"
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
