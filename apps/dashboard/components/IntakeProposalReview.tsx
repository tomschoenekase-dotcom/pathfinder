'use client'

import { useEffect, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../lib/trpc'
import { ReviewedVenuePackageDraftForm } from './admin/ReviewedVenuePackageDraftForm'

type ClientReview = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['intake']['getProposalReview']['query']>
>
type AdminReview = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['getIntakeProposalReview']['query']>
>
type Candidate = inferRouterOutputs<AppRouter>['admin']['getIntakeVenuePackageCandidate']

export function IntakeProposalReview({
  venueId,
  runId,
  adminTenantId,
  clientFacing = false,
}: {
  venueId: string
  runId: string
  adminTenantId?: string
  clientFacing?: boolean
}) {
  const client = useTRPCClient()
  const [review, setReview] = useState<ClientReview | AdminReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [busy, setBusy] = useState(false)
  const loadSequence = useRef(0)

  useEffect(() => {
    loadSequence.current += 1
    setReview(null)
    setCandidate(null)
    setError(null)
    setBusy(false)
  }, [adminTenantId, runId, venueId])

  async function load() {
    const sequence = ++loadSequence.current
    setBusy(true)
    setError(null)
    try {
      const nextReview = adminTenantId
        ? await client.admin.getIntakeProposalReview.query({
            tenantId: adminTenantId,
            venueId,
            runId,
          })
        : await client.intake.getProposalReview.query({ venueId, runId })
      if (sequence !== loadSequence.current) return
      setReview(nextReview)
      if (adminTenantId && (nextReview as AdminReview).structuredSummary.handoffReady) {
        const nextCandidate = await client.admin.getIntakeVenuePackageCandidate.query({
          tenantId: adminTenantId,
          venueId,
          runId,
        })
        if (sequence !== loadSequence.current) return
        setCandidate(nextCandidate)
      }
    } catch (cause) {
      if (sequence !== loadSequence.current) return
      setError(
        !clientFacing && cause instanceof Error
          ? cause.message
          : clientFacing
            ? 'Your staff answers are unavailable right now.'
            : 'Interview review is unavailable.',
      )
    } finally {
      if (sequence === loadSequence.current) setBusy(false)
    }
  }
  if (!review) {
    return (
      <div className="mt-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="min-h-11 rounded-full border border-pf-light px-4 text-sm font-medium text-pf-deep disabled:opacity-50"
        >
          {busy
            ? 'Loading…'
            : clientFacing
              ? 'Review what you shared'
              : 'Review interview evidence'}
        </button>
        {error ? (
          <p className="mt-2 text-sm text-rose-700" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    )
  }
  const adminReview = adminTenantId ? (review as AdminReview) : null
  return (
    <section
      className="mt-4 rounded-xl bg-slate-50 p-4"
      aria-label={clientFacing ? 'Staff answers shared' : 'Interview evidence review'}
    >
      <p className="text-sm font-medium text-pf-deep">
        {review.role.replaceAll('_', ' ')} ·{' '}
        {clientFacing
          ? review.consentVerified
            ? 'sharing choices confirmed'
            : 'sharing choices need attention'
          : `consent ${review.consentVerified ? 'verified' : 'invalid'}`}
      </p>
      {clientFacing ? null : (
        <p className="mt-1 text-xs text-pf-deep/65">
          {adminReview!.summary.evidenceCount} evidence hash(es) ·{' '}
          {adminReview!.summary.discrepancyCount} reviewer flag(s) · no automatic approval, apply,
          or publication
        </p>
      )}
      <p className="mt-2 text-sm font-medium text-pf-deep">
        {clientFacing
          ? 'Your answers are available to the PathFinder team for review.'
          : adminReview!.structuredSummary.handoffReady
            ? 'Ready for an operator to create a separate reviewed draft handoff.'
            : 'Not handoff-ready: resolve reviewer flags, consent, or missing public candidate fields.'}
      </p>
      {error ? (
        <div className="mt-3" role="alert">
          <p className="text-sm text-rose-700">{error}</p>
          {adminReview?.structuredSummary.handoffReady ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void load()}
              className="mt-2 min-h-11 rounded-full border border-pf-light bg-white px-4 text-sm font-medium text-pf-deep disabled:opacity-50"
            >
              Retry candidate review
            </button>
          ) : null}
        </div>
      ) : null}
      <ol className="mt-3 space-y-3">
        {review.answers.map((answer) => (
          <li
            key={answer.questionId}
            className="rounded-lg border border-pf-light bg-white p-3 text-sm"
          >
            <p className="font-medium text-pf-deep">{answer.prompt}</p>
            <p className="mt-1 text-xs text-pf-deep/60">
              {clientFacing ? (
                <>
                  {answer.privacy === 'PUBLIC_CANDIDATE'
                    ? 'May be used for visitors'
                    : answer.privacy === 'INTERNAL_CONTEXT'
                      ? 'PathFinder team only'
                      : 'Private'}
                </>
              ) : (
                <>
                  {(answer as AdminReview['answers'][number]).fieldPath} ·{' '}
                  {answer.privacy.replaceAll('_', ' ')} · confidence{' '}
                  {Math.round((answer as AdminReview['answers'][number]).confidence * 100)}%
                </>
              )}
            </p>
            {answer.publicText ? (
              <p className="mt-2 whitespace-pre-wrap text-pf-deep">{answer.publicText}</p>
            ) : null}
            {!answer.publicText ? (
              <p className="mt-2 text-pf-deep/70">
                {answer.skipped
                  ? 'Explicitly skipped; no text retained.'
                  : answer.redacted
                    ? 'Redacted; no text or hash retained.'
                    : answer.hasEvidence
                      ? clientFacing
                        ? 'Answer text kept private.'
                        : 'Text withheld; evidence hash retained.'
                      : 'No text retained.'}
              </p>
            ) : null}
            {!clientFacing && (answer as AdminReview['answers'][number]).discrepancies.length ? (
              <p className="mt-2 text-amber-800" role="status">
                Reviewer attention:{' '}
                {(answer as AdminReview['answers'][number]).discrepancies
                  .join(', ')
                  .replaceAll('_', ' ')
                  .toLowerCase()}
                .
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      {adminTenantId &&
      adminReview?.structuredSummary.handoffReady &&
      candidate?.ready &&
      candidate.payload &&
      candidate.candidateHash ? (
        <div className="mt-5">
          <ReviewedVenuePackageDraftForm
            tenantId={adminTenantId}
            venueId={venueId}
            intakeRunId={runId}
            prefillCandidate={{
              identity: `${candidate.sourceKind}:${candidate.runId}:${candidate.candidateHash}`,
              expectedCandidateHash: candidate.candidateHash,
              payload: candidate.payload,
              source: {
                kind: candidate.sourceKind,
                label: 'reviewed staff interview',
                evidenceCount: adminReview.summary.evidenceCount,
                discrepancyCount: adminReview.summary.discrepancyCount,
                confidence: null,
              },
              warnings: candidate.issues.map((issue) => `${issue.path}: ${issue.message}`),
            }}
          />
        </div>
      ) : null}
      {adminReview?.structuredSummary.handoffReady && candidate && !candidate.ready ? (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4" role="status">
          <p className="text-sm font-semibold text-amber-950">Package candidate needs review</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {candidate.issues.map((issue) => (
              <li key={`${issue.code}:${issue.path}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {clientFacing ? null : (
        <>
          <h4 className="mt-4 text-sm font-semibold text-pf-deep">Timeline</h4>
          <ol className="mt-2 space-y-1 text-xs text-pf-deep/70">
            {adminReview!.timeline.map((event) => (
              <li key={event.id}>
                {event.kind.replaceAll('_', ' ')} · {event.createdAt.toLocaleString()}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}
