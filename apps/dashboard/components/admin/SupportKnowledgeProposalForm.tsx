'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type EvidenceMessage = {
  id: string
  authorKind: string
  visibility: string
  body: string
  requestVersion: number | null
  createdAt: Date
}

const correctionKinds = [
  ['CREATE_KNOWLEDGE', 'Create verified knowledge'],
  ['UPDATE_KNOWLEDGE', 'Update existing knowledge'],
  ['RETIRE_KNOWLEDGE', 'Retire stale knowledge'],
  ['RETRIEVAL_CORRECTION', 'Correct retrieval behavior'],
  ['NO_CONTENT_CHANGE', 'No canonical content change'],
] as const

export function SupportKnowledgeProposalForm({
  tenantId,
  venueId,
  requestId,
  expectedVersion,
  eligible,
  messages,
}: {
  tenantId: string
  venueId: string
  requestId: string
  expectedVersion: number
  eligible: boolean
  messages: EvidenceMessage[]
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const evidenceMessages = messages.filter(
    (message) => message.requestVersion !== null && message.requestVersion <= expectedVersion,
  )
  const [selectedIds, setSelectedIds] = useState<string[]>(
    evidenceMessages
      .filter((message) => message.visibility === 'CLIENT_VISIBLE')
      .map((message) => message.id),
  )
  const [correctionKind, setCorrectionKind] =
    useState<(typeof correctionKinds)[number][0]>('UPDATE_KNOWLEDGE')
  const [proposedChange, setProposedChange] = useState('')
  const [reason, setReason] = useState('')
  const [confidencePercent, setConfidencePercent] = useState(70)
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  function toggle(messageId: string) {
    setSelectedIds((current) =>
      current.includes(messageId)
        ? current.filter((candidate) => candidate !== messageId)
        : [...current, messageId],
    )
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (
      active.current ||
      !eligible ||
      selectedIds.length === 0 ||
      !proposedChange.trim() ||
      !reason.trim()
    )
      return
    active.current = true
    setPending(true)
    setFeedback(null)
    try {
      await client.admin.createSupportKnowledgeProposal.mutate({
        operationId: crypto.randomUUID(),
        tenantId,
        venueId,
        supportRequestId: requestId,
        expectedVersion,
        evidenceMessageIds: selectedIds,
        correctionKind,
        proposedChange: proposedChange.trim(),
        reason: reason.trim(),
        confidence: confidencePercent / 100,
      })
      setFeedback(
        'Proposal prepared for separate human review. No venue knowledge was changed or published.',
      )
      setProposedChange('')
      setReason('')
      router.refresh()
    } catch {
      setFeedback(
        'The proposal outcome could not be confirmed. Refresh to inspect lineage before trying again.',
      )
      router.refresh()
    } finally {
      active.current = false
      setPending(false)
    }
  }

  return (
    <section className="rounded-3xl border border-sky-200 bg-sky-50 p-5 shadow-sm">
      <h3 className="text-lg font-semibold text-pf-deep">Prepare a knowledge correction</h3>
      <p className="mt-1 text-sm leading-6 text-pf-deep/70">
        Bind this exact reviewed request version and selected immutable messages to a proposal. A
        different human review is still required; this cannot publish or contact the client.
      </p>
      {!eligible ? (
        <p className="mt-4 text-sm text-pf-deep/70">
          Move a content-correction request into review before preparing a proposal.
        </p>
      ) : evidenceMessages.length === 0 ? (
        <p className="mt-4 text-sm text-pf-deep/70">
          At least one message with an exact produced request version is required as evidence.
        </p>
      ) : (
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => void submit(event)}
          aria-busy={pending}
        >
          <fieldset>
            <legend className="text-sm font-semibold text-pf-deep">Exact message evidence</legend>
            <div className="mt-2 grid gap-2">
              {evidenceMessages.map((message) => (
                <label
                  key={message.id}
                  className="flex min-w-0 items-start gap-3 rounded-xl border border-sky-200 bg-white p-3 text-sm text-pf-deep"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(message.id)}
                    onChange={() => toggle(message.id)}
                    disabled={pending}
                    className="mt-1 size-4 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-bold uppercase tracking-wide text-pf-primary">
                      {message.authorKind} · {message.visibility.replaceAll('_', ' ')} · request v
                      {message.requestVersion}
                    </span>
                    <span className="mt-1 block break-words leading-6">
                      {message.body.length > 240
                        ? `${message.body.slice(0, 237)}...`
                        : message.body}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="grid gap-2 text-sm font-semibold text-pf-deep">
            Correction type
            <select
              value={correctionKind}
              onChange={(event) =>
                setCorrectionKind(event.target.value as (typeof correctionKinds)[number][0])
              }
              disabled={pending}
              className="min-h-11 rounded-xl border border-sky-200 bg-white px-3 font-normal"
            >
              {correctionKinds.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-semibold text-pf-deep">
            Proposed canonical change
            <textarea
              value={proposedChange}
              onChange={(event) => setProposedChange(event.target.value)}
              rows={5}
              maxLength={10000}
              disabled={pending}
              className="rounded-xl border border-sky-200 bg-white px-3 py-2 font-normal"
            />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-pf-deep">
            Evidence-based reason
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={2000}
              disabled={pending}
              className="rounded-xl border border-sky-200 bg-white px-3 py-2 font-normal"
            />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-pf-deep">
            Evidence confidence: {confidencePercent}%
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={confidencePercent}
              onChange={(event) => setConfidencePercent(Number(event.target.value))}
              disabled={pending}
            />
          </label>
          <button
            type="submit"
            disabled={
              pending || selectedIds.length === 0 || !proposedChange.trim() || !reason.trim()
            }
            className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? 'Preparing…' : 'Prepare review proposal'}
          </button>
        </form>
      )}
      {feedback ? (
        <p className="mt-3 text-sm text-pf-deep/75" role="status">
          {feedback}
        </p>
      ) : null}
    </section>
  )
}
