'use client'

import { useEffect, useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import {
  isForbiddenError,
  type ClientBillingStateData,
  type ClientBillingViewState,
} from '../../lib/client-billing-state'
import { BillingStateView } from './BillingStateView'

const BILLING_READ_TIMEOUT_MS = 15_000

export function ClientBillingPanel() {
  const client = useTRPCClient()
  const [view, setView] = useState<ClientBillingViewState>({ status: 'loading' })
  const lastGood = useRef<ClientBillingStateData | null>(null)
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
    setView((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    try {
      const next = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: BILLING_READ_TIMEOUT_MS,
        request: (signal) => client.billing.clientState.query(undefined, { signal }),
      })
      if (loadGeneration.current !== generation) return
      if (next.state !== 'error') lastGood.current = next
      setView(
        next.state === 'error'
          ? {
              status: 'error',
              kind: next.errorKind ?? 'retrieval',
              lastConfirmedAt: lastGood.current?.lastReliableUpdateAt ?? null,
            }
          : { status: 'ready', data: next },
      )
    } catch (cause) {
      if (loadGeneration.current !== generation || controller.signal.aborted) return
      // A request failure is never rendered as an empty or paid state.
      setView(
        isForbiddenError(cause)
          ? { status: 'forbidden' }
          : {
              status: 'error',
              kind: 'retrieval',
              lastConfirmedAt: lastGood.current?.lastReliableUpdateAt ?? null,
            },
      )
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
  function checkout() {
    const url = view.status === 'ready' ? view.data.actions.checkoutUrl : null
    if (url) {
      window.location.assign(url)
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

  return (
    <div className="space-y-4">
      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
        >
          {notice}
        </p>
      ) : null}
      <BillingStateView
        view={view}
        busy={busy}
        onRetry={() => void load()}
        onCheckout={checkout}
        onManageBilling={() => void portal()}
        onRequestCancellation={() => {
          cancelTriggerRef.current = document.activeElement as HTMLElement | null
          setCancelOpen(true)
        }}
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
    </div>
  )
}
