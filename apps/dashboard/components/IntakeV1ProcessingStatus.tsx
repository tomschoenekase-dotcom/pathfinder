'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../lib/trpc'
import { runBoundedClientRequest } from '../lib/bounded-client-request'

type ProcessingRead = inferRouterOutputs<AppRouter>['intake']['getV1Processing']
type ProcessingMember = ProcessingRead['members'][number]

function statusLabel(member: ProcessingMember): string {
  if (member.status === 'NOT_SCHEDULED') return 'Not scheduled for this earlier version'
  if (member.status === 'POLICY_DISABLED') return 'Waiting for research to be enabled'
  if (member.reasonCode === 'PROCESSING_RECOVERY_PENDING') return 'Waiting to resume'
  if (member.status === 'PENDING') return 'Waiting to process'
  if (member.status === 'IN_PROGRESS') return 'Processing'
  if (member.status === 'FAILED') return 'Needs another review'
  if (member.status === 'HELD')
    return member.reasonCode === 'EXTRACTION_NOT_EXECUTABLE' ? 'File needs review' : 'Needs review'
  if (member.processingKind === 'WEBSITE_RESEARCH') return 'Research saved'
  return 'Ready for review'
}

export function IntakeV1ProcessingStatus({
  ownerId,
  venueId,
  submissionId,
  revision,
}: {
  ownerId: string
  venueId: string
  submissionId: string
  revision: number
}) {
  const client = useTRPCClient()
  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const requestRef = useRef<AbortController | null>(null)
  const clientRef = useRef(client)
  const scopeRef = useRef({ ownerId, venueId, submissionId, revision })
  clientRef.current = client
  scopeRef.current = { ownerId, venueId, submissionId, revision }
  const [result, setResult] = useState<ProcessingRead | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestRef.current?.abort()
      generationRef.current += 1
    }
  }, [])

  const load = useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const generation = ++generationRef.current
    const requestedClient = client
    const requestedScope = { ownerId, venueId, submissionId, revision }
    const scopeCurrent = () => {
      const current = scopeRef.current
      return (
        mountedRef.current &&
        generationRef.current === generation &&
        clientRef.current === requestedClient &&
        current.ownerId === requestedScope.ownerId &&
        current.venueId === requestedScope.venueId &&
        current.submissionId === requestedScope.submissionId &&
        current.revision === requestedScope.revision
      )
    }
    setLoading(true)
    setError(null)
    try {
      const next: ProcessingRead = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: 15_000,
        request: (signal) =>
          client.intake.getV1Processing.query(
            {
              venueId,
              submissionId,
              revision,
            },
            { signal },
          ),
      })
      if (!scopeCurrent()) return
      if (next.submissionId !== submissionId || next.revision !== revision)
        throw new Error('Processing response scope mismatch')
      setResult(next)
    } catch {
      if (scopeCurrent()) {
        setError('Processing details could not be refreshed. Your saved submission is unchanged.')
      }
    } finally {
      if (scopeCurrent()) setLoading(false)
      if (requestRef.current === controller) requestRef.current = null
    }
  }, [client, ownerId, revision, submissionId, venueId])

  useEffect(() => {
    setResult(null)
    void load()
  }, [load])

  return (
    <section className="border-t border-pf-light pt-5" aria-labelledby="v1-processing-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="v1-processing-title" className="font-semibold text-pf-deep">
            Material processing
          </h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-pf-deep/75">
            This tracks preparation for Torchiko review. It does not mean a visitor package was
            built or anything was published.
          </p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load()}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-pf-light bg-white px-4 text-sm font-semibold text-pf-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary disabled:opacity-55"
        >
          <RefreshCw aria-hidden="true" size={16} />
          {loading ? 'Refreshing…' : 'Refresh status'}
        </button>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
      {result ? (
        result.members.length ? (
          <ul className="mt-4 divide-y divide-pf-light border-y border-pf-light">
            {result.members.map((member) => (
              <li
                key={member.memberId}
                className="flex min-w-0 flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
              >
                <span className="min-w-0 break-words text-sm font-medium text-pf-deep">
                  {member.displayName ?? member.sourceLabel}
                </span>
                <span className="shrink-0 text-sm text-pf-deep/75">{statusLabel(member)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-pf-deep/75">No material is recorded in this version.</p>
        )
      ) : loading ? (
        <p className="mt-3 text-sm text-pf-deep/75" role="status">
          Loading material status…
        </p>
      ) : null}
    </section>
  )
}
