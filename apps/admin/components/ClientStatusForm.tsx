'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { createTRPCClient } from '../lib/trpc'

type ClientStatusFormProps = {
  tenantId: string
  currentStatus: 'ACTIVE' | 'SUSPENDED' | 'TRIAL'
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

export function ClientStatusForm({ tenantId, currentStatus }: ClientStatusFormProps) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }
  const client = clientRef.current

  const [pendingStatus, setPendingStatus] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleStatusChange(status: ClientStatusFormProps['currentStatus']) {
    setPendingStatus(status)
    setMessage(null)
    setErrorMessage(null)

    try {
      await client.admin.updateClientStatus.mutate({ tenantId, status })
      setMessage(`Client status updated to ${status.toLowerCase()}.`)
      router.refresh()
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setPendingStatus(null)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-pf-light/60">Current status: {currentStatus}</p>

      <div className="flex flex-wrap gap-3">
        {(
          [
            ['ACTIVE', 'Set Active'],
            ['TRIAL', 'Set Trial'],
            ['SUSPENDED', 'Set Suspended'],
          ] as const
        ).map(([status, label]) => (
          <button
            key={status}
            type="button"
            disabled={currentStatus === status || pendingStatus !== null}
            onClick={() => {
              void handleStatusChange(status)
            }}
            className="inline-flex min-h-11 items-center rounded-full border border-pf-primary/20 px-5 text-sm font-medium text-pf-light/70 transition hover:bg-pf-primary/20 hover:text-white disabled:cursor-not-allowed disabled:border-pf-primary/10 disabled:bg-pf-primary/10 disabled:text-pf-light/30"
          >
            {pendingStatus === status ? 'Saving...' : label}
          </button>
        ))}
      </div>

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
