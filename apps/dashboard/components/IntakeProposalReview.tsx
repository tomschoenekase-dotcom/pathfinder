'use client'

import { useState } from 'react'

import { useTRPCClient } from '../lib/trpc'
import { ReviewedVenuePackageDraftForm } from './admin/ReviewedVenuePackageDraftForm'

type Review = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['intake']['getProposalReview']['query']>
>

export function IntakeProposalReview({
  venueId,
  runId,
  adminTenantId,
}: {
  venueId: string
  runId: string
  adminTenantId?: string
}) {
  const client = useTRPCClient()
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function load() {
    setBusy(true)
    setError(null)
    try {
      setReview(
        adminTenantId
          ? await client.admin.getIntakeProposalReview.query({
              tenantId: adminTenantId,
              venueId,
              runId,
            })
          : await client.intake.getProposalReview.query({ venueId, runId }),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Interview review is unavailable.')
    } finally {
      setBusy(false)
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
          {busy ? 'Loading review…' : 'Review interview evidence'}
        </button>
        {error ? (
          <p className="mt-2 text-sm text-rose-700" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    )
  }
  return (
    <section className="mt-4 rounded-xl bg-slate-50 p-4" aria-label="Interview evidence review">
      <p className="text-sm font-medium text-pf-deep">
        {review.role.replaceAll('_', ' ')} · consent{' '}
        {review.consentVerified ? 'verified' : 'invalid'}
      </p>
      <p className="mt-1 text-xs text-pf-deep/65">
        {review.summary.evidenceCount} evidence hash(es) · {review.summary.discrepancyCount}{' '}
        reviewer flag(s) · no automatic approval, apply, or publication
      </p>
      <p className="mt-2 text-sm font-medium text-pf-deep">
        {review.structuredSummary.handoffReady
          ? 'Ready for an operator to create a separate reviewed draft handoff.'
          : 'Not handoff-ready: resolve reviewer flags, consent, or missing public candidate fields.'}
      </p>
      <ol className="mt-3 space-y-3">
        {review.answers.map((answer) => (
          <li
            key={answer.questionId}
            className="rounded-lg border border-pf-light bg-white p-3 text-sm"
          >
            <p className="font-medium text-pf-deep">{answer.prompt}</p>
            <p className="mt-1 text-xs uppercase text-pf-deep/60">
              {answer.fieldPath} · {answer.privacy.replaceAll('_', ' ')} · confidence{' '}
              {Math.round(answer.confidence * 100)}%
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
                      ? 'Text withheld; evidence hash retained.'
                      : 'No text retained.'}
              </p>
            ) : null}
            {answer.discrepancies.length ? (
              <p className="mt-2 text-amber-800" role="status">
                Reviewer attention:{' '}
                {answer.discrepancies.join(', ').replaceAll('_', ' ').toLowerCase()}.
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      {adminTenantId && review.structuredSummary.handoffReady ? (
        <div className="mt-5">
          <ReviewedVenuePackageDraftForm
            tenantId={adminTenantId}
            venueId={venueId}
            intakeRunId={runId}
          />
        </div>
      ) : null}
      <h4 className="mt-4 text-sm font-semibold text-pf-deep">Timeline</h4>
      <ol className="mt-2 space-y-1 text-xs text-pf-deep/70">
        {review.timeline.map((event) => (
          <li key={event.id}>
            {event.kind.replaceAll('_', ' ')} · {event.createdAt.toLocaleString()}
          </li>
        ))}
      </ol>
    </section>
  )
}
