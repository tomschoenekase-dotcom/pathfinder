'use client'

import { useRouter } from 'next/navigation'
import { FormEvent, useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

const DISPOSITIONS = [
  ['POSITIVE_INTEREST', 'Positive interest'],
  ['QUESTION_OR_OBJECTION', 'Question or objection'],
  ['NOT_INTERESTED', 'Not interested'],
  ['SUPPRESSION_REQUEST', 'Suppression request'],
  ['OTHER', 'Other'],
] as const

type Disposition = (typeof DISPOSITIONS)[number][0]
type Review = {
  id: string
  disposition: Disposition
  reason: string
  reviewerId: string
  revision: number
  createdAt: Date | string
}

function label(value: Disposition) {
  return DISPOSITIONS.find(([key]) => key === value)?.[1] ?? value
}

export function ProspectInboundReplyReviewControl({
  messageId,
  review,
}: {
  messageId: string
  review: Review | null
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const [disposition, setDisposition] = useState<Disposition>(review?.disposition ?? 'OTHER')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (active.current || !reason.trim()) return
    active.current = true
    setBusy(true)
    setFeedback(null)
    try {
      await client.admin.reviewProspectInboundReply.mutate({
        operationId: crypto.randomUUID(),
        messageId,
        disposition,
        reason: reason.trim(),
      })
      setFeedback('Human reply classification recorded. No email was sent and no stage changed.')
      setReason('')
      router.refresh()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Reply review could not be recorded.')
    } finally {
      active.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-violet-900">
            Human reply review
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Classify the business intent from the canonical Gmail message. Torchiko does not infer
            sentiment from this preview.
          </p>
        </div>
        {review ? (
          <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-violet-950 ring-1 ring-violet-200">
            {label(review.disposition)} · v{review.revision}
          </span>
        ) : (
          <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-slate-700 ring-1 ring-violet-200">
            Unclassified
          </span>
        )}
      </div>
      {review ? (
        <div className="mt-3 rounded-lg bg-white p-3 ring-1 ring-violet-100">
          <p className="text-xs leading-5 text-slate-700">{review.reason}</p>
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Reviewed {new Date(review.createdAt).toLocaleString()}
          </p>
        </div>
      ) : null}
      <form onSubmit={(event) => void submit(event)} className="mt-3">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_1fr]">
          <label className="text-xs font-semibold text-slate-700">
            Disposition
            <select
              value={disposition}
              onChange={(event) => setDisposition(event.target.value as Disposition)}
              disabled={busy}
              className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 font-normal"
            >
              {DISPOSITIONS.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-700">
            Review reason
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={2000}
              required
              disabled={busy}
              placeholder="What in the full message supports this classification?"
              className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 font-normal"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={busy || !reason.trim()}
          className="mt-3 min-h-11 rounded-lg bg-violet-800 px-3 text-sm font-semibold text-white hover:bg-violet-900 disabled:opacity-50"
        >
          {busy ? 'Recording…' : review ? 'Record a new review' : 'Classify reply'}
        </button>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          This updates founder attention and current CRM evidence only. It cannot send, suppress,
          change pipeline stage, or contact the prospect.
        </p>
        {feedback ? (
          <p role="status" className="mt-2 text-xs text-slate-700">
            {feedback}
          </p>
        ) : null}
      </form>
    </div>
  )
}
