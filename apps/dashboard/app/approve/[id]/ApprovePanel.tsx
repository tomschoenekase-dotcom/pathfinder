'use client'

import { useReverification } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

type Decision = { id: string; argsHash: string; decision: 'approve' | 'reject' }

async function postDecision(body: Decision) {
  const response = await fetch('/api/operator/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await response.json()) as { status?: string; error?: string; failureCode?: string | null }
}

/** Big Approve / Reject buttons. Clerk asks for Face ID or a passkey before the POST lands. */
export function ApprovePanel({ id, argsHash }: { id: string; argsHash: string }) {
  const submit = useReverification(postDecision)
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true)
    setMessage(null)
    try {
      const result = await submit({ id, argsHash, decision })
      if (result?.status) {
        setMessage(`Now ${result.status}${result.failureCode ? ` (${result.failureCode})` : ''}.`)
        router.refresh()
      } else {
        setMessage(result?.error ?? 'Nothing changed.')
      }
    } catch {
      setMessage('Verification was cancelled. Nothing changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sticky bottom-0 mt-6 flex gap-3 bg-white py-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => void decide('approve')}
        className="min-h-12 flex-1 rounded-md bg-emerald-700 px-4 text-base font-semibold text-white disabled:opacity-50"
      >
        Approve
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void decide('reject')}
        className="min-h-12 rounded-md border border-slate-300 px-4 text-base font-semibold text-slate-900 disabled:opacity-50"
      >
        Reject
      </button>
      {message ? (
        <p role="status" className="sr-only">
          {message}
        </p>
      ) : null}
      {message ? <p className="absolute -top-4 text-sm text-slate-700">{message}</p> : null}
    </div>
  )
}
