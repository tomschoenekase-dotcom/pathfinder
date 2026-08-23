'use client'

import { useRouter } from 'next/navigation'
import { FormEvent, useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

const CATEGORIES = [
  'CONTRACT_OR_ORDER_FORM',
  'BROCHURE',
  'FLOOR_PLAN_OR_MAP',
  'VENUE_OPERATIONS',
  'CUSTOMER_KNOWLEDGE',
  'GUIDE_MEDIA',
  'OTHER_BUSINESS_RECORD',
] as const

type Category = (typeof CATEGORIES)[number]
type Request = {
  id: string
  status: 'AWAITING_REVIEW' | 'APPROVED_FOR_IMPORT' | 'DECLINED_SOURCE_ONLY'
  category: Category
  purpose: string
  reviewReason: string | null
}

function label(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

export function ProspectAttachmentRetentionControl({
  emailMessageId,
  providerAttachmentId,
  request,
}: {
  emailMessageId: string
  providerAttachmentId: string
  request: Request | null
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const [category, setCategory] = useState<Category>('CUSTOMER_KNOWLEDGE')
  const [purpose, setPurpose] = useState('')
  const [reviewReason, setReviewReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  async function prepare(event: FormEvent) {
    event.preventDefault()
    if (active.current || !purpose.trim()) return
    active.current = true
    setBusy(true)
    setFeedback(null)
    try {
      await client.admin.prepareProspectEmailAttachmentRetention.mutate({
        operationId: crypto.randomUUID(),
        emailMessageId,
        providerAttachmentId,
        category,
        purpose: purpose.trim(),
      })
      setFeedback('Retention review prepared. No attachment bytes were downloaded.')
      router.refresh()
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : 'Retention review could not be prepared.',
      )
    } finally {
      active.current = false
      setBusy(false)
    }
  }

  async function review(decision: 'APPROVE_FOR_IMPORT' | 'KEEP_SOURCE_ONLY') {
    if (active.current || !request || !reviewReason.trim()) return
    active.current = true
    setBusy(true)
    setFeedback(null)
    try {
      await client.admin.reviewProspectEmailAttachmentRetention.mutate({
        requestId: request.id,
        reviewOperationId: crypto.randomUUID(),
        decision,
        reason: reviewReason.trim(),
      })
      setFeedback(
        decision === 'APPROVE_FOR_IMPORT'
          ? 'Approved for a separate import step. No bytes were downloaded or retained.'
          : 'Source-only decision recorded. Gmail remains the canonical source.',
      )
      router.refresh()
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : 'Retention decision could not be recorded.',
      )
    } finally {
      active.current = false
      setBusy(false)
    }
  }

  if (!request) {
    return (
      <form onSubmit={(event) => void prepare(event)} className="mt-3 rounded-lg bg-slate-50 p-3">
        <p className="text-xs font-semibold text-slate-800">Case-by-case retention review</p>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          Preparing a review records metadata only. It does not call Gmail or import the file.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,14rem)_1fr]">
          <label className="text-xs font-semibold text-slate-700">
            Business-record category
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as Category)}
              disabled={busy}
              className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 font-normal"
            >
              {CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-700">
            Why this attachment may be useful
            <input
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              maxLength={2000}
              required
              disabled={busy}
              className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 font-normal"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={busy || !purpose.trim()}
          className="mt-3 min-h-11 rounded-lg bg-sky-700 px-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Preparing…' : 'Prepare retention review'}
        </button>
        {feedback ? (
          <p role="status" className="mt-2 text-xs text-slate-700">
            {feedback}
          </p>
        ) : null}
      </form>
    )
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-800">{label(request.category)}</p>
        <span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold uppercase text-slate-700">
          {label(request.status)}
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">{request.purpose}</p>
      {request.status === 'AWAITING_REVIEW' ? (
        <div className="mt-3">
          <label className="text-xs font-semibold text-slate-700">
            Decision reason
            <input
              value={reviewReason}
              onChange={(event) => setReviewReason(event.target.value)}
              maxLength={2000}
              required
              disabled={busy}
              className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 font-normal"
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !reviewReason.trim()}
              onClick={() => void review('APPROVE_FOR_IMPORT')}
              className="min-h-11 rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              Approve for separate import
            </button>
            <button
              type="button"
              disabled={busy || !reviewReason.trim()}
              onClick={() => void review('KEEP_SOURCE_ONLY')}
              className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 disabled:opacity-50"
            >
              Keep source-linked only
            </button>
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            Approval records authority for a future importer; this control never downloads or stores
            the attachment.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          {request.reviewReason ?? 'Review recorded.'} No provider or storage action was executed.
        </p>
      )}
      {feedback ? (
        <p role="status" className="mt-2 text-xs text-slate-700">
          {feedback}
        </p>
      ) : null}
    </div>
  )
}
