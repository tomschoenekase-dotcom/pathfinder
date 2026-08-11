'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

export function EvaluationRunLifecycleControl(props: {
  tenantId: string
  venueId: string
  runId: string
  status:
    | 'LEGACY'
    | 'STAGED'
    | 'QUEUED'
    | 'RETRY_SCHEDULED'
    | 'RUNNING'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED'
  cancellationRequestedAt: Date | null
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const cancellable = ['STAGED', 'QUEUED', 'RETRY_SCHEDULED', 'RUNNING'].includes(props.status)

  async function cancel() {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.cancelEvaluationRun.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        runId: props.runId,
      })
      setMessage('Cancellation requested. No new case dispatch will begin for this run.')
      setConfirming(false)
      router.refresh()
    } catch {
      setMessage('Cancellation could not be confirmed. Refresh this run before trying again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-800">
        {props.cancellationRequestedAt && props.status === 'RUNNING'
          ? 'CANCELLATION REQUESTED'
          : props.status}
      </span>
      {cancellable && !props.cancellationRequestedAt ? (
        confirming ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-left text-xs text-amber-950">
            <p>Stop remaining cases? Completed case evidence is retained.</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={cancel}
                disabled={busy}
                className="min-h-10 rounded-lg bg-amber-900 px-3 font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'Requesting…' : 'Confirm cancellation'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="min-h-10 rounded-lg border border-amber-300 px-3 font-semibold"
              >
                Keep running
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="min-h-10 rounded-lg border border-pf-light px-3 text-xs font-semibold text-pf-deep"
          >
            Cancel remaining cases
          </button>
        )
      ) : null}
      {message ? (
        <p role="status" className="max-w-sm text-xs text-pf-deep/65">
          {message}
        </p>
      ) : null}
    </div>
  )
}
