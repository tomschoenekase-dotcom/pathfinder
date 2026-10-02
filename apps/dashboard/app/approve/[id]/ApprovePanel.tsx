'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { DecisionButtons } from '../../../components/operator/DecisionButtons'
import {
  CANCELLED_TEXT,
  errorText,
  useOperatorPost,
} from '../../../components/operator/useOperatorPost'

/** Big Approve and Reject buttons pinned to the bottom of the phone screen. */
export function ApprovePanel({
  id,
  argsHash,
  label,
  decisionRequestId,
  grantable,
}: {
  id: string
  argsHash: string
  label: string
  decisionRequestId?: string | undefined
  grantable: boolean
}) {
  const post = useOperatorPost('/api/operator/job-grants')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function applyGrant() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await post({ action: 'apply', proposalId: id, argsHash })
      if (typeof result?.status === 'string') {
        setMessage(
          result.status === 'APPLIED'
            ? 'Applied with your job grant.'
            : `Now ${result.status.toLowerCase()}.`,
        )
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

  return (
    <div className="sticky bottom-0 border-t border-tk-rule bg-tk-paper px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
      <DecisionButtons
        id={id}
        argsHash={argsHash}
        size="large"
        label={label}
        decisionRequestId={decisionRequestId}
      />
      {grantable ? (
        <div className="mt-3 border-t border-tk-rule pt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyGrant()}
            aria-label={`Apply with your job grant: ${label}`}
            className="min-h-11 w-full rounded-xl border border-tk-ink bg-tk-paper px-4 text-sm font-semibold text-tk-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus focus-visible:ring-offset-2 disabled:opacity-50"
          >
            Apply with my job grant
          </button>
          <p role="status" className="mt-2 min-h-5 text-sm text-slate-700">
            {message ?? 'Uses one grant you created. If none covers this change, it stays pending.'}
          </p>
        </div>
      ) : null}
    </div>
  )
}
