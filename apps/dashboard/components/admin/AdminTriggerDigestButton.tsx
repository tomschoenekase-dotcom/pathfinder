'use client'

import { useRef, useState } from 'react'

import { createTRPCClient } from '../../lib/trpc'

type AdminTriggerDigestButtonProps = {
  tenantId: string
}

export function AdminTriggerDigestButton({ tenantId }: AdminTriggerDigestButtonProps) {
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }
  const client = clientRef.current

  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleClick() {
    setPending(true)
    setMessage(null)
    setErrorMessage(null)

    try {
      const result = await client.admin.triggerDigest.mutate({ tenantId })
      setMessage(`Weekly digest queued (job ${result.digestId}).`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to queue the digest.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          void handleClick()
        }}
        className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? 'Queuing…' : 'Queue weekly digest'}
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
