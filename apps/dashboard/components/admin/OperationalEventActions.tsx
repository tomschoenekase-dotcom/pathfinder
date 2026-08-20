'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

export function OperationalEventActions({ eventId, state }: { eventId: string; state: string }) {
  const client = useTRPCClient()
  const router = useRouter()
  const [pending, setPending] = useState<'acknowledge' | 'resolve' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function act(action: 'acknowledge' | 'resolve') {
    setPending(action)
    setError(null)
    try {
      if (action === 'acknowledge') {
        await client.admin.acknowledgeOperationalEvent.mutate({ eventId })
      } else {
        await client.admin.resolveOperationalEvent.mutate({ eventId })
      }
      router.refresh()
    } catch {
      setError('The event changed or could not be updated. Refresh and try again.')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {state === 'OPEN' ? (
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void act('acknowledge')}
          className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {pending === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge'}
        </button>
      ) : null}
      <button
        type="button"
        disabled={pending !== null}
        onClick={() => void act('resolve')}
        className="min-h-10 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {pending === 'resolve' ? 'Resolving…' : 'Resolve'}
      </button>
      {error ? (
        <span className="text-xs text-rose-700" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}
