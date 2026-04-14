'use client'

import { useRef, useState } from 'react'

import { createTRPCClient } from '../lib/trpc'

type TriggerDigestButtonProps = {
  tenantId: string
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

export function TriggerDigestButton({ tenantId }: TriggerDigestButtonProps) {
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }
  const client = clientRef.current

  const [isLoading, setIsLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleTrigger() {
    setIsLoading(true)
    setMessage(null)
    setErrorMessage(null)

    try {
      await client.admin.triggerDigest.mutate({ tenantId })
      setMessage('Digest job queued. It will process within the next few minutes.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        disabled={isLoading}
        onClick={() => {
          void handleTrigger()
        }}
        className="inline-flex min-h-11 items-center rounded-full bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {isLoading ? 'Queueing...' : 'Trigger weekly digest'}
      </button>

      {message ? (
        <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {message}
        </p>
      ) : null}

      {errorMessage ? (
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </p>
      ) : null}
    </div>
  )
}
