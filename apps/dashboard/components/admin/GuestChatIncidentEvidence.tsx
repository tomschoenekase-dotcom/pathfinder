'use client'

import type { inferRouterOutputs } from '@trpc/server'
import { useEffect, useRef, useState } from 'react'

import type { AppRouter } from '@pathfinder/api'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

type Evidence = inferRouterOutputs<AppRouter>['admin']['guestChatIncidentEvidence']
const INCIDENT_READ_TIMEOUT_MS = 15_000

export function GuestChatIncidentEvidence({ eventId }: { eventId: string }) {
  const client = useTRPCClient()
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  const currentEventId = useRef(eventId)
  currentEventId.current = eventId

  useEffect(() => {
    sequence.current += 1
    activeRequest.current?.abort()
    activeRequest.current = null
    setEvidence(null)
    setPending(false)
    setError(null)
    return () => {
      sequence.current += 1
      activeRequest.current?.abort()
      activeRequest.current = null
    }
  }, [eventId])

  async function inspect() {
    const startedSequence = ++sequence.current
    const startedEventId = eventId
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setPending(true)
    setError(null)
    setEvidence(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: INCIDENT_READ_TIMEOUT_MS,
        request: (signal) => client.admin.guestChatIncidentEvidence.query({ eventId }, { signal }),
      })
      if (sequence.current === startedSequence && currentEventId.current === startedEventId) {
        setEvidence(result)
      }
    } catch {
      if (sequence.current === startedSequence && currentEventId.current === startedEventId) {
        setError(
          'Incident evidence could not be loaded in time. Retry to inspect current evidence.',
        )
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null
      if (sequence.current === startedSequence && currentEventId.current === startedEventId) {
        setPending(false)
      }
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => void inspect()}
        className="min-h-10 rounded-lg border border-orange-300 bg-white px-3 text-sm font-semibold text-orange-900 hover:bg-orange-50 disabled:opacity-50"
      >
        {pending ? 'Reading incident evidence…' : 'Inspect latest degraded turn'}
      </button>
      {error ? (
        <p className="mt-2 text-xs text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
      {evidence ? (
        <div className="mt-3 rounded-xl border border-orange-200 bg-white p-3 text-xs text-slate-700">
          <p className="font-semibold text-slate-950">
            Exact evidence for the latest turn in this grouped alert
          </p>
          <p className="mt-1">
            Turn {evidence.event.latestTurn.status.toLowerCase()} · fallback{' '}
            <span className="font-mono">
              {evidence.event.latestTurn.fallbackCode ?? 'not recorded'}
            </span>
          </p>
          <ul className="mt-2 space-y-2">
            {evidence.event.latestTurn.providerOperations.map((operation) => (
              <li key={operation.kind} className="rounded-lg bg-slate-50 p-2">
                <span className="font-semibold">{operation.kind.replaceAll('_', ' ')}</span>
                {' · '}
                {operation.status}
                {operation.outcomeCode ? ` · ${operation.outcomeCode}` : ''}
                {operation.usage ? (
                  <span className="mt-1 block break-words">
                    {operation.usage.provider} / {operation.usage.model} ·{' '}
                    {operation.usage.success
                      ? 'succeeded'
                      : (operation.usage.errorCode ?? 'failed')}{' '}
                    · {operation.usage.latencyMs} ms
                  </span>
                ) : (
                  <span className="mt-1 block">No linked usage row was recorded.</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 font-medium text-slate-800">
            Read only. Transcripts, prompts, responses, and provider exception text are excluded; no
            retry or provider-control action was authorized.
          </p>
        </div>
      ) : null}
    </div>
  )
}
