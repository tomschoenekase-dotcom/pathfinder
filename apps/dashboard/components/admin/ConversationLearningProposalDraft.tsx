'use client'

import { useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'

const PROPOSED_CHANGE_LIMIT = 10_000
const REASON_LIMIT = 2_000

type Candidate = {
  id: string
  summary: string
  reviewerFeedback: string | null
}

type DraftState = {
  candidateId: string
  proposedChange: string
  reason: string
}

export function ConversationLearningProposalDraft({
  candidate,
  onCreate,
  disabled = false,
}: {
  candidate: Candidate
  onCreate: (input: { proposedChange: string; reason: string }) => Promise<void>
  disabled?: boolean
}) {
  const fieldId = useId()
  const active = useRef(false)
  const [draftState, setDraftState] = useState<DraftState>({
    candidateId: candidate.id,
    proposedChange: '',
    reason: candidate.reviewerFeedback ?? '',
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const draft =
    draftState.candidateId === candidate.id
      ? draftState
      : {
          candidateId: candidate.id,
          proposedChange: '',
          reason: candidate.reviewerFeedback ?? '',
        }

  function updateDraft(change: Partial<Pick<DraftState, 'proposedChange' | 'reason'>>) {
    setDraftState({ ...draft, ...change })
    setError(null)
    setSuccess(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (active.current || disabled) return

    const proposedChange = draft.proposedChange.trim()
    const reason = draft.reason.trim()
    if (
      proposedChange.length < 1 ||
      proposedChange.length > PROPOSED_CHANGE_LIMIT ||
      reason.length < 1 ||
      reason.length > REASON_LIMIT
    ) {
      setError('Add a proposed change and reason within the stated limits.')
      return
    }

    active.current = true
    setPending(true)
    setError(null)
    setSuccess(null)
    try {
      await onCreate({ proposedChange, reason })
      setSuccess(
        'Proposal draft created for separate human review. Venue knowledge was not changed.',
      )
    } catch {
      setError('The proposal draft could not be created. Your entries are still here.')
    } finally {
      active.current = false
      setPending(false)
    }
  }

  const unavailable = disabled || pending
  const canSubmit =
    !unavailable &&
    draft.proposedChange.trim().length >= 1 &&
    draft.proposedChange.trim().length <= PROPOSED_CHANGE_LIMIT &&
    draft.reason.trim().length >= 1 &&
    draft.reason.trim().length <= REASON_LIMIT

  return (
    <details className="mt-4 rounded-xl border border-sky-200 bg-sky-50/60 p-4">
      <summary
        className="min-h-11 cursor-pointer content-center text-sm font-semibold text-sky-900"
        aria-disabled={disabled}
      >
        Prepare proposal draft
      </summary>
      <div className="mt-3 border-t border-sky-200 pt-4">
        <p className="text-sm leading-6 text-slate-700">Candidate summary: {candidate.summary}</p>
        <p className="mt-2 text-xs leading-5 text-amber-900" id={`${fieldId}-boundary`}>
          This candidate is still unverified. Creating a draft does not approve it or update the
          venue guide.
        </p>
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => void submit(event)}
          aria-busy={pending}
          aria-describedby={`${fieldId}-boundary`}
        >
          <label className="grid gap-2 text-sm font-semibold text-slate-900">
            Proposed canonical change
            <textarea
              value={draft.proposedChange}
              onChange={(event) => updateDraft({ proposedChange: event.target.value })}
              rows={5}
              minLength={1}
              maxLength={PROPOSED_CHANGE_LIMIT}
              required
              disabled={unavailable}
              className="rounded-xl border border-sky-200 bg-white px-3 py-2 font-normal leading-6"
            />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-slate-900">
            Evidence-based reason
            <textarea
              value={draft.reason}
              onChange={(event) => updateDraft({ reason: event.target.value })}
              rows={3}
              minLength={1}
              maxLength={REASON_LIMIT}
              required
              disabled={unavailable}
              className="rounded-xl border border-sky-200 bg-white px-3 py-2 font-normal leading-6"
            />
          </label>
          <button
            type="submit"
            disabled={!canSubmit}
            className="min-h-11 rounded-lg bg-sky-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? 'Creating draft…' : 'Create proposal draft'}
          </button>
        </form>
        {error ? (
          <p className="mt-3 text-sm font-medium text-rose-700" role="alert">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="mt-3 text-sm font-medium text-emerald-800" role="status">
            {success}
          </p>
        ) : null}
      </div>
    </details>
  )
}
