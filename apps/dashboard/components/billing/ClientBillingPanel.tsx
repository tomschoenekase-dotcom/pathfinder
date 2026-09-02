'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { type DashboardTRPCClient, useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import {
  ClientBillingView,
  type ClientBillingState,
  type ClientBillingViewModel,
} from './ClientBillingView'

type Overview = Awaited<ReturnType<DashboardTRPCClient['billing']['overview']['query']>>

const BILLING_READ_TIMEOUT_MS = 15_000

function dateLabel(value: Date | string | null | undefined) {
  return value
    ? new Date(value).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null
}

function moneyLabel(amount: bigint | number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(Number(amount) / 100)
}

function presentation(overview: Overview): {
  state: ClientBillingState
  model: ClientBillingViewModel | null
} {
  const account = overview.account
  if (!account) return { state: 'empty', model: null }
  const agreement =
    account.commercialAgreements.find((item) => item.isBase) ?? account.commercialAgreements[0]
  if (!agreement) return { state: 'empty', model: null }
  const mode = agreement.billingMode
  const state: ClientBillingState =
    mode === 'COMPLIMENTARY' || mode === 'PILOT'
      ? 'complimentary'
      : mode !== 'STRIPE_SUBSCRIPTION' && mode !== 'STRIPE_INVOICE'
        ? 'manual'
        : overview.access?.state === 'GRACE_PERIOD'
          ? 'grace'
          : overview.access?.state === 'PAID_THROUGH' || overview.access?.state === 'ENDED'
            ? 'canceled'
            : agreement.status === 'PAST_DUE' || agreement.status === 'UNPAID'
              ? 'past_due'
              : agreement.status === 'PENDING' || agreement.status === 'DRAFT'
                ? 'pending'
                : 'active'
  const catalogPlan = overview.catalog.find(
    (plan) =>
      plan.key === agreement.internalPlanKey && plan.version === agreement.internalPlanVersion,
  )
  return {
    state,
    model: {
      planName: catalogPlan?.displayName ?? agreement.internalPlanKey.replaceAll('_', ' '),
      arrangementLabel: mode.replaceAll('_', ' ').toLowerCase(),
      amountLabel:
        agreement.agreedAmountMinor === null
          ? null
          : moneyLabel(agreement.agreedAmountMinor, agreement.currency),
      intervalLabel:
        agreement.billingInterval === 'CUSTOM'
          ? null
          : `per ${agreement.billingInterval.toLowerCase()}`,
      statusDetail: overview.access?.reason ?? 'Torchiko is waiting for a durable billing update.',
      nextBillingLabel: agreement.cancelAtPeriodEnd
        ? null
        : dateLabel(agreement.currentPeriodEndsAt),
      paidThroughLabel: dateLabel(
        account.paidThroughAt ?? agreement.currentPeriodEndsAt ?? agreement.accessEndsAt,
      ),
      coveredVenues: agreement.coveredVenues.map((coverage) => ({
        ...coverage.venue,
        amountLabel:
          agreement.venuePriceBreakdownComplete && coverage.agreedAmountMinor !== null
            ? moneyLabel(coverage.agreedAmountMinor, agreement.currency)
            : null,
      })),
      invoices: account.invoiceProjections.map((invoice) => ({
        id: invoice.id,
        number: invoice.invoiceNumber,
        statusLabel: invoice.status.toLowerCase(),
        amountLabel: moneyLabel(invoice.amountDueMinor, invoice.currency),
        dateLabel:
          dateLabel(invoice.paidAt ?? invoice.dueAt ?? invoice.createdAt) ?? 'Date unavailable',
        documentUrl: invoice.invoiceDocumentUrl ?? invoice.hostedInvoiceUrl,
      })),
      canStartCheckout:
        overview.capabilities.checkout &&
        agreement.status === 'PENDING' &&
        Boolean(overview.currentCheckoutUrl),
      canRetryCheckout:
        overview.capabilities.checkout &&
        (agreement.status === 'PAST_DUE' || agreement.status === 'UNPAID'),
      canManageBilling: overview.capabilities.portal && overview.hasStripeCustomer,
      canCancel:
        overview.capabilities.cancellation &&
        Boolean(agreement.cancelAtPeriodEnd === false) &&
        Boolean(agreement.status === 'ACTIVE' || agreement.status === 'PAST_DUE'),
      cancellationPending:
        agreement.cancelAtPeriodEnd ||
        account.customerRequests.some(
          (request) =>
            request.kind === 'CANCELLATION' && ['PROCESSING', 'COMPLETED'].includes(request.status),
        ),
      addOns: overview.addOnCatalog.map((addOn) => ({
        ...addOn,
        interested: account.customerRequests.some(
          (request) =>
            request.kind === 'ADD_ON_INTEREST' &&
            request.featureKey === addOn.key &&
            ['OPEN', 'PROCESSING'].includes(request.status),
        ),
      })),
      supportUrl: '/support',
    },
  }
}

export function ClientBillingPanel() {
  const client = useTRPCClient()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedPlan, setSelectedPlan] = useState('')
  const [selectedVenues, setSelectedVenues] = useState<string[]>([])
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const cancelDialogRef = useRef<HTMLFormElement>(null)
  const cancelReasonRef = useRef<HTMLTextAreaElement>(null)
  const cancelTriggerRef = useRef<HTMLElement | null>(null)
  const loadGeneration = useRef(0)
  const loadAbort = useRef<AbortController | null>(null)

  async function load() {
    const generation = ++loadGeneration.current
    loadAbort.current?.abort()
    const controller = new AbortController()
    loadAbort.current = controller
    try {
      const next = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: BILLING_READ_TIMEOUT_MS,
        request: (signal) => client.billing.overview.query(undefined, { signal }),
      })
      if (loadGeneration.current !== generation) return
      if (!next.enabled) return setHidden(true)
      setOverview(next)
      setSelectedPlan((current) => current || next.catalog[0]?.key || '')
      setSelectedVenues((current) =>
        current.length ? current : next.venues.map((venue) => venue.id),
      )
    } catch {
      if (loadGeneration.current === generation && !controller.signal.aborted) setHidden(true)
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null
    }
  }
  useEffect(() => {
    void load()
    return () => {
      loadGeneration.current += 1
      loadAbort.current?.abort()
      loadAbort.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!cancelOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    cancelReasonRef.current?.focus()
    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setCancelOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = cancelDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', handleDialogKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleDialogKeyDown)
      cancelTriggerRef.current?.focus()
    }
  }, [cancelOpen])
  const view = useMemo(() => (overview ? presentation(overview) : null), [overview])

  async function checkout() {
    if (overview?.currentCheckoutUrl) {
      window.location.assign(overview.currentCheckoutUrl)
      return
    }
    const plan = overview?.catalog.find((candidate) => candidate.key === selectedPlan)
    if (!plan || !selectedVenues.length) return
    setBusy(true)
    setError(null)
    try {
      const session = await client.billing.createCheckout.mutate({
        planKey: plan.key,
        planVersion: plan.version,
        venueIds: selectedVenues,
        operationKey: crypto.randomUUID(),
      })
      if (!session.url)
        throw new Error('Checkout session is already being created. Refresh billing status.')
      window.location.assign(session.url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Checkout could not be started.')
      setBusy(false)
    }
  }

  async function portal() {
    setBusy(true)
    setError(null)
    try {
      const session = await client.billing.createPortal.mutate()
      window.location.assign(session.url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Billing management could not be opened.')
      setBusy(false)
    }
  }

  async function cancelSubscription() {
    if (cancelReason.trim().length < 3) return
    setBusy(true)
    setError(null)
    try {
      await client.billing.requestCancellation.mutate({
        operationId: crypto.randomUUID(),
        reason: cancelReason.trim(),
      })
      setCancelOpen(false)
      setCancelReason('')
      setNotice(
        'Your cancellation is scheduled for the end of the paid period. Your access remains available until then.',
      )
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cancellation could not be scheduled.')
    } finally {
      setBusy(false)
    }
  }

  async function recordInterest(featureKey: string) {
    setBusy(true)
    setError(null)
    try {
      await client.billing.recordAddOnInterest.mutate({
        operationId: crypto.randomUUID(),
        featureKey,
      })
      setNotice(
        'Thanks—our team will review your account and contact you with a custom offer. Nothing has been added or charged.',
      )
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your interest could not be recorded.')
    } finally {
      setBusy(false)
    }
  }

  if (hidden) return null
  if (!overview || !view) return <ClientBillingView state="loading" billing={null} />
  return (
    <section className="rounded-3xl border border-pf-primary/10 bg-white p-6 shadow-sm sm:p-8">
      {!overview.account && overview.capabilities.checkout && overview.catalog.length > 0 ? (
        <fieldset
          className="mb-6 rounded-2xl border border-pf-light bg-pf-surface/50 p-4"
          disabled={busy}
        >
          <legend className="px-2 text-sm font-semibold text-pf-deep">
            Choose test subscription coverage
          </legend>
          <label
            className="mt-2 block text-xs font-bold uppercase tracking-wider text-pf-deep/60"
            htmlFor="billing-plan"
          >
            Plan
          </label>
          <select
            id="billing-plan"
            value={selectedPlan}
            onChange={(event) => setSelectedPlan(event.target.value)}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 text-sm"
          >
            {overview.catalog.map((plan) => (
              <option key={`${plan.key}:${plan.version}`} value={plan.key}>
                {plan.displayName} — {moneyLabel(plan.unitAmount, plan.currency)} per{' '}
                {plan.interval}
              </option>
            ))}
          </select>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {overview.venues.map((venue) => (
              <label
                key={venue.id}
                className="flex min-h-11 items-center gap-3 rounded-xl border border-pf-light bg-white px-3 text-sm text-pf-deep"
              >
                <input
                  type="checkbox"
                  checked={selectedVenues.includes(venue.id)}
                  onChange={(event) =>
                    setSelectedVenues((current) =>
                      event.target.checked
                        ? [...current, venue.id]
                        : current.filter((id) => id !== venue.id),
                    )
                  }
                />
                {venue.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
        >
          {notice}
        </p>
      ) : null}
      <ClientBillingView
        state={view.state}
        billing={view.model}
        reconciliationWarning={
          overview.account &&
          ['DRIFT', 'ERROR', 'STALE'].includes(overview.account.reconciliationHealth)
            ? 'The local billing projection is being checked against Stripe. Access is not granted from the redirect alone.'
            : null
        }
        {...(overview.capabilities.checkout && !busy
          ? { onStartCheckout: () => void checkout() }
          : {})}
        {...(view.model?.canRetryCheckout && !busy ? { onRetryCheckout: () => void portal() } : {})}
        {...(view.model?.canManageBilling && !busy ? { onManageBilling: () => void portal() } : {})}
        {...(view.model?.canCancel && !busy
          ? {
              onRequestCancellation: () => {
                cancelTriggerRef.current = document.activeElement as HTMLElement | null
                setCancelOpen(true)
              },
            }
          : {})}
        {...(!busy
          ? { onAddOnInterest: (featureKey: string) => void recordInterest(featureKey) }
          : {})}
      />
      {cancelOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-billing-heading"
          aria-describedby="cancel-billing-description"
          className="fixed inset-0 z-50 flex items-center justify-center bg-pf-deep/60 p-4"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setCancelOpen(false)
          }}
        >
          <form
            ref={cancelDialogRef}
            onSubmit={(event) => {
              event.preventDefault()
              void cancelSubscription()
            }}
            className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl"
          >
            <h2 id="cancel-billing-heading" className="text-xl font-semibold text-pf-deep">
              Cancel at the end of your paid period?
            </h2>
            <p id="cancel-billing-description" className="mt-2 text-sm leading-6 text-pf-deep/70">
              Your venue stays available through the paid-through date. Tell us why you are leaving
              so our team can follow up appropriately.
            </p>
            <label
              htmlFor="cancellation-reason"
              className="mt-5 block text-sm font-semibold text-pf-deep"
            >
              Why are you canceling?
            </label>
            <textarea
              ref={cancelReasonRef}
              id="cancellation-reason"
              required
              minLength={3}
              maxLength={2000}
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              className="mt-2 min-h-28 w-full rounded-xl border border-pf-light p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
            />
            <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setCancelOpen(false)}
                className="min-h-11 rounded-full border border-pf-light px-5 text-sm font-semibold text-pf-deep"
              >
                Keep subscription
              </button>
              <button
                type="submit"
                disabled={busy || cancelReason.trim().length < 3}
                className="min-h-11 rounded-full bg-rose-700 px-5 text-sm font-semibold text-white disabled:opacity-50"
              >
                Schedule cancellation
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  )
}
