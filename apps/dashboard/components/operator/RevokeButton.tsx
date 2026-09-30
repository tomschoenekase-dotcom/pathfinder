'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { CANCELLED_TEXT, errorText, useOperatorPost } from './useOperatorPost'

/** Two steps: Revoke, then Confirm. Clerk asks for Face ID or a passkey before the POST lands. */
export function RevokeButton({ grantId, clientName }: { grantId: string; clientName: string }) {
  const revoke = useOperatorPost('/api/operator/revoke')
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await revoke({ grantId })
      if (result?.revoked === true) {
        setMessage('Revoked.')
        router.refresh()
      } else {
        setMessage(errorText(result?.error))
      }
    } catch {
      setMessage(CANCELLED_TEXT)
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 lg:items-end">
      {confirming ? (
        <>
          <p className="text-sm text-slate-800">Its access stops immediately.</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              aria-label={`Confirm revoke ${clientName}`}
              className="min-h-11 rounded-xl bg-red-800 px-4 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2 disabled:opacity-50"
            >
              Confirm revoke
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="min-h-11 rounded-xl border border-slate-400 px-4 text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={`Revoke ${clientName}`}
          className="min-h-11 rounded-xl border border-red-800 px-4 text-sm font-semibold text-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2"
        >
          Revoke
        </button>
      )}
      <p role="status" className="text-sm text-slate-800">
        {message}
      </p>
    </div>
  )
}
