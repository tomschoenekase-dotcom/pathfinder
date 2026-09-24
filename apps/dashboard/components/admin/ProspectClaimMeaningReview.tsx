'use client'

import { useId, useState } from 'react'
import {
  claimCategories,
  type ClaimAnnotation,
  type MeaningAssessment,
  type MeaningReviewView,
  type NativeSalesAction,
  type SalesWorkflowView,
} from '@pathfinder/api/prospect-sales-contract'

const field =
  'mt-2 block min-h-11 w-full min-w-0 rounded-md border border-slate-400 bg-white px-3 py-2 text-sm text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:bg-slate-100'
const button =
  'min-h-11 rounded-md border border-slate-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:cursor-not-allowed disabled:opacity-50'
type EditableClaim = {
  annotation: ClaimAnnotation
  verdict: MeaningAssessment['verdict']
  assessmentReason: string
}

/** Segmentation only: no default supported verdict, category inference or model call. */
export function unreviewedClaimSpans(subject: string, body: string): EditableClaim[] {
  const result: EditableClaim[] = []
  for (const [section, text] of [
    ['subject', subject],
    ['body', body],
  ] as const) {
    let position = 0
    for (const quote of text.split('\n\n')) {
      const length = Array.from(quote).length
      if (quote.trim())
        result.push({
          annotation: {
            annotation_id: `${section}-${position}-${position + length}`,
            section,
            start: position,
            end: position + length,
            quote,
            category: 'UNSUPPORTED ADDITION',
            claim_ids: [],
            reason: '',
            answers: [],
          },
          verdict: 'uncertain',
          assessmentReason: '',
        })
      position += length + 2
    }
  }
  return result
}

function originalEditor(
  draft: NonNullable<SalesWorkflowView['draft']>,
  review: MeaningReviewView,
): EditableClaim[] {
  if (review.stale) return unreviewedClaimSpans(draft.subject, draft.body)
  if (!review.current) {
    if (review.candidateAnnotations?.length)
      return review.candidateAnnotations.map((annotation) => ({
        annotation,
        verdict: 'uncertain' as const,
        assessmentReason: '',
      }))
    return unreviewedClaimSpans(draft.subject, draft.body)
  }
  return review.current.annotations.map((annotation) => {
    const assessment = review.current!.assessments.find(
      (value) => value.annotation_id === annotation.annotation_id,
    )
    return {
      annotation,
      verdict: assessment?.verdict ?? 'uncertain',
      assessmentReason: assessment?.reason ?? '',
    }
  })
}

export function ProspectClaimMeaningReview({
  view,
  review,
  enabled,
  local,
  onAction,
}: {
  view: SalesWorkflowView
  review: MeaningReviewView
  enabled: boolean
  local: boolean
  onAction: (action: NativeSalesAction) => Promise<void>
}) {
  const id = useId(),
    draft = view.draft!
  const [claims, setClaims] = useState(() => originalEditor(draft, review))
  const [selected, setSelected] = useState(0)
  const [reviewerKind, setReviewerKind] = useState<'model' | 'human'>('model')
  const [reviewerIdentity, setReviewerIdentity] = useState(review.current?.reviewer.identity ?? '')
  const [extraHolds, setExtraHolds] = useState(
    (review.current?.unsupportedClaims ?? [])
      .filter(
        (hold) =>
          !review.current?.annotations.some((annotation) =>
            hold.startsWith(`${annotation.annotation_id}: `),
          ),
      )
      .join('\n'),
  )
  const [splitAt, setSplitAt] = useState('')
  const active = claims[selected]
  const editable = enabled && !review.stale && Boolean(review.bindingHash)
  const complete =
    claims.length > 0 &&
    claims.length <= 80 &&
    reviewerIdentity.trim() &&
    claims.every(
      (claim) =>
        claim.annotation.reason.trim().length >= 12 && claim.assessmentReason.trim().length >= 12,
    )
  const patch = (change: Partial<EditableClaim>, annotation?: Partial<ClaimAnnotation>) => {
    setClaims((old) =>
      old.map((claim, index) =>
        index === selected
          ? { ...claim, ...change, annotation: { ...claim.annotation, ...annotation } }
          : claim,
      ),
    )
  }
  const split = () => {
    if (!active || !editable || claims.length >= 80) return
    const at = Number(splitAt),
      points = Array.from(active.annotation.quote)
    if (!Number.isInteger(at) || at <= 0 || at >= points.length) return
    const pieces = [points.slice(0, at).join(''), points.slice(at).join('')]
    if (pieces.some((quote) => !quote.trim())) return
    const start = active.annotation.start
    const replacement: EditableClaim[] = pieces.map((quote, index) => {
      const offset = index ? start + at : start
      return {
        annotation: {
          ...active.annotation,
          annotation_id: `${active.annotation.section}-${offset}-${offset + Array.from(quote).length}`,
          start: offset,
          end: offset + Array.from(quote).length,
          quote,
          category: 'UNSUPPORTED ADDITION',
          claim_ids: [],
          reason: '',
          answers: [],
        },
        verdict: 'uncertain',
        assessmentReason: '',
      }
    })
    setClaims((old) => [...old.slice(0, selected), ...replacement, ...old.slice(selected + 1)])
    setSplitAt('')
  }
  const record = () => {
    if (!editable || !complete || !review.bindingHash) return
    const annotations = claims.map((claim) => claim.annotation)
    const assessments = claims.map((claim) => ({
      annotation_id: claim.annotation.annotation_id,
      verdict: claim.verdict,
      reason: claim.assessmentReason,
    }))
    const unsupportedClaims = [
      ...new Set([
        ...claims
          .filter((claim) => ['unsupported', 'uncertain'].includes(claim.verdict))
          .map((claim) =>
            `${claim.annotation.annotation_id}: ${claim.annotation.quote}`.slice(0, 1000),
          ),
        ...extraHolds
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      ]),
    ]
    void onAction({
      action: 'meaning',
      input: {
        venueId: view.venueId,
        draftId: draft.id,
        contentHash: draft.contentHash,
        expectedSnapshotHash: view.snapshotHash,
        expectedBindingHash: review.bindingHash,
        expectedMeaningReviewId: review.current?.id ?? null,
        annotations,
        assessments,
        reviewer: { kind: reviewerKind, identity: reviewerIdentity.trim() },
        languageUses: review.current?.languageUses ?? [],
        unsupportedClaims,
        answers: review.questions.map((question) => {
          const answer = claims.find(
            (claim) =>
              claim.annotation.section === 'body' &&
              claim.annotation.answers.includes(question.question_id),
          )
          return {
            question_id: question.question_id,
            verdict: answer ? ('answers' as const) : ('unresolved' as const),
            quote: answer?.annotation.quote ?? '',
            reason:
              answer?.assessmentReason ??
              'No exact answer span has been identified by the reviewer.',
          }
        }),
      },
    })
  }

  return (
    <section
      aria-label="Claim and meaning review"
      className="mt-6 min-w-0 border-t-2 border-slate-700 pt-5"
    >
      <h3 className="text-lg font-semibold text-slate-950">Claims / evidence / meaning</h3>
      <p className="mt-2 text-sm leading-6 text-slate-700">
        Inspect every subject and body span against this revision’s sources. Facts, task direction
        and proposals are different kinds of evidence. A model assessment is attributed judgment,
        not authenticated human review or proof that a source entails a claim.
      </p>
      <dl className="mt-4 grid gap-4 border-y border-slate-200 py-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-bold uppercase text-slate-600">Read acknowledgment</dt>
          <dd className="mt-1 text-sm font-semibold">
            {review.readReviewRecorded
              ? 'Recorded for this revision — NO SEND'
              : 'Not recorded for this revision'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-bold uppercase text-slate-600">Claim / meaning assessment</dt>
          <dd className="mt-1 text-sm font-semibold" data-testid="meaning-status">
            {review.status.replaceAll('_', ' ')}
          </dd>
        </div>
      </dl>
      {!editable ? (
        <p className="mt-3 border-l-4 border-amber-600 bg-amber-50 p-3 text-sm text-amber-950">
          Review is not applicable to the editor or current source state. Save the current exact
          draft, or prepare again after a source, recipient, thread or component change. Retained
          findings are not rewritten.
        </p>
      ) : null}
      <details className="mt-3 text-sm">
        <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
          Exact source and recipient binding
        </summary>
        <dl className="space-y-2 break-all text-xs leading-5">
          <div>
            <dt className="font-semibold">Draft / preparation</dt>
            <dd>
              {review.boundIdentity.draftId} / {review.boundIdentity.preparationId}
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Bound recipient or form route</dt>
            <dd>
              {review.boundIdentity.recipientKind}: {review.boundIdentity.recipientValue}
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Native source snapshot</dt>
            <dd>{review.boundIdentity.sourceSnapshotHash}</dd>
          </div>
          <div>
            <dt className="font-semibold">Thread / inbound identity</dt>
            <dd>
              {review.boundIdentity.threadId || 'No thread'} /{' '}
              {review.boundIdentity.inboundId || 'No inbound'}
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Review binding SHA-256</dt>
            <dd>{review.bindingHash ?? 'Unavailable — original evidence cannot be bound'}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs leading-5 text-slate-600">
          This hash also covers exact subject/body bytes, source/component files, WLT, preparation
          and approved-language revisions. It is integrity evidence, not semantic proof.
        </p>
      </details>

      <div className="mt-4 grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-slate-950">Text spans ({claims.length})</h4>
          <p className="mt-2 text-xs leading-5 text-slate-600">
            Initial spans are unreviewed paragraphs, not automatic factual labels. Split mixed
            claims before assessing them.
          </p>
          <ol className="mt-3 divide-y divide-slate-200 border-y border-slate-200">
            {claims.map((claim, index) => (
              <li key={claim.annotation.annotation_id}>
                <button
                  type="button"
                  aria-pressed={selected === index}
                  aria-label={`Inspect claim ${index + 1}`}
                  className={`w-full min-w-0 border-l-4 px-3 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700 ${selected === index ? 'border-sky-800 bg-sky-50' : 'border-transparent hover:bg-slate-50'}`}
                  onClick={() => setSelected(index)}
                >
                  <span className="block text-xs font-bold uppercase text-slate-600">
                    {index + 1} · {claim.annotation.section} · {claim.verdict}
                  </span>
                  <span className="mt-1 block whitespace-pre-wrap text-sm leading-5 text-slate-900">
                    {claim.annotation.quote}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
        {active ? (
          <fieldset disabled={!editable} className="min-w-0">
            <legend className="text-sm font-bold text-slate-950">
              Inspect claim {selected + 1}: source and assessment
            </legend>
            <blockquote className="mt-3 whitespace-pre-wrap border-l-2 border-slate-300 pl-3 text-sm leading-6 text-slate-900">
              {active.annotation.quote}
            </blockquote>
            <p className="mt-2 text-xs text-slate-600">
              Exact {active.annotation.section} code points [{active.annotation.start},{' '}
              {active.annotation.end}).
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor={`${id}-category`} className="block text-sm font-semibold">
                  Claim category
                </label>
                <select
                  id={`${id}-category`}
                  className={field}
                  value={active.annotation.category}
                  onChange={(event) =>
                    patch({}, { category: event.target.value as ClaimAnnotation['category'] })
                  }
                >
                  {claimCategories.map((category) => (
                    <option
                      key={category}
                      value={category}
                      disabled={
                        category === 'APPROVED REUSABLE LANGUAGE' &&
                        view.preparation?.selectedCount === 0
                      }
                    >
                      {category}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${id}-verdict`} className="block text-sm font-semibold">
                  Attributed verdict
                </label>
                <select
                  id={`${id}-verdict`}
                  className={field}
                  value={active.verdict}
                  onChange={(event) =>
                    patch({ verdict: event.target.value as MeaningAssessment['verdict'] })
                  }
                >
                  {['uncertain', 'unsupported', 'supported', 'hypothetical', 'nonfactual'].map(
                    (verdict) => (
                      <option key={verdict} value={verdict}>
                        {verdict}
                      </option>
                    ),
                  )}
                </select>
              </div>
            </div>
            <fieldset className="mt-4 min-w-0">
              <legend className="text-sm font-semibold">Evidence references for this claim</legend>
              <p className="mt-2 text-xs leading-5 text-slate-600">
                Selecting a source only records your mapping. Composer checks the annotation
                contract; it cannot certify natural-language entailment.
              </p>
              {review.sources.map((source) => (
                <div key={source.claim_id} className="mt-3 min-w-0 border-t border-slate-200 pt-2">
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 h-5 w-5 shrink-0 accent-sky-800"
                      checked={active.annotation.claim_ids.includes(source.claim_id)}
                      aria-label={`Evidence ${source.claim_id}`}
                      onChange={(event) =>
                        patch(
                          {},
                          {
                            claim_ids: event.target.checked
                              ? [...active.annotation.claim_ids, source.claim_id]
                              : active.annotation.claim_ids.filter(
                                  (claimId) => claimId !== source.claim_id,
                                ),
                          },
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="block font-semibold">
                        {source.claim_id} · {source.category}
                      </span>
                      <span className="mt-1 block leading-6">{source.text}</span>
                    </span>
                  </label>
                  <details className="ml-8 text-xs leading-5 text-slate-600">
                    <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
                      Source details: {source.claim_id}
                    </summary>
                    <p className="break-all">
                      {source.source_id}#{source.source_pointer}
                    </p>
                    <p className="mt-1 break-all">
                      {source.url ??
                        'Task/thread-local source; not independent website verification'}
                    </p>
                    <p className="mt-1 break-all">Evidence SHA-256: {source.evidence_sha256}</p>
                    {source.capture_sha256 ? (
                      <div className="mt-2">
                        <p className="break-all">
                          Captured page bytes SHA-256: {source.capture_sha256}
                        </p>
                        <p>Observed: {source.observed_at}</p>
                        <p>Retrieved: {source.retrieved_at}</p>
                        <blockquote className="mt-2 border-l-2 border-slate-300 pl-3">
                          {source.quote}
                        </blockquote>
                      </div>
                    ) : null}
                    <p className="mt-2">{source.limitation}</p>
                  </details>
                </div>
              ))}
              {active.annotation.claim_ids.length === 0 ? (
                <p className="mt-3 text-sm font-semibold text-amber-950">
                  No source reference selected. This is not a supported factual claim.
                </p>
              ) : null}
            </fieldset>
            {review.questions.length ? (
              <fieldset className="mt-4">
                <legend className="text-sm font-semibold">
                  Which current inbound points does this exact span answer?
                </legend>
                {review.questions.map((question) => (
                  <label
                    key={question.question_id}
                    className="mt-2 flex min-h-11 items-start gap-3 text-sm leading-6"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-5 w-5 shrink-0"
                      checked={active.annotation.answers.includes(question.question_id)}
                      aria-label={`Answers ${question.question_id}`}
                      disabled={active.annotation.section !== 'body'}
                      onChange={(event) =>
                        patch(
                          {},
                          {
                            answers: event.target.checked
                              ? [...active.annotation.answers, question.question_id]
                              : active.annotation.answers.filter(
                                  (qid) => qid !== question.question_id,
                                ),
                          },
                        )
                      }
                    />
                    <span>
                      {question.quote}
                      <span className="block text-xs text-slate-600">
                        Answer direction: {question.answer_claim_ids.join(', ')}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <div className="mt-4">
              <label htmlFor={`${id}-reason`} className="block text-sm font-semibold">
                Reason for this mapping and assessment
              </label>
              <textarea
                id={`${id}-reason`}
                className={field}
                rows={3}
                maxLength={2000}
                value={active.assessmentReason}
                onChange={(event) =>
                  patch({ assessmentReason: event.target.value }, { reason: event.target.value })
                }
              />
            </div>
            <details className="mt-3 text-sm">
              <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
                Split a span with more than one claim
              </summary>
              <div>
                <label htmlFor={`${id}-split`} className="block text-sm">
                  Split after this many code points within the selected span
                </label>
                <input
                  id={`${id}-split`}
                  type="number"
                  min={1}
                  max={Array.from(active.annotation.quote).length - 1}
                  className={field}
                  value={splitAt}
                  onChange={(event) => setSplitAt(event.target.value)}
                />
              </div>
              <button
                type="button"
                className={`${button} mt-3`}
                disabled={!splitAt || claims.length >= 80}
                onClick={split}
              >
                Split selected span
              </button>
              <p className="mt-2 text-xs text-slate-600">
                Both new spans return to unreviewed. This changes only the unrecorded annotation
                form, never saved history.
              </p>
            </details>
          </fieldset>
        ) : null}
      </div>

      <fieldset disabled={!editable} className="mt-6 border-t border-slate-200 pt-5">
        <legend className="px-1 text-sm font-bold">Record an attributed assessment</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-reviewer-kind`} className="block text-sm font-semibold">
              Reviewer type
            </label>
            <select
              id={`${id}-reviewer-kind`}
              className={field}
              value={reviewerKind}
              onChange={(event) => setReviewerKind(event.target.value as 'model' | 'human')}
            >
              <option value="model">Model / attributed assessment</option>
              {!local ? <option value="human">Authenticated operator’s assessment</option> : null}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-reviewer-identity`} className="block text-sm font-semibold">
              Reviewer identity / attribution
            </label>
            <input
              id={`${id}-reviewer-identity`}
              className={field}
              maxLength={200}
              value={reviewerIdentity}
              onChange={(event) => setReviewerIdentity(event.target.value)}
              placeholder="Identify the model or reviewer; do not impersonate Tom"
            />
          </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-600">
          No model is invoked by this form. It records submitted judgments with their attribution.{' '}
          {local
            ? 'The recorder is explicitly synthetic SYSTEM, not an authenticated human.'
            : 'Human identity is bound server-side to the signed-in operator.'}
        </p>
        <label htmlFor={`${id}-holds`} className="mt-4 block text-sm font-semibold">
          Additional unresolved findings (one per line)
        </label>
        <textarea
          id={`${id}-holds`}
          className={field}
          rows={2}
          maxLength={4000}
          value={extraHolds}
          onChange={(event) => setExtraHolds(event.target.value)}
        />
        <p className="mt-3 text-xs leading-5 text-slate-600">
          Uncertain and unsupported verdicts remain holds. Approved Language is a separate source:{' '}
          {view.preparation?.approvedCount ?? 0} active entries,{' '}
          {view.preparation?.selectedCount ?? 0} selected. This form never approves wording or
          sending.
        </p>
        <button
          type="button"
          className={`${button} mt-4`}
          disabled={!editable || !complete}
          onClick={record}
        >
          Record claim / meaning findings
        </button>
        {!complete ? (
          <p className="mt-2 text-xs text-slate-600">
            Enter an attributed reviewer and a substantive reason for every span before recording.
          </p>
        ) : null}
      </fieldset>

      {review.current ? (
        <section
          aria-label="Recorded meaning findings"
          className="mt-5 border-l-4 border-slate-700 bg-slate-50 p-4 text-sm"
        >
          <h4 className="font-bold">
            Recorded findings · {review.current.status.replaceAll('_', ' ')}
          </h4>
          <p className="mt-2">
            {review.current.reviewer.kind}: {review.current.reviewer.identity}
          </p>
          <p className="mt-1 break-all text-xs text-slate-600">
            Recorded by {review.current.recordedBy.type} · {review.current.recordedBy.id}.{' '}
            {review.current.recordedBy.synthetic
              ? 'SYNTHETIC ACCEPTANCE — not a human action.'
              : 'No human or send approval was recorded.'}
          </p>
          {review.current.findings.length ? (
            <ul className="mt-3 space-y-2">
              {review.current.findings.map((finding, index) => (
                <li key={index} className="break-words text-amber-950">
                  <strong>{finding.code}</strong>: {finding.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3">
              No unresolved claim-contract findings in this submitted assessment. Semantic
              entailment remains reviewer judgment, not deterministic proof.
            </p>
          )}
          <details className="mt-3">
            <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
              Recorded claim-to-source evidence
            </summary>
            <ol className="divide-y divide-slate-200">
              {review.current.claimEvidence.map((item) => (
                <li key={item.annotation.annotation_id} className="py-3">
                  <p className="whitespace-pre-wrap font-semibold">{item.annotation.quote}</p>
                  <p className="mt-1 text-xs">
                    {item.annotation.category} ·{' '}
                    {item.sources.length
                      ? item.sources.map((source) => source.claim_id).join(', ')
                      : 'NO FACTUAL SOURCE'}
                  </p>
                  {item.sources.map((source) => (
                    <p key={source.claim_id} className="mt-2 text-xs leading-5">
                      {source.text}
                      <span className="mt-1 block break-all text-slate-600">
                        {source.source_id}#{source.source_pointer} · {source.evidence_sha256}
                      </span>
                    </p>
                  ))}
                </li>
              ))}
            </ol>
          </details>
          <p className="mt-3 font-semibold">
            Read-review, reusable-language approval and sending remain separate. SEND AUTHORIZED:
            NO.
          </p>
        </section>
      ) : null}
      {review.history.length ? (
        <details className="mt-4 text-sm">
          <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
            Immutable meaning-review history ({review.history.length} retained in this bounded view)
          </summary>
          <ol className="space-y-3">
            {review.history.map((entry) => (
              <li key={entry.id} className="border-l-2 border-slate-300 pl-3 text-xs leading-5">
                <p className="font-semibold">
                  {entry.applicable
                    ? 'Applicable to this exact revision'
                    : 'Historical / not applicable to this current revision'}{' '}
                  · {entry.status.replaceAll('_', ' ')}
                </p>
                <p className="break-all">{entry.id}</p>
                <p className="break-all">
                  Draft {entry.draftId} · {entry.contentHash}
                </p>
                <p className="break-all">Binding {entry.bindingHash}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  )
}
