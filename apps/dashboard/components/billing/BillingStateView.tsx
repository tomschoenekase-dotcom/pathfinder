'use client'

import type { ReactNode } from 'react'

import type { ClientBillingStateData, ClientBillingViewState } from '../../lib/client-billing-state'
import { formatMinorUnits } from '../../lib/money'

type Tone = 'neutral' | 'attention' | 'quiet'

type Copy = { label: string; heading: string; body: string; tone: Tone }

const dateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})
const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const day = (value: Date | string | null | undefined) =>
  value ? dateFormat.format(new Date(value)) : null

const STATE_COPY: Record<Exclude<ClientBillingStateData['state'], 'error'>, Copy> = {
  no_setup: {
    label: 'Not set up',
    heading: 'Your Torchiko team has not set up billing yet',
    body: 'Nothing is due. When your arrangement is ready, your price and any payment steps will appear here.',
    tone: 'quiet',
  },
  complimentary: {
    label: 'Complimentary',
    heading: 'Your access is complimentary',
    body: 'Torchiko is providing your service at no charge. Nothing is due.',
    tone: 'neutral',
  },
  pilot: {
    label: 'Pilot',
    heading: 'You are on a Torchiko pilot',
    body: 'Your pilot runs for a set period. Torchiko will talk with you about next steps before it ends.',
    tone: 'neutral',
  },
  manual: {
    label: 'Managed by Torchiko',
    heading: 'Your billing is arranged directly with Torchiko',
    body: 'Invoices for your arrangement are handled by your Torchiko team, outside the online payment system.',
    tone: 'neutral',
  },
  no_subscription: {
    label: 'No subscription',
    heading: 'There is no subscription to pay yet',
    body: 'An arrangement exists but no payment has been requested. Nothing is due right now.',
    tone: 'quiet',
  },
  checkout_pending: {
    label: 'Payment to complete',
    heading: 'Your subscription is waiting for payment',
    body: 'Your subscription starts once your first payment is confirmed. Returning from the payment page does not activate it by itself.',
    tone: 'attention',
  },
  active: {
    label: 'Active',
    heading: 'Your subscription is active',
    body: 'Your billing is up to date.',
    tone: 'neutral',
  },
  invoice_open: {
    label: 'Invoice open',
    heading: 'You have an open invoice',
    body: 'An invoice for your subscription has been issued and is not yet paid.',
    tone: 'attention',
  },
  past_due: {
    label: 'Payment needs attention',
    heading: 'Your latest payment did not go through',
    body: 'Please update your payment details so your service is not interrupted.',
    tone: 'attention',
  },
  grace: {
    label: 'Grace period',
    heading: 'Your account is in a payment grace period',
    body: 'Your service continues for now. Please resolve the outstanding payment before the grace period ends.',
    tone: 'attention',
  },
  cancel_at_period_end: {
    label: 'Ending',
    heading: 'Your subscription will end at the close of this period',
    body: 'You keep full access until the paid period ends. Contact us if you would like to continue.',
    tone: 'neutral',
  },
  cancelled: {
    label: 'Ended',
    heading: 'Your subscription has ended',
    body: 'Contact your Torchiko team if you would like to restart or have a question about your account.',
    tone: 'neutral',
  },
  provider_sync_pending: {
    label: 'Confirming',
    heading: 'We are confirming your billing details',
    body: 'Torchiko is waiting for the payment provider to confirm your latest status. We do not grant or remove access from a redirect alone.',
    tone: 'attention',
  },
}

const toneClass: Record<Tone, string> = {
  neutral: 'border-tk-rule bg-tk-card',
  quiet: 'border-dashed border-tk-rule bg-tk-card',
  attention: 'border-tk-ember/40 bg-tk-ember-wash',
}

const actionButton =
  'inline-flex min-h-11 items-center justify-center rounded-lg bg-tk-ink px-4 text-sm font-semibold text-white transition-colors hover:bg-tk-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-55'
const secondaryAction =
  'inline-flex min-h-11 items-center justify-center rounded-lg border border-tk-rule-strong bg-tk-card px-4 text-sm font-semibold text-tk-ink hover:border-tk-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus focus-visible:ring-offset-2'

function Shell({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section aria-label={label} className="rounded-xl border border-tk-rule bg-tk-card p-5 sm:p-6">
      {children}
    </section>
  )
}

export type BillingStateViewProps = {
  view: ClientBillingViewState
  busy?: boolean
  onRetry?: () => void
  onCheckout?: () => void
  onManageBilling?: () => void
  onRequestCancellation?: () => void
}

export function BillingStateView({
  view,
  busy = false,
  onRetry,
  onCheckout,
  onManageBilling,
  onRequestCancellation,
}: BillingStateViewProps) {
  if (view.status === 'loading') {
    return (
      <section
        aria-label="Billing"
        aria-busy="true"
        className="rounded-xl border border-tk-rule bg-tk-card p-6 sm:p-8"
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

  if (view.status === 'forbidden') {
    return (
      <Shell label="Billing">
        <h2 className="font-portal text-[1.45rem] leading-tight text-tk-ink">
          Billing is visible to managers and owners
        </h2>
        <p className="mt-2 max-w-prose text-sm leading-6 text-tk-soft">
          Your role does not include billing details. This is not a payment problem. Ask an owner or
          manager of your organization, or contact Torchiko support.
        </p>
        <a href="/support" className={`${secondaryAction} mt-5`}>
          Contact Torchiko
        </a>
      </Shell>
    )
  }

  if (view.status === 'error' || view.data.state === 'error') {
    const kind = view.status === 'error' ? view.kind : (view.data.errorKind ?? 'retrieval')
    const confirmed = view.status === 'error' ? view.lastConfirmedAt : null
    return (
      <Shell label="Billing">
        <h2 className="font-portal text-[1.45rem] leading-tight text-tk-ink">
          We could not load your billing status
        </h2>
        <p role="alert" className="mt-2 max-w-prose text-sm leading-6 text-tk-soft">
          {kind === 'configuration'
            ? 'Billing is not configured correctly on our side. '
            : 'The request did not complete. '}
          This does not mean you owe anything, and it does not change your subscription. Try again,
          or contact Torchiko support if it continues.
        </p>
        {confirmed ? (
          <p className="mt-2 text-xs text-tk-soft">
            Last confirmed update: {dateTimeFormat.format(confirmed)}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-3">
          {onRetry ? (
            <button type="button" onClick={onRetry} className={actionButton}>
              Try again
            </button>
          ) : null}
          <a href="/support" className={secondaryAction}>
            Contact Torchiko
          </a>
        </div>
      </Shell>
    )
  }

  const data = view.data
  const copy = STATE_COPY[data.state as Exclude<typeof data.state, 'error'>]
  const period = data.period
  const price = data.plan?.price
  const cadence = data.plan
    ? data.plan.intervalCount > 1
      ? `every ${data.plan.intervalCount} ${data.plan.interval}s`
      : `per ${data.plan.interval}`
    : null
  const hasDetails = data.plan !== null

  const pilotLine =
    data.state === 'pilot' && period?.accessEndsAt
      ? period.expired
        ? `Your pilot ended on ${day(period.accessEndsAt)}. Please contact us about next steps.`
        : `Your pilot runs until ${day(period.accessEndsAt)}.`
      : null
  const graceLine =
    data.state === 'grace' && period?.graceEndsAt
      ? `Grace period ends ${day(period.graceEndsAt)}.`
      : null
  const endLine =
    data.state === 'cancel_at_period_end' && (period?.currentPeriodEndsAt ?? period?.accessEndsAt)
      ? `Access continues until ${day(period.currentPeriodEndsAt ?? period.accessEndsAt)}.`
      : data.state === 'cancelled' && period?.accessEndsAt
        ? `Access ended ${day(period.accessEndsAt)}.`
        : null

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="billing-state-heading"
        className={`rounded-xl border p-5 sm:p-6 ${toneClass[copy.tone]}`}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2
              id="billing-state-heading"
              className="font-portal text-[1.45rem] leading-tight text-tk-ink"
            >
              {copy.heading}
            </h2>
            <p className="mt-2 max-w-prose text-sm leading-6 text-tk-soft">{copy.body}</p>
            {[pilotLine, graceLine, endLine].filter(Boolean).map((line) => (
              <p key={line} className="mt-2 text-sm font-medium text-tk-ink">
                {line}
              </p>
            ))}
          </div>
          <span
            data-testid="billing-state-label"
            className="inline-flex w-fit shrink-0 items-center rounded-full border border-tk-rule-strong bg-white px-3 py-1.5 text-xs font-bold text-tk-ink"
          >
            {copy.label}
          </span>
        </div>

        {data.amountDue ? (
          <p className="mt-4 text-sm text-tk-ink">
            Amount due:{' '}
            <strong>{formatMinorUnits(data.amountDue.amountMinor, data.amountDue.currency)}</strong>
            {data.amountDue.dueAt ? ` by ${day(data.amountDue.dueAt)}` : ''}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {data.actions.canStartCheckout && onCheckout ? (
            <button type="button" onClick={onCheckout} disabled={busy} className={actionButton}>
              Complete payment
            </button>
          ) : null}
          {data.actions.canManageBilling && onManageBilling ? (
            <button
              type="button"
              onClick={onManageBilling}
              disabled={busy}
              className={actionButton}
            >
              {data.nextAction === 'update_payment' ? 'Update payment details' : 'Manage billing'}
            </button>
          ) : null}
          {data.nextAction === 'contact_support' || data.nextAction === 'update_payment' ? (
            <a href="/support" className={secondaryAction}>
              Contact Torchiko
            </a>
          ) : null}
          {data.actions.canCancel && onRequestCancellation ? (
            <button
              type="button"
              onClick={onRequestCancellation}
              disabled={busy}
              className={secondaryAction}
            >
              Cancel subscription
            </button>
          ) : null}
          {data.nextAction === 'wait' && onRetry ? (
            <button type="button" onClick={onRetry} disabled={busy} className={secondaryAction}>
              Check again
            </button>
          ) : null}
        </div>

        <p className="mt-4 text-xs text-tk-soft" data-testid="billing-last-update">
          {data.lastReliableUpdateAt
            ? `Last confirmed with the payment provider: ${dateTimeFormat.format(data.lastReliableUpdateAt)}`
            : 'No payment-provider update has been recorded for this account.'}
          {' · '}Checked {dateTimeFormat.format(data.asOf)}
        </p>
        {data.syncHealth === 'STALE' ? (
          <p role="status" className="mt-2 text-xs font-medium text-tk-ember-text">
            Provider confirmation is overdue; what you see may be slightly behind.
          </p>
        ) : null}
      </section>

      {hasDetails ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-tk-rule bg-tk-card p-5 sm:col-span-1">
            <p className="text-sm text-tk-soft">Plan</p>
            <p className="mt-2 text-lg font-semibold text-tk-ink">{data.plan?.name}</p>
            {price ? (
              <p className="mt-1 text-sm text-tk-ink">
                {formatMinorUnits(price.amountMinor, price.currency)} {cadence}
              </p>
            ) : (
              <p className="mt-1 text-sm text-tk-soft">Price not recorded</p>
            )}
          </div>
          <div className="rounded-lg border border-tk-rule bg-tk-paper p-5">
            <p className="text-sm text-tk-soft">Current period ends</p>
            <p className="mt-2 text-sm font-semibold text-tk-ink">
              {day(period?.currentPeriodEndsAt) ?? 'Not scheduled'}
            </p>
          </div>
          <div className="rounded-lg border border-tk-rule bg-tk-paper p-5">
            <p className="text-sm text-tk-soft">Paid through</p>
            <p className="mt-2 text-sm font-semibold text-tk-ink">
              {day(period?.paidThroughAt) ?? 'Not available'}
            </p>
          </div>
        </div>
      ) : null}

      {hasDetails ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <section
            className="rounded-lg border border-tk-rule bg-tk-card p-5"
            aria-labelledby="billing-venues-heading"
          >
            <h3 id="billing-venues-heading" className="font-semibold text-tk-ink">
              Covered venues
            </h3>
            {data.coveredVenues.length > 0 ? (
              <ul className="mt-3 space-y-2 text-sm text-tk-soft">
                {data.coveredVenues.map((venue) => (
                  <li key={venue.id} className="truncate">
                    {venue.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-tk-soft">No venues are currently covered.</p>
            )}
          </section>
          <section
            className="min-w-0 rounded-lg border border-tk-rule bg-tk-card p-5"
            aria-labelledby="billing-invoices-heading"
          >
            <h3 id="billing-invoices-heading" className="font-semibold text-tk-ink">
              Invoices and receipts
            </h3>
            {data.invoices.length > 0 ? (
              <ul className="mt-3 divide-y divide-tk-rule">
                {data.invoices.map((invoice) => (
                  <li
                    key={invoice.id}
                    className="flex flex-col gap-1 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-tk-ink">
                        {invoice.number ?? 'Invoice'} ·{' '}
                        {formatMinorUnits(
                          invoice.amountDue.amountMinor,
                          invoice.amountDue.currency,
                        )}
                      </p>
                      <p className="text-xs text-tk-soft">
                        {day(invoice.date)} · {invoice.status.toLowerCase()}
                      </p>
                    </div>
                    {invoice.url ? (
                      <a
                        href={invoice.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-11 items-center text-sm font-semibold text-tk-focus underline-offset-4 hover:underline"
                      >
                        View document
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-tk-soft">
                No invoices or receipts are available yet.
              </p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}
