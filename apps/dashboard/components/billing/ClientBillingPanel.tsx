'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { ClientBillingView } from './ClientBillingView'
import {
  clientBillingPresentation as presentation,
  type ClientBillingOverview as Overview,
} from '../../lib/client-billing-presentation'

const BILLING_READ_TIMEOUT_MS = 15_000

export function ClientBillingPanel() {
  const client = useTRPCClient()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [hidden, setHidden] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    setLoadError(false)
    try {
      const next = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: BILLING_READ_TIMEOUT_MS,
        request: (signal) => client.billing.overview.query(undefined, { signal }),
      })
      if (loadGeneration.current !== generation) return
      if (!next.enabled) return setHidden(true)
      setOverview(next)
    } catch {
      if (loadGeneration.current === generation && !controller.signal.aborted) setLoadError(true)
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

  function checkout() {
    if (overview?.currentCheckoutUrl) {
      window.location.assign(overview.currentCheckoutUrl)
      return
    }
    setError(
      'The payment link is no longer available. Refresh Payment or contact Torchiko support.',
    )
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
  if (loadError) {
    return (
      <section className="rounded-xl border border-tk-rule bg-tk-card p-5 sm:p-6">
        <h2 className="text-xl font-semibold text-pf-deep">Payment details are unavailable</h2>
        <p role="alert" className="mt-2 text-sm leading-6 text-pf-deep/70">
          We could not load your payment status. Please try again or contact Torchiko support.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-5 inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
        >
          Try again
        </button>
      </section>
    )
  }
  if (!overview || !view) return <ClientBillingView state="loading" billing={null} />
  return (
    <section className="rounded-xl border border-tk-rule bg-tk-card p-5 sm:p-6">
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
        {...(view.model?.canStartCheckout && !busy ? { onStartCheckout: checkout } : {})}
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
