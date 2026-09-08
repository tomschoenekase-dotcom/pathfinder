'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'
import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { FounderCharacterCandidateReview } from './FounderCharacterCandidateReview'

type Page = inferRouterOutputs<AppRouter>['admin']['listCharacterCandidateReviews']

export function FounderCharacterReviewInbox({ initial }: { initial: Page }) {
  const client = useTRPCClient()
  const router = useRouter()
  const [page, setPage] = useState(initial)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState('')
  const active = useRef<AbortController | null>(null)
  const mutation = useRef<AbortController | null>(null)
  useEffect(() => {
    active.current?.abort()
    active.current = null
    setPage(initial)
    setLoading(false)
    setError('')
    return () => {
      active.current?.abort()
      mutation.current?.abort()
    }
  }, [initial])

  async function loadMore() {
    if (active.current || !page.nextCursor) return
    const controller = new AbortController()
    active.current = controller
    setLoading(true)
    setError('')
    try {
      const next = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: 15_000,
        request: (signal) =>
          client.admin.listCharacterCandidateReviews.query(
            { limit: 12, cursor: page.nextCursor! },
            { signal },
          ),
      })
      if (!controller.signal.aborted)
        setPage((current) => ({
          ...next,
          items: [
            ...current.items,
            ...next.items.filter(
              (item) => !current.items.some((existing) => existing.id === item.id),
            ),
          ],
        }))
    } catch {
      if (!controller.signal.aborted) setError('More candidates could not be loaded. Try again.')
    } finally {
      if (active.current === controller) {
        active.current = null
        setLoading(false)
      }
    }
  }

  return (
    <div className="space-y-3">
      <FounderCharacterCandidateReview
        candidates={page.items}
        onDecision={async (input) => {
          const controller = new AbortController()
          mutation.current = controller
          try {
            const result = await runBoundedClientRequest({
              parentSignal: controller.signal,
              timeoutMs: 15_000,
              request: (signal) =>
                client.admin.decideCharacterCandidateReview.mutate(input, { signal }),
            })
            const name =
              page.items.find((item) => item.id === input.briefId)?.displayName ?? 'Candidate'
            const label =
              result.decision === 'ACCEPT'
                ? 'Accepted'
                : result.decision === 'REJECT'
                  ? 'Rejected'
                  : 'Revision requested'
            setReceipt(
              `${label}: ${name}, version ${input.expectedVersion}, revision ${input.expectedRevision}.${result.jobId ? ` Factory job ${result.jobId} recorded.` : ''}`,
            )
            router.refresh()
            return result
          } finally {
            if (mutation.current === controller) mutation.current = null
          }
        }}
      />
      {receipt ? (
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
        >
          {receipt}
        </p>
      ) : null}
      {page.hasMore ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadMore()}
          className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium disabled:opacity-50"
        >
          {loading ? 'Loading candidates…' : 'Load more candidates'}
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}
