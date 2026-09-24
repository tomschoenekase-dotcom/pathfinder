import React from 'react'

export type OutreachReviewDocument = {
  cohortId: string
  name: string
  question: unknown
  count: number
  readyForHumanReview: number
  reviewHash: string
  sender: string
  SEND_AUTHORIZED: false
  status?: string
  pausedAt?: string | null
  preparationAvailable?: boolean
  rows: {
    memberId: string
    organizationId: string
    venueId: string | null
    name: string
    state: string
    recipient: string | null
    reasons: string[]
    nativeRead: string
    exactSelectedDraft: boolean
    stale: boolean | null
    suppression: { blocked: boolean; reasons: string[] }
    outreachState: string
    correspondenceState: string
    sourceState: string
    draft: {
      id: string
      version: number
      contentHash: string
      subject: string
      body: string
      state: string
      generatedBy: string | null
    } | null
    threadCoverage: { id: string; count: number; complete: boolean; issues: string[] }[]
    operational: unknown
  }[]
}
/** Shared normal-app/synthetic presenter. React escapes source and email text. */
export function ProspectOutreachReviewDocument({ review }: { review: OutreachReviewDocument }) {
  return (
    <section aria-label="Exact outreach preparation review" className="space-y-5">
      <header className="rounded-lg border bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
          Preparation only · No send authorization
        </p>
        <h2 className="mt-2 text-2xl font-semibold">{review.name}</h2>
        <p className="mt-2">{String(review.question ?? '')}</p>
        <p className="mt-3">
          All {review.count} selected records are shown. {review.readyForHumanReview} have a current
          pinned draft for human review.
        </p>
        <p className="text-sm">Company sender: {review.sender}</p>
        <p className="mt-2 text-sm">
          Native group state: {review.status ?? 'Not returned by this source'}.{' '}
          {review.preparationAvailable === false
            ? 'New preparation claims are stopped; retained results can still be recovered.'
            : ''}
        </p>
        <p className="mt-2 break-all font-mono text-xs">
          Exact review fingerprint: {review.reviewHash}
        </p>
        <p className="mt-2 text-sm">
          Reading this list does not approve claims or sending. Held and unfinished records stay in
          this exact group.
        </p>
      </header>
      {review.rows.map((row, index) => (
        <article
          key={row.memberId}
          data-outreach-member={row.memberId}
          className="rounded-lg border bg-white p-5"
        >
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">
                {index + 1}. {row.name}
              </h3>
              <p className="break-all text-sm">
                Recipient: {row.recipient ?? 'Not selected — held'}
              </p>
            </div>
            {row.venueId && (
              <a
                className="text-sm underline"
                href={`/admin/prospects/${encodeURIComponent(row.organizationId)}?venue=${encodeURIComponent(row.venueId)}`}
              >
                Open native venue
              </a>
            )}
          </div>
          <p className="mt-2 text-sm">
            Preparation: {row.state} · Native read: {row.nativeRead} · Outreach: {row.outreachState}
          </p>
          {(row.reasons.length > 0 ||
            row.suppression.blocked ||
            row.stale ||
            row.nativeRead !== 'READ') && (
            <div role="note" className="mt-3 rounded border border-amber-300 bg-amber-50 p-3">
              <strong>Hold or change requires attention.</strong>
              {[
                ...row.reasons,
                ...row.suppression.reasons,
                ...(row.stale ? ['Retained preparation is stale.'] : []),
                ...(row.nativeRead !== 'READ'
                  ? ['Current context is unavailable; that is not evidence of no history.']
                  : []),
              ].map((reason, i) => (
                <p key={i}>{reason}</p>
              ))}
            </div>
          )}
          {row.draft ? (
            <div className="mt-4 space-y-3">
              <p className="text-sm font-medium">
                Revision {row.draft.version} · {row.draft.state} ·{' '}
                {row.exactSelectedDraft
                  ? 'Exact pinned revision'
                  : 'Not the pinned revision — reopen before review'}
              </p>
              <h4 className="font-semibold">{row.draft.subject}</h4>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
                {row.draft.body}
              </pre>
              <p className="break-all font-mono text-xs">
                Draft {row.draft.id} · {row.draft.contentHash}
              </p>
              <p className="text-xs">
                Writer:{' '}
                {row.draft.generatedBy ?? 'No model attribution asserted by this projection'}
              </p>
            </div>
          ) : (
            <p className="mt-4 rounded bg-slate-50 p-3 text-sm">
              No native draft is available. This selected venue has not been silently replaced to
              fill a quota.
            </p>
          )}
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-medium">
              Source, sending and reply evidence
            </summary>
            <p className="mt-2">
              Source: {row.sourceState}. Correspondence: {row.correspondenceState}.
            </p>
            {row.threadCoverage.map((t) => (
              <p key={t.id}>
                Thread {t.id}: {t.count} retained messages;{' '}
                {t.complete ? 'complete retained body coverage' : 'incomplete body coverage'}.{' '}
                {t.issues.join('; ')}
              </p>
            ))}
            <p className="mt-2">
              Provider acceptance, provider Sent, recipient receipt and an imported incoming reply
              are different outcomes.
            </p>
            {row.operational ? (
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(row.operational, null, 2)}
              </pre>
            ) : (
              <p>
                No operational delivery record was returned. Do not infer a send or received reply.
              </p>
            )}
          </details>
        </article>
      ))}
    </section>
  )
}
