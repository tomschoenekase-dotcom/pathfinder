'use client'

import { useState } from 'react'

import {
  ClientBillingView,
  type ClientBillingState,
  type ClientBillingViewModel,
} from '../../../components/billing/ClientBillingView'

export function InteractiveClientBillingFixture({
  state,
  billing,
  reconciliationWarning,
}: {
  state: ClientBillingState
  billing: ClientBillingViewModel | null
  reconciliationWarning: string | null
}) {
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  return (
    <>
      {notice ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
        >
          {notice}
        </p>
      ) : null}
      <ClientBillingView
        state={state}
        billing={billing}
        reconciliationWarning={reconciliationWarning}
        onRequestCancellation={() => setCancelOpen(true)}
        onAddOnInterest={() => setNotice('Interest recorded. Nothing has been added or charged.')}
      />
      {cancelOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="fixture-cancel-heading"
          className="fixed inset-0 z-50 flex items-center justify-center bg-pf-deep/60 p-4"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault()
              setCancelOpen(false)
              setNotice('Cancellation scheduled. Access remains through the paid-through date.')
            }}
            className="w-full max-w-lg rounded-3xl bg-white p-6"
          >
            <h2 id="fixture-cancel-heading" className="text-xl font-semibold">
              Cancel at the end of your paid period?
            </h2>
            <label className="mt-4 block font-semibold" htmlFor="fixture-cancel-reason">
              Why are you canceling?
            </label>
            <textarea
              id="fixture-cancel-reason"
              autoFocus
              required
              minLength={3}
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              className="mt-2 min-h-28 w-full rounded-xl border border-pf-light p-3"
            />
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setCancelOpen(false)}
                className="min-h-11 rounded-full border px-4"
              >
                Keep subscription
              </button>
              <button type="submit" className="min-h-11 rounded-full bg-rose-700 px-4 text-white">
                Schedule cancellation
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  )
}
