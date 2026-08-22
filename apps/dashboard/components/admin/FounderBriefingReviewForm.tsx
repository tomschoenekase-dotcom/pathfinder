'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Props = {
  reviewedThrough: Date
  previousReviewedThrough: Date | null
  briefingSchemaVersion: 1
  hasUnreviewedChanges: boolean
}

export function FounderBriefingReviewForm({
  reviewedThrough,
  previousReviewedThrough,
  briefingSchemaVersion,
  hasUnreviewedChanges,
}: Props) {
  const client = useTRPCClient()
  const router = useRouter()
  const operationId = useRef<string | null>(null)
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  async function markReviewed() {
    if (pending) return
    operationId.current ??= crypto.randomUUID()
    setPending(true)
    setFeedback(null)
    try {
      const result = await client.admin.markFounderBriefingReviewed.mutate({
        operationId: operationId.current,
        reviewedThrough: reviewedThrough.toISOString(),
        expectedPreviousReviewedThrough: previousReviewedThrough?.toISOString() ?? null,
        briefingSchemaVersion,
      })
      if (result.executionTriggered !== false) throw new Error('Unexpected execution state')
      setFeedback('Review checkpoint recorded. No queue item was resolved or executed.')
      router.refresh()
    } catch {
      setFeedback('Review state changed or could not be confirmed. Refresh before retrying.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mt-4 border-t border-slate-700 pt-4">
      <button
        type="button"
        disabled={pending}
        onClick={() => void markReviewed()}
        className="min-h-11 rounded-xl border border-slate-600 bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
      >
        {pending ? 'Recording review…' : 'Mark briefing reviewed'}
      </button>
      <p className="mt-2 text-xs leading-5 text-slate-400">
        {hasUnreviewedChanges
          ? 'This advances only your personal review cursor.'
          : 'No new bounded activity is visible; you can still checkpoint this review.'}{' '}
        It does not acknowledge, resolve, approve, or execute any item.
      </p>
      {feedback ? (
        <p className="mt-2 text-sm text-slate-200" role="status">
          {feedback}
        </p>
      ) : null}
    </div>
  )
}
