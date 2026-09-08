'use client'

import { useState } from 'react'

export type ConversationLearningPolicy = 'VISITOR_AND_EMPLOYEE' | 'EMPLOYEE_ONLY' | 'DISABLED'

export type ConversationLearningCandidate = {
  id: string
  summary: string
  evidenceMessageIds?: string[]
  sourceHref?: string | null
  reviewStatus: 'UNREVIEWED' | 'ACKNOWLEDGED' | 'ACTIONED' | 'DISMISSED' | string
  candidateRevision: number
  reviewerFeedback: string | null
  candidateProvenance: {
    source: 'PUBLIC' | 'SECOND_LAYER'
    kind: 'FACTUAL_CORRECTION' | 'FACTUAL_ADDITION' | 'ALIAS' | 'LOCATION' | 'TEMPORARY_UPDATE'
    verification: 'UNVERIFIED'
    hedged: boolean
  }
}

export type ConversationLearningReviewDecision = 'EDIT' | 'ACCEPT' | 'REJECT'

export type ConversationLearningReview = {
  id: string
  expectedRevision: number
  decision: ConversationLearningReviewDecision
  summary: string
  feedback: string
}

export function ConversationLearningReview({
  policy,
  candidates,
  state = 'ready',
  errorMessage = null,
  pendingId = null,
  onPolicyChange,
  onReview,
}: {
  policy: ConversationLearningPolicy
  candidates: ConversationLearningCandidate[]
  state?: 'ready' | 'loading' | 'error'
  errorMessage?: string | null
  pendingId?: string | null
  onPolicyChange: (policy: ConversationLearningPolicy) => Promise<void>
  onReview: (review: ConversationLearningReview) => Promise<void>
}) {
  const [drafts, setDrafts] = useState<
    Record<string, { revision: number; summary: string; feedback: string }>
  >({})
  const [localError, setLocalError] = useState<string | null>(null)
  const [localPendingId, setLocalPendingId] = useState<string | null>(null)

  function draftFor(candidate: ConversationLearningCandidate) {
    const draft = drafts[candidate.id]
    if (draft?.revision === candidate.candidateRevision) return draft
    return {
      revision: candidate.candidateRevision,
      summary: candidate.summary,
      feedback: candidate.reviewerFeedback ?? '',
    }
  }

  async function submit(
    candidate: ConversationLearningCandidate,
    decision: ConversationLearningReviewDecision,
  ) {
    const draft = draftFor(candidate)
    if (!draft.feedback.trim()) {
      setLocalError(
        `Add reviewer feedback before ${decision === 'REJECT' ? 'rejecting' : decision === 'EDIT' ? 'saving' : 'accepting'} this candidate.`,
      )
      return
    }
    setLocalError(null)
    setLocalPendingId(candidate.id)
    try {
      await onReview({
        id: candidate.id,
        expectedRevision: candidate.candidateRevision,
        decision,
        summary: draft.summary.trim(),
        feedback: draft.feedback.trim(),
      })
    } catch (error) {
      setLocalError(
        error instanceof Error && /revision|conflict|changed/i.test(error.message)
          ? 'This candidate changed while you were reviewing it. Refresh before trying again.'
          : 'The review could not be saved. Try again.',
      )
    } finally {
      setLocalPendingId(null)
    }
  }

  const isDisabled = policy === 'DISABLED'

  return (
    <section aria-labelledby="conversation-learning-heading" className="space-y-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-800">
          Scoped learning review
        </p>
        <h1
          id="conversation-learning-heading"
          className="mt-2 text-3xl font-semibold tracking-tight text-slate-950"
        >
          Conversation candidates
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Possible venue facts stay unverified until a reviewer checks the source and records a
          decision.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <label htmlFor="candidate-policy" className="text-sm font-semibold text-slate-900">
          Candidate sources
        </label>
        <select
          id="candidate-policy"
          value={policy}
          onChange={(event) =>
            void onPolicyChange(event.target.value as ConversationLearningPolicy)
          }
          className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 sm:max-w-sm"
        >
          <option value="VISITOR_AND_EMPLOYEE">Visitors and authenticated employees</option>
          <option value="EMPLOYEE_ONLY">Authenticated employees only</option>
          <option value="DISABLED">Disabled</option>
        </select>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          {isDisabled
            ? 'New conversation candidates are disabled for this venue.'
            : 'Candidates remain review evidence and do not change canonical knowledge by themselves.'}
        </p>
      </div>

      {state === 'loading' ? (
        <div
          role="status"
          className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600"
        >
          Loading conversation candidates…
        </div>
      ) : state === 'error' ? (
        <div
          role="alert"
          className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-800"
        >
          {errorMessage ?? 'Conversation candidates could not be loaded. Try again.'}
        </div>
      ) : isDisabled || candidates.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
          {isDisabled
            ? 'Candidate discovery is disabled.'
            : 'No conversation candidates are waiting for review.'}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {candidates.map((candidate) => {
            const draft = draftFor(candidate)
            const pending = pendingId === candidate.id || localPendingId === candidate.id
            const anyOperationPending = pendingId !== null || localPendingId !== null
            const terminal =
              candidate.reviewStatus === 'ACTIONED' || candidate.reviewStatus === 'DISMISSED'
            const source =
              candidate.candidateProvenance.source === 'SECOND_LAYER'
                ? 'Authenticated employee'
                : 'Visitor'
            return (
              <article
                key={candidate.id}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-900">
                    Unverified · {source}
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {candidate.candidateProvenance.kind.replaceAll('_', ' ').toLowerCase()}
                  </span>
                </div>
                <p className="mt-4 text-sm leading-6 text-slate-700">{candidate.summary}</p>
                <p className="mt-2 text-xs text-slate-500">
                  Linguistic hedging:{' '}
                  {candidate.candidateProvenance.hedged ? 'present' : 'not detected'} · Review
                  state: {candidate.reviewStatus}
                </p>
                {candidate.sourceHref?.startsWith('/') ? (
                  <a
                    href={candidate.sourceHref}
                    className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-sky-200 px-3 py-2 text-sm font-semibold text-sky-800 hover:bg-sky-50"
                  >
                    Review source conversation
                  </a>
                ) : null}
                <label
                  htmlFor={`candidate-summary-${candidate.id}`}
                  className="mt-4 block text-sm font-semibold text-slate-900"
                >
                  Proposed review summary
                </label>
                <textarea
                  id={`candidate-summary-${candidate.id}`}
                  value={draft.summary}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [candidate.id]: {
                        ...draft,
                        revision: candidate.candidateRevision,
                        summary: event.target.value,
                      },
                    }))
                  }
                  rows={3}
                  maxLength={500}
                  className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm leading-6 text-slate-900"
                />
                <label
                  htmlFor={`candidate-feedback-${candidate.id}`}
                  className="mt-4 block text-sm font-semibold text-slate-900"
                >
                  Reviewer feedback <span className="font-normal text-slate-500">(required)</span>
                </label>
                <textarea
                  id={`candidate-feedback-${candidate.id}`}
                  value={draft.feedback}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [candidate.id]: {
                        ...draft,
                        revision: candidate.candidateRevision,
                        feedback: event.target.value,
                      },
                    }))
                  }
                  rows={3}
                  maxLength={1000}
                  className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm leading-6 text-slate-900"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={terminal || anyOperationPending}
                    onClick={() => void submit(candidate, 'ACCEPT')}
                    className="min-h-11 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    {pending ? 'Saving…' : 'Accept for proposal'}
                  </button>
                  <button
                    type="button"
                    disabled={terminal || anyOperationPending}
                    onClick={() => void submit(candidate, 'REJECT')}
                    className="min-h-11 rounded-lg border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-800 disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    disabled={terminal || anyOperationPending}
                    onClick={() => void submit(candidate, 'EDIT')}
                    className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 disabled:opacity-50"
                  >
                    Save edit
                  </button>
                </div>
                <p className="mt-3 text-xs leading-5 text-slate-500">
                  Accepted candidates still need a reviewed knowledge proposal.
                </p>
              </article>
            )
          })}
        </div>
      )}
      {localError ? (
        <p role="alert" className="text-sm font-medium text-rose-700">
          {localError}
        </p>
      ) : null}
    </section>
  )
}
