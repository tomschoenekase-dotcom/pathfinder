'use client'

import { useRouter } from 'next/navigation'
import { FormEvent, useEffect, useRef, useState } from 'react'

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
type DeliveryAttempt = {
  id: string
  status: 'DRAFT'
  recipientEmailSnapshot: string
  templateVersion: string
  subject: string
  textBody: string
  createdAt: Date | string
}

function label(value: Disposition) {
  return DISPOSITIONS.find(([key]) => key === value)?.[1] ?? value
}

export function ProspectInboundReplyReviewControl({
  messageId,
  review,
  deliveryAttempt: initialDeliveryAttempt = null,
}: {
  messageId: string
  review: Review | null
  deliveryAttempt?: DeliveryAttempt | null
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const scope = useRef({ messageId, generation: 0 })
  if (scope.current.messageId !== messageId) {
    scope.current = { messageId, generation: scope.current.generation + 1 }
  }
  const reviewIdentity = `${review?.id ?? 'none'}:${review?.revision ?? 0}`
  const [disposition, setDisposition] = useState<Disposition>(review?.disposition ?? 'OTHER')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [deliveryState, setDeliveryState] = useState({
    messageId,
    value: initialDeliveryAttempt,
  })
  const [confirmedReview, setConfirmedReview] = useState<{
    messageId: string
    baseline: string
    disposition: Disposition
  } | null>(null)
  const deliveryAttempt =
    deliveryState.messageId === messageId ? deliveryState.value : initialDeliveryAttempt
  const effectiveReviewDisposition =
    confirmedReview?.messageId === messageId && confirmedReview.baseline === reviewIdentity
      ? confirmedReview.disposition
      : review?.disposition
  const isHistoricalDraft = Boolean(
    deliveryAttempt &&
    effectiveReviewDisposition &&
    effectiveReviewDisposition !== 'POSITIVE_INTEREST',
  )

  useEffect(() => {
    active.current = false
    setBusy(false)
    setFeedback(null)
    setReason('')
    setDisposition('OTHER')
    setDeliveryState({ messageId, value: null })
    setConfirmedReview(null)
  }, [messageId])

  useEffect(() => {
    setDeliveryState({ messageId, value: initialDeliveryAttempt })
  }, [initialDeliveryAttempt, messageId])

  useEffect(() => {
    setDisposition(review?.disposition ?? 'OTHER')
    setConfirmedReview(null)
  }, [messageId, review?.disposition, reviewIdentity])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (active.current || !reason.trim()) return
    active.current = true
    setBusy(true)
    setFeedback(null)
    const submittedMessageId = messageId
    const submittedGeneration = scope.current.generation
    const submittedDisposition = disposition
    try {
      const result = await client.admin.reviewProspectInboundReply.mutate({
        operationId: crypto.randomUUID(),
        messageId,
        disposition,
        reason: reason.trim(),
      })
      if (
        scope.current.messageId !== submittedMessageId ||
        scope.current.generation !== submittedGeneration
      )
        return
      if (result.deliveryAttempt) {
        setDeliveryState({ messageId: submittedMessageId, value: result.deliveryAttempt })
      }
      setConfirmedReview({
        messageId: submittedMessageId,
        baseline: reviewIdentity,
        disposition: result.review?.disposition ?? submittedDisposition,
      })
      setFeedback('Human reply classification recorded. No email was sent and no stage changed.')
      setReason('')
      router.refresh()
    } catch (error) {
      if (
        scope.current.messageId !== submittedMessageId ||
        scope.current.generation !== submittedGeneration
      )
        return
      setFeedback(error instanceof Error ? error.message : 'Reply review could not be recorded.')
    } finally {
      if (
        scope.current.messageId === submittedMessageId &&
        scope.current.generation === submittedGeneration
      ) {
        active.current = false
        setBusy(false)
      }
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
      {deliveryAttempt ? (
        <details className="mt-3 rounded-lg bg-white ring-1 ring-violet-100">
          <summary className="flex min-h-11 cursor-pointer items-center px-3 text-xs font-bold text-violet-950">
            {isHistoricalDraft ? 'Historical invitation draft' : 'Invitation draft'} ·{' '}
            {deliveryAttempt.status}
          </summary>
          <div className="border-t border-violet-100 p-3 text-xs leading-5 text-slate-700">
            <p>
              <strong>Recipient:</strong> {deliveryAttempt.recipientEmailSnapshot}
            </p>
            <p>
              <strong>Subject:</strong> {deliveryAttempt.subject}
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words">{deliveryAttempt.textBody}</p>
            <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Template {deliveryAttempt.templateVersion} · saved{' '}
              {new Date(deliveryAttempt.createdAt).toLocaleString()}
            </p>
            <p className="mt-1 font-semibold text-violet-900">Draft only · nothing was sent.</p>
            {isHistoricalDraft ? (
              <p className="mt-1 text-slate-600">
                Retained for audit after the current classification changed. This draft is not send
                eligible.
              </p>
            ) : null}
          </div>
        </details>
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
