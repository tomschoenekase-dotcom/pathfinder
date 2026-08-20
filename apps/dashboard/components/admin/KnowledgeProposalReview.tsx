'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

export type KnowledgeProposal = {
  id: string
  status: string
  observedVisitorClaim: string | null
  aiInference: string | null
  proposedChange: string
  reason: string
  confidence: number
  evidenceMessageIds: string[]
  targetKnowledgeEntryId: string | null
  createdAt: Date | string
  updatedAt: Date | string
  reviewerId: string | null
  reviewNote: string | null
  reviewedAt: Date | string | null
}

function ProposalActions({
  tenantId,
  venueId,
  proposal,
}: {
  tenantId: string
  venueId: string
  proposal: KnowledgeProposal
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function review(decision: 'APPROVED' | 'REJECTED') {
    if (!note.trim()) return
    setPending(true)
    setError(null)
    try {
      await client.admin.reviewKnowledgeProposal.mutate({
        operationId: crypto.randomUUID(),
        tenantId,
        venueId,
        proposalId: proposal.id,
        expectedUpdatedAt: new Date(proposal.updatedAt).toISOString(),
        decision,
        reviewNote: note.trim(),
      })
      router.refresh()
    } catch {
      setError('The proposal changed or could not be reviewed. Refresh and try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <label className="text-sm font-semibold text-slate-800" htmlFor={`review-${proposal.id}`}>
        Review note
      </label>
      <textarea
        id={`review-${proposal.id}`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={2000}
        rows={3}
        className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || !note.trim()}
          onClick={() => void review('APPROVED')}
          className="min-h-10 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
        >
          Approve evidence
        </button>
        <button
          type="button"
          disabled={pending || !note.trim()}
          onClick={() => void review('REJECTED')}
          className="min-h-10 rounded-lg border border-rose-300 px-4 text-sm font-semibold text-rose-800 disabled:opacity-50"
        >
          Reject proposal
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Approval records a human decision only. It does not publish or overwrite canonical
        knowledge.
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function KnowledgeProposalReview({
  tenantId,
  venueId,
  proposals,
}: {
  tenantId: string
  venueId: string
  proposals: KnowledgeProposal[]
}) {
  return (
    <section className="space-y-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-800">
          Knowledge improvement
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          Review proposed changes
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Visitor observations, AI inference, and proposed canonical changes remain visibly separate
          until a human reviews the evidence.
        </p>
      </div>
      {proposals.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 p-6 text-sm text-slate-600">
          No knowledge proposals are waiting for review.
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {proposals.map((proposal) => (
            <article
              key={proposal.id}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold uppercase tracking-wider text-amber-800">
                  {proposal.status.replaceAll('_', ' ')}
                </span>
                <span className="text-xs text-slate-500">
                  {Math.round(proposal.confidence * 100)}% confidence
                </span>
              </div>
              {proposal.observedVisitorClaim ? (
                <div className="mt-4">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Observed visitor claim
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-slate-700">
                    {proposal.observedVisitorClaim}
                  </p>
                </div>
              ) : null}
              {proposal.aiInference ? (
                <div className="mt-4">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    AI inference
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-slate-700">{proposal.aiInference}</p>
                </div>
              ) : null}
              <div className="mt-4 rounded-xl bg-sky-50 p-4">
                <h2 className="text-xs font-bold uppercase tracking-wider text-sky-900">
                  Proposed change
                </h2>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-800">
                  {proposal.proposedChange}
                </p>
              </div>
              <p className="mt-3 text-sm text-slate-600">
                <span className="font-semibold text-slate-800">Reason:</span> {proposal.reason}
              </p>
              {proposal.status === 'PENDING_REVIEW' ? (
                <ProposalActions tenantId={tenantId} venueId={venueId} proposal={proposal} />
              ) : proposal.reviewNote ? (
                <p className="mt-4 border-t border-slate-200 pt-4 text-sm text-slate-600">
                  <span className="font-semibold">Review:</span> {proposal.reviewNote}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
