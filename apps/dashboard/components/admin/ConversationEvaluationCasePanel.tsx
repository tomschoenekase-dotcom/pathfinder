'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

export type EvaluationSourceInsight = {
  id: string
  sessionId: string
  category: string
  severity: string
  summary: string
  visitorQuestion: string
  assistantAnswer: string
  createdAt: Date
}

export type RejectedConversationCandidate = {
  id: string
  category: 'CONTENT_UPDATE_CANDIDATE'
  summary: string
  reviewerFeedback: string
  candidateRevision: number
  reviewedAt: Date | null
}

type SelectedSource =
  | { kind: 'INSIGHT'; id: string }
  | { kind: 'REJECTED_CANDIDATE'; id: string }
  | null

function firstSource(
  insights: EvaluationSourceInsight[],
  rejectedCandidates?: RejectedConversationCandidate[],
): SelectedSource {
  const insight = insights[0]
  if (insight) return { kind: 'INSIGHT', id: insight.id }
  const rejected = rejectedCandidates?.[0]
  return rejected ? { kind: 'REJECTED_CANDIDATE', id: rejected.id } : null
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function ConversationEvaluationCasePanel(props: {
  tenantId: string
  venueId: string
  insights: EvaluationSourceInsight[]
  rejectedCandidates?: RejectedConversationCandidate[]
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const initialSource = firstSource(props.insights, props.rejectedCandidates)
  const [selectedSource, setSelectedSource] = useState<SelectedSource>(initialSource)
  const [sanitizedQuestion, setSanitizedQuestion] = useState('')
  const [expectation, setExpectation] = useState<'KNOWN_ANSWER' | 'UNKNOWN_ANSWER'>('KNOWN_ANSWER')
  const [acceptablePhrases, setAcceptablePhrases] = useState('')
  const [forbiddenPhrases, setForbiddenPhrases] = useState('')
  const [maxWords, setMaxWords] = useState('200')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const submitting = useRef(false)
  const requestGeneration = useRef(0)

  useEffect(() => {
    requestGeneration.current += 1
    setSelectedSource(firstSource(props.insights, props.rejectedCandidates))
    setSanitizedQuestion('')
    setExpectation('KNOWN_ANSWER')
    setAcceptablePhrases('')
    setForbiddenPhrases('')
    setMaxWords('200')
    setConfirmed(false)
    setMessage(null)
    return () => {
      requestGeneration.current += 1
    }
  }, [props.tenantId, props.venueId, props.insights, props.rejectedCandidates])

  function choose(source: string) {
    requestGeneration.current += 1
    const [kind, id] = source.split(':')
    if (!id || (kind !== 'insight' && kind !== 'rejected')) {
      setSelectedSource(null)
    } else if (kind === 'insight') {
      setSelectedSource({ kind: 'INSIGHT', id })
    } else {
      setSelectedSource({ kind: 'REJECTED_CANDIDATE', id })
    }
    setSanitizedQuestion('')
    setAcceptablePhrases('')
    setForbiddenPhrases('')
    setConfirmed(false)
    setMessage(null)
  }

  const selectedInsight =
    selectedSource?.kind === 'INSIGHT'
      ? props.insights.find((item) => item.id === selectedSource.id)
      : undefined
  const selectedRejected =
    selectedSource?.kind === 'REJECTED_CANDIDATE'
      ? props.rejectedCandidates?.find((item) => item.id === selectedSource.id)
      : undefined
  const selected = selectedInsight ?? selectedRejected

  async function prepare() {
    const expected = lines(acceptablePhrases)
    const forbidden = lines(forbiddenPhrases)
    const maximum = Number(maxWords)
    if (
      !selected ||
      submitting.current ||
      !sanitizedQuestion.trim() ||
      expected.length === 0 ||
      !Number.isInteger(maximum) ||
      maximum < 1 ||
      maximum > 1_000 ||
      !confirmed
    ) {
      setMessage(
        'Choose evidence, provide a sanitized question and at least one expected phrase, enter 1–1,000 words, and confirm redaction.',
      )
      return
    }
    submitting.current = true
    setBusy(true)
    setMessage(null)
    const generationAtStart = requestGeneration.current
    try {
      const result = await client.admin.prepareConversationEvaluationCase.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        insightId: selected.id,
        sanitizedQuestion: sanitizedQuestion.trim(),
        expectation,
        acceptablePhrases: expected,
        forbiddenPhrases: forbidden,
        maxWords: maximum,
        sanitizationConfirmed: true,
        ...(selectedRejected
          ? { expectedCandidateRevision: selectedRejected.candidateRevision }
          : {}),
      })
      if (requestGeneration.current === generationAtStart) {
        setMessage(
          `Evaluation case revision ${result.revision} ${result.replayed ? 'replayed exactly' : 'created'}. No AI run was started.`,
        )
        router.refresh()
      }
    } catch {
      if (requestGeneration.current === generationAtStart) {
        setMessage(
          'The case could not be prepared. Confirm the insight is still reviewable and the phrases are unique. No partial case was committed.',
        )
      }
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <section
      className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-6"
      aria-labelledby="conversation-evaluation-heading"
    >
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
        Production learning loop
      </p>
      <h3 id="conversation-evaluation-heading" className="mt-1 text-xl font-semibold text-pf-deep">
        Prepare a sanitized failure case
      </h3>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/70">
        Convert reviewed guest evidence into an immutable regression case. Only your redacted
        question and explicit answer rules enter the evaluation snapshot.
      </p>
      {props.insights.length === 0 && !props.rejectedCandidates?.length ? (
        <p className="mt-4 rounded-2xl border border-dashed border-pf-light p-5 text-sm text-pf-deep/65">
          No unresolved answer-quality insights are ready for this venue.
        </p>
      ) : (
        <>
          <label className="mt-4 block text-sm font-semibold text-pf-deep">
            Reviewable source evidence
            <select
              aria-label="Reviewable source evidence"
              value={
                selectedSource
                  ? `${selectedSource.kind === 'INSIGHT' ? 'insight' : 'rejected'}:${selectedSource.id}`
                  : ''
              }
              onChange={(event) => choose(event.target.value)}
              disabled={busy}
              className="mt-2 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3"
            >
              {props.insights.map((insight) => (
                <option key={`insight:${insight.id}`} value={`insight:${insight.id}`}>
                  {insight.category.replace(/_/g, ' ')} · {insight.createdAt.toLocaleString()}
                </option>
              ))}
              {props.rejectedCandidates?.map((candidate) => (
                <option key={`rejected:${candidate.id}`} value={`rejected:${candidate.id}`}>
                  Rejected candidate · revision {candidate.candidateRevision}
                </option>
              ))}
            </select>
          </label>
          {selectedRejected ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-700">
                  Rejected content candidate
                </p>
                <span className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                  Dismissed
                </span>
              </div>
              <p className="mt-3 break-words whitespace-pre-wrap text-sm leading-6 text-pf-deep/85">
                {selectedRejected.summary}
              </p>
              <div className="mt-4 border-l-2 border-slate-300 pl-3">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-600">
                  Reviewer feedback
                </p>
                <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-6 text-pf-deep/75">
                  {selectedRejected.reviewerFeedback}
                </p>
              </div>
              <p className="mt-3 text-xs text-pf-deep/75">
                Reviewed {selectedRejected.reviewedAt?.toLocaleString() ?? 'date unavailable'} ·
                candidate revision {selectedRejected.candidateRevision}
              </p>
              <p className="mt-3 text-xs text-pf-deep/75">
                The original conversation is not loaded here. Enter a new sanitized question and
                expected answer below if this rejected candidate should become an evaluation case.
              </p>
            </div>
          ) : selectedInsight ? (
            <div className="mt-4 grid gap-3 lg:grid-cols-2" aria-label="Exact source evidence">
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-amber-950">
                  Original visitor question
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-amber-950/85">
                  {selectedInsight.visitorQuestion}
                </p>
              </div>
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-rose-950">
                  Answer under review
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-rose-950/85">
                  {selectedInsight.assistantAnswer}
                </p>
              </div>
              <div className="lg:col-span-2 flex flex-wrap items-center gap-3 text-xs text-pf-deep/75">
                <span>{selectedInsight.summary}</span>
                <Link
                  href={`/admin/clients/${props.tenantId}/venues/${props.venueId}/chatlogs/${selectedInsight.sessionId}`}
                  className="min-h-11 rounded-xl border border-pf-light bg-white px-4 py-3 font-semibold text-pf-primary"
                >
                  Review full source conversation
                </Link>
              </div>
            </div>
          ) : null}
          <label className="mt-5 block text-sm font-semibold text-pf-deep">
            Sanitized visitor question
            <textarea
              aria-label="Sanitized visitor question"
              value={sanitizedQuestion}
              onChange={(event) => setSanitizedQuestion(event.target.value)}
              disabled={busy}
              rows={3}
              maxLength={2_000}
              placeholder="Rewrite the exact question without names, contact details, or other personal data."
              className="mt-2 w-full rounded-xl border border-pf-light p-3"
            />
          </label>
          <label className="mt-4 block text-sm font-semibold text-pf-deep">
            Expected behavior
            <select
              aria-label="Expected behavior"
              value={expectation}
              onChange={(event) =>
                setExpectation(event.target.value as 'KNOWN_ANSWER' | 'UNKNOWN_ANSWER')
              }
              disabled={busy}
              className="mt-2 block min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 sm:max-w-md"
            >
              <option value="KNOWN_ANSWER">Answer with a verified fact</option>
              <option value="UNKNOWN_ANSWER">Acknowledge that the answer is unknown</option>
            </select>
          </label>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <label className="block text-sm font-semibold text-pf-deep">
              {expectation === 'KNOWN_ANSWER'
                ? 'Acceptable verified phrases'
                : 'Acceptable unknown-answer phrases'}
              <textarea
                aria-label="Acceptable answer phrases"
                value={acceptablePhrases}
                onChange={(event) => setAcceptablePhrases(event.target.value)}
                disabled={busy}
                rows={4}
                placeholder="One acceptable phrase per line"
                className="mt-2 w-full rounded-xl border border-pf-light p-3"
              />
            </label>
            <label className="block text-sm font-semibold text-pf-deep">
              Forbidden phrases (optional)
              <textarea
                aria-label="Forbidden answer phrases"
                value={forbiddenPhrases}
                onChange={(event) => setForbiddenPhrases(event.target.value)}
                disabled={busy}
                rows={4}
                placeholder="One phrase per line"
                className="mt-2 w-full rounded-xl border border-pf-light p-3"
              />
            </label>
          </div>
          <label className="mt-4 block text-sm font-semibold text-pf-deep">
            Maximum answer length (words)
            <input
              aria-label="Maximum answer length"
              type="number"
              min={1}
              max={1_000}
              value={maxWords}
              onChange={(event) => setMaxWords(event.target.value)}
              disabled={busy}
              className="mt-2 block min-h-11 w-full max-w-xs rounded-xl border border-pf-light px-3"
            />
          </label>
          <label className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <input
              aria-label="Confirm evaluation case redaction"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={busy}
              className="mt-1"
            />
            <span>
              I reviewed every case field and removed personal, sensitive, and customer-identifying
              data that is not required for this regression test.
            </span>
          </label>
          <button
            type="button"
            onClick={prepare}
            disabled={busy || !selected || !confirmed}
            className="mt-4 min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Preparing…' : 'Prepare immutable case'}
          </button>
        </>
      )}
      {message ? (
        <p role="status" className="mt-3 text-sm text-pf-deep/75">
          {message}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-pf-deep/75">
        {selectedRejected
          ? 'This action records a new sanitized evaluation case from a dismissed candidate. It does not reopen the candidate or change venue content.'
          : 'This action acknowledges the insight and prepares case evidence only. It does not call a model, set a pass threshold, change venue content, or release anything.'}
      </p>
    </section>
  )
}
