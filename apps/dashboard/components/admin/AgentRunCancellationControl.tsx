'use client'

import { FormEvent, ReactNode, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

const CANCELLABLE_STATES = new Set(['QUEUED', 'RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL'])

type Props = {
  tenantId: string
  venueId: string
  agentRunId: string
  status: string
  cancelRequestedAt: Date | null
}

export function AgentRunCancellationControl({
  tenantId,
  venueId,
  agentRunId,
  status,
  cancelRequestedAt,
}: Props) {
  const client = useTRPCClient()
  const router = useRouter()
  const inFlightRef = useRef(false)
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [isError, setIsError] = useState(false)

  if (cancelRequestedAt) {
    return (
      <CancellationNotice>
        Cancellation was requested at {cancelRequestedAt.toLocaleString()}. This is durable intent;
        the run status remains authoritative.
      </CancellationNotice>
    )
  }

  if (!CANCELLABLE_STATES.has(status)) {
    return (
      <CancellationNotice>
        This run is {status.replace(/_/g, ' ').toLowerCase()} and cannot accept a cancellation
        request.
      </CancellationNotice>
    )
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = reason.trim()
    if (!trimmed || inFlightRef.current) return

    inFlightRef.current = true
    setPending(true)
    setMessage(null)
    setIsError(false)
    try {
      const result = await client.admin.requestAgentRunCancellation.mutate({
        tenantId,
        venueId,
        agentRunId,
        reason: trimmed,
      })
      if (result.outcome === 'TERMINAL') {
        setMessage(
          `The run is already ${result.status.toLowerCase()}; no cancellation was requested.`,
        )
      } else {
        setReason('')
        setMessage(
          result.outcome === 'REPLAYED'
            ? 'Cancellation was already requested.'
            : 'Cancellation request recorded.',
        )
      }
      try {
        router.refresh()
      } catch {
        // The mutation result remains definitive when a best-effort refresh fails.
      }
    } catch {
      setIsError(true)
      setMessage(
        'The request outcome is unknown. Copy or review this preserved reason, then manually refresh authoritative run evidence before retrying.',
      )
    } finally {
      inFlightRef.current = false
      setPending(false)
    }
  }

  return (
    <section
      className="rounded-3xl border border-amber-200 bg-amber-50 p-5"
      aria-labelledby="run-cancellation-heading"
    >
      <h3 id="run-cancellation-heading" className="text-lg font-semibold text-amber-950">
        Request cancellation
      </h3>
      <p className="mt-2 text-sm text-amber-950/80">
        This records durable cancellation intent only. It does not call a provider or mark the run
        cancelled.
      </p>
      <form onSubmit={handleSubmit} className="mt-4 space-y-3">
        <label
          htmlFor="agent-run-cancellation-reason"
          className="block text-sm font-semibold text-amber-950"
        >
          Operator reason
        </label>
        <textarea
          id="agent-run-cancellation-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={pending}
          maxLength={500}
          required
          rows={3}
          className="w-full rounded-2xl border border-amber-200 bg-white px-4 py-3 text-sm text-pf-deep outline-none focus:border-pf-primary disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending || !reason.trim()}
          className="inline-flex min-h-11 items-center rounded-2xl bg-amber-900 px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Requesting...' : 'Request cancellation'}
        </button>
      </form>
      {message ? (
        <p
          role={isError ? 'alert' : 'status'}
          className={`mt-3 text-sm ${isError ? 'text-rose-700' : 'text-amber-950'}`}
        >
          {message}
        </p>
      ) : null}
    </section>
  )
}

function CancellationNotice({ children }: { children: ReactNode }) {
  return (
    <section
      className="rounded-3xl border border-pf-light bg-white p-5"
      aria-label="Cancellation status"
    >
      <h3 className="font-semibold text-pf-deep">Cancellation</h3>
      <p className="mt-2 text-sm text-pf-deep/65">{children}</p>
    </section>
  )
}
