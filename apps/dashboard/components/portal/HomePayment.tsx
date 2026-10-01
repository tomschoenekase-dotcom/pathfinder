'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { CalendarCheck2, CircleAlert } from 'lucide-react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import {
  clientBillingPresentation,
  type ClientBillingOverview,
} from '../../lib/client-billing-presentation'
import { useTRPCClient } from '../../lib/trpc'
import {
  PortalSection,
  portalButtonAttention,
  portalButtonSecondary,
  portalTextLink,
} from './PortalPrimitives'

export type HomePaymentSummary =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'hidden' }
  | {
      kind: 'due'
      headline: string
      detail: string | null
      pay: { kind: 'checkout'; url: string } | { kind: 'portal' } | null
    }
  | { kind: 'settled'; headline: string; detail: string | null }

/**
 * Reduces the billing projection to the one thing Home needs: is anything owed, and if so,
 * the single legitimate way to pay it. Everything else lives under Account.
 */
export function summarizeHomePayment(
  overview: ClientBillingOverview,
  canPay: boolean,
): HomePaymentSummary {
  if (!overview.enabled) return { kind: 'hidden' }
  const { state, model } = clientBillingPresentation(overview)
  if (!model) return { kind: 'settled', headline: 'No payment set up yet', detail: null }
  const paidThrough = model.paidThroughLabel
  switch (state) {
    case 'pending':
      return model.canStartCheckout && overview.currentCheckoutUrl
        ? {
            kind: 'due',
            headline: 'Payment needed to get started',
            detail: model.amountLabel
              ? `${model.amountLabel}${model.intervalLabel ? ` ${model.intervalLabel}` : ''}`
              : null,
            pay: canPay ? { kind: 'checkout', url: overview.currentCheckoutUrl } : null,
          }
        : { kind: 'settled', headline: 'Confirming your payment', detail: null }
    case 'past_due':
      return {
        kind: 'due',
        headline: 'Payment is past due',
        detail: model.statusDetail,
        pay: canPay && model.canRetryCheckout ? { kind: 'portal' } : null,
      }
    case 'grace':
      return {
        kind: 'due',
        headline: 'Payment due',
        detail: model.statusDetail,
        pay: canPay && model.canManageBilling ? { kind: 'portal' } : null,
      }
    case 'active':
      return {
        kind: 'settled',
        headline: paidThrough ? `Paid through ${paidThrough}` : 'Payments are up to date',
        detail: null,
      }
    case 'canceled':
      return {
        kind: 'settled',
        headline: paidThrough ? `Paid through ${paidThrough}` : 'Your plan is ending',
        detail: 'Your plan won’t renew.',
      }
    case 'manual':
      return {
        kind: 'settled',
        headline: paidThrough ? `Paid through ${paidThrough}` : 'Invoiced directly by Torchiko',
        detail: paidThrough ? 'Invoiced directly by Torchiko.' : null,
      }
    case 'complimentary':
      return { kind: 'settled', headline: 'No payment needed', detail: 'Complimentary access.' }
    default:
      return { kind: 'settled', headline: 'No payment set up yet', detail: null }
  }
}

export function HomePayment({ canPay }: { canPay: boolean }) {
  const client = useTRPCClient()
  const [summary, setSummary] = useState<HomePaymentSummary>({ kind: 'loading' })
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const generation = useRef(0)
  const abort = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    const current = ++generation.current
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setSummary({ kind: 'loading' })
    try {
      const overview = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: 15_000,
        request: (signal) => client.billing.overview.query(undefined, { signal }),
      })
      if (generation.current === current) setSummary(summarizeHomePayment(overview, canPay))
    } catch {
      if (generation.current === current && !controller.signal.aborted)
        setSummary({ kind: 'error' })
    }
  }, [client, canPay])

  useEffect(() => {
    void load()
    return () => {
      generation.current += 1
      abort.current?.abort()
    }
  }, [load])

  async function openPortal() {
    setOpening(true)
    setOpenError(null)
    try {
      const session = await client.billing.createPortal.mutate()
      window.location.assign(session.url)
    } catch {
      setOpenError('The payment page couldn’t be opened. Try again, or ask us in Help.')
      setOpening(false)
    }
  }

  return (
    <HomePaymentView
      summary={summary}
      opening={opening}
      openError={openError}
      onRetry={() => void load()}
      onOpenPortal={() => void openPortal()}
    />
  )
}

export function HomePaymentView({
  summary,
  opening = false,
  openError = null,
  onRetry,
  onOpenPortal,
}: {
  summary: HomePaymentSummary
  opening?: boolean
  openError?: string | null
  onRetry?: () => void
  onOpenPortal?: () => void
}) {
  if (summary.kind === 'hidden') return null
  const due = summary.kind === 'due'
  return (
    <PortalSection id="payment-heading" title="Payment" className={due ? 'border-tk-ember/45' : ''}>
      {summary.kind === 'loading' ? (
        <p className="mt-3 text-sm text-tk-soft" role="status">
          Checking your payment status…
        </p>
      ) : summary.kind === 'error' ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-sm text-tk-ink" role="alert">
            Your payment status didn’t load.
          </p>
          <button type="button" onClick={onRetry} className={portalButtonSecondary}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-start gap-2.5">
            {due ? (
              <CircleAlert
                className="mt-0.5 h-[18px] w-[18px] shrink-0 text-tk-ember-text"
                aria-hidden="true"
              />
            ) : (
              <CalendarCheck2
                className="mt-0.5 h-[18px] w-[18px] shrink-0 text-tk-soft"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0">
              <p className={`text-[0.95rem] font-semibold ${due ? 'text-tk-ember-text' : ''}`}>
                {summary.headline}
              </p>
              {summary.detail ? (
                <p className="mt-0.5 text-sm leading-6 text-tk-soft">{summary.detail}</p>
              ) : null}
            </div>
          </div>
          {summary.kind === 'due' ? (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              {summary.pay?.kind === 'checkout' ? (
                <a href={summary.pay.url} className={portalButtonAttention}>
                  Pay now
                </a>
              ) : summary.pay?.kind === 'portal' ? (
                <button
                  type="button"
                  onClick={onOpenPortal}
                  disabled={opening}
                  className={portalButtonAttention}
                >
                  {opening ? 'Opening…' : 'Pay now'}
                </button>
              ) : (
                <p className="text-sm text-tk-soft">An owner on your team can pay from Account.</p>
              )}
            </div>
          ) : null}
          {openError ? (
            <p role="alert" className="mt-2 text-sm text-tk-danger">
              {openError}
            </p>
          ) : null}
          <p className="mt-2 text-sm">
            <Link href="/payment" className={`${portalTextLink} inline-flex min-h-11 items-center`}>
              Billing details
            </Link>
          </p>
        </>
      )}
    </PortalSection>
  )
}
