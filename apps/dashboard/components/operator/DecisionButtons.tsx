'use client'

import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'

import { CANCELLED_TEXT, errorText, useOperatorPost } from './useOperatorPost'

type Decision = 'approve' | 'reject'

function outcomeText(decision: Decision, status: string, failureCode: unknown) {
  if (decision === 'reject') return 'Rejected. Nothing was changed.'
  if (status === 'APPLIED') return 'Approved and applied.'
  if (status === 'STALE')
    return 'Approved, but the target changed since it was proposed. Nothing was applied.'
  if (status === 'FAILED') {
    return `Approved, but applying failed${typeof failureCode === 'string' ? ` (${failureCode})` : ''}.`
  }
  return `Now ${status.toLowerCase()}.`
}

/**
 * Approve and Reject for one proposal or plan. The POST carries the argsHash that was on screen,
 * so a request that changed since the page rendered is refused by the server. Clerk asks for
 * Face ID or a passkey before the POST lands.
 */
export function DecisionButtons({
  id,
  argsHash,
  size,
  label,
}: {
  id: string
  argsHash: string
  size: 'large' | 'compact'
  /** Names the request for screen readers when several buttons share a page. */
  label: string
}) {
  const submit = useOperatorPost('/api/operator/approve')
  const router = useRouter()
  const statusId = useId()
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function decide(decision: Decision) {
    setBusy(true)
    setMessage(null)
    try {
      const result = await submit({ id, argsHash, decision })
      if (typeof result?.status === 'string') {
        setMessage(outcomeText(decision, result.status, result.failureCode))
        router.refresh()
      } else {
        setMessage(errorText(result?.error))
      }
    } catch {
      setMessage(CANCELLED_TEXT)
    } finally {
      setBusy(false)
    }
  }

  const large = size === 'large'
  return (
    <div>
      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy}
          aria-label={`Approve: ${label}`}
          aria-describedby={statusId}
          onClick={() => void decide('approve')}
          className={[
            'rounded-xl bg-tk-ink font-semibold text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus focus-visible:ring-offset-2 disabled:opacity-50',
            large ? 'min-h-14 flex-[2] px-6 text-lg' : 'min-h-11 px-5 text-sm',
          ].join(' ')}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          aria-label={`Reject: ${label}`}
          aria-describedby={statusId}
          onClick={() => void decide('reject')}
          className={[
            'rounded-xl border border-slate-400 bg-white font-semibold text-slate-900 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus focus-visible:ring-offset-2 disabled:opacity-50',
            large ? 'min-h-14 flex-1 px-4 text-lg' : 'min-h-11 px-5 text-sm',
          ].join(' ')}
        >
          Reject
        </button>
      </div>
      <p id={statusId} role="status" className="mt-2 min-h-5 text-sm text-slate-700">
        {message ?? (large ? 'Approving asks for Face ID or your passkey.' : '')}
      </p>
    </div>
  )
}
