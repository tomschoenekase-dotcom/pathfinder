'use client'

import { useReverification } from '@clerk/nextjs'
import { useState } from 'react'

async function postArm() {
  const response = await fetch('/api/operator/arm', { method: 'POST' })
  return (await response.json()) as { armed?: boolean; error?: string }
}

export function ArmButton() {
  const arm = useReverification(postArm)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="mt-6">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            const result = await arm()
            setMessage(
              result?.armed
                ? 'Ready. Start the connection in ChatGPT within 10 minutes.'
                : (result?.error ?? 'Nothing changed.'),
            )
          } catch {
            setMessage('Verification was cancelled. Nothing changed.')
          } finally {
            setBusy(false)
          }
        }}
        className="min-h-12 w-full rounded-md bg-slate-900 px-4 text-base font-semibold text-white disabled:opacity-50"
      >
        I am connecting the operator now
      </button>
      {message ? (
        <p role="status" className="mt-3 text-sm text-slate-700">
          {message}
        </p>
      ) : null}
    </div>
  )
}
