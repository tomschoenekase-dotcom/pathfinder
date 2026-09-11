'use client'

import Link from 'next/link'
import type { inferRouterOutputs } from '@trpc/server'
import { useEffect, useRef, useState } from 'react'

import type { AppRouter } from '@pathfinder/api'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

type Evidence = inferRouterOutputs<AppRouter>['admin']['visitorFeedbackHazardEvidence']
const EVIDENCE_READ_TIMEOUT_MS = 15_000

function ratingLabel(rating: Evidence['currentFeedback']['rating']) {
  return rating === 'NOT_HELPFUL' ? 'Not helpful' : 'Helpful'
}

export function VisitorFeedbackHazardEvidence({ eventId }: { eventId: string }) {
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
        timeoutMs: EVIDENCE_READ_TIMEOUT_MS,
        request: (signal) =>
          client.admin.visitorFeedbackHazardEvidence.query({ eventId }, { signal }),
      })
      if (sequence.current === startedSequence && currentEventId.current === startedEventId) {
        setEvidence(result)
      }
    } catch {
      if (sequence.current === startedSequence && currentEventId.current === startedEventId) {
        setError(
          'Current feedback evidence is unavailable or no longer matches this alert. Try again to read the current record.',
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
    <div className="mt-3 border-t border-orange-200 pt-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => void inspect()}
        className="min-h-10 rounded-lg border border-orange-300 bg-white px-3 text-sm font-semibold text-orange-900 hover:bg-orange-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-50"
      >
        {pending ? 'Reading current feedback…' : 'Inspect current visitor feedback'}
      </button>
      {error ? (
        <p className="mt-2 text-xs text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
      {evidence ? (
        <section
          className="mt-3 border-l-2 border-orange-300 bg-white px-3 py-3 text-sm text-slate-700"
          aria-label="Current visitor feedback evidence"
        >
          <p className="font-semibold text-slate-950">Current mutable feedback record</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            This unverified signal points to the feedback record as it exists now. The visitor may
            have changed it after the alert was grouped; review the linked conversation before
            acting.
          </p>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="font-semibold text-slate-700">Current feedback</dt>
            <dd>{ratingLabel(evidence.currentFeedback.rating)}</dd>
            <dt className="font-semibold text-slate-700">Visitor reason</dt>
            <dd className="break-words">
              {evidence.currentFeedback.reason ?? 'No reason provided.'}
            </dd>
            <dt className="font-semibold text-slate-700">Linked message</dt>
            <dd className="break-words">{evidence.currentFeedback.linkedMessage.content}</dd>
          </dl>
          <Link
            href={`/admin/clients/${evidence.event.tenantId}/venues/${evidence.event.venueId}/chatlogs/${evidence.currentFeedback.sessionId}`}
            className="mt-3 inline-flex min-h-10 items-center text-sm font-semibold text-sky-800 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            Review linked conversation
          </Link>
          <p className="mt-2 text-xs font-medium text-slate-800">
            Read only. This does not publish a venue notice, close or delete an attraction, or
            resolve the alert.
          </p>
        </section>
      ) : null}
    </div>
  )
}
