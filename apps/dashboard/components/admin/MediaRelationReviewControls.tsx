'use client'

import React, { useMemo, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'
import type {
  MediaRelationProposalDecisionInput,
  MediaRelationReviewDecisionInput,
  MediaRelationRevertDecisionInput,
} from '@pathfinder/contracts/media-resolution-state'

type Review = NonNullable<inferRouterOutputs<AppRouter>['mediaIngestion']['getIdentityReview']>
export type MediaRelationReview = Review
export type MediaRelationDecision =
  | MediaRelationProposalDecisionInput
  | MediaRelationReviewDecisionInput
  | MediaRelationRevertDecisionInput

const PAGE_SIZE = 20
const relationKinds = ['CONTAINS', 'ADJACENT', 'COVISIBLE', 'TRAVERSABLE'] as const
const bases = [
  ['visual_overlap', 'Visual overlap'],
  ['explicit_containment', 'Explicit containment'],
  ['explicit_path', 'Explicit path'],
  ['doorway', 'Doorway'],
  ['map_route', 'Map route'],
] as const

function label(value: string) {
  return value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./u, (character) => character.toUpperCase())
}

export function MediaRelationReviewControls({
  review,
  disabled,
  onDecision,
}: {
  review: Review
  disabled: boolean
  onDecision: (decision: MediaRelationDecision) => void
}) {
  const [page, setPage] = useState(0)
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [kind, setKind] = useState<(typeof relationKinds)[number] | ''>('')
  const [basis, setBasis] = useState<(typeof bases)[number][0] | ''>('')
  const [confidence, setConfidence] = useState<'confirmed' | 'probable' | 'unverified' | ''>('')
  const [observationKind, setObservationKind] = useState<'UNKNOWN' | 'OBSERVED_AT'>('UNKNOWN')
  const [observedAt, setObservedAt] = useState('')
  const [evidenceIds, setEvidenceIds] = useState<string[]>([])
  const [uncertainties, setUncertainties] = useState('')
  const [rationale, setRationale] = useState('')
  const [connectionKind, setConnectionKind] = useState('')
  const [bidirectional, setBidirectional] = useState<'' | 'yes' | 'no'>('')
  const [accessibility, setAccessibility] = useState('')
  const [directions, setDirections] = useState('')
  const [reviewTarget, setReviewTarget] = useState<{
    proposalRequestId: string
    verdict: 'ACCEPTED' | 'REJECTED'
  } | null>(null)
  const [reviewRationale, setReviewRationale] = useState('')
  const [revertTarget, setRevertTarget] = useState<string | null>(null)
  const [revertRationale, setRevertRationale] = useState('')

  const candidateById = useMemo(
    () => new Map(review.candidates.map((candidate) => [candidate.candidateId, candidate])),
    [review.candidates],
  )
  const proposalByRequest = useMemo(
    () =>
      new Map(
        review.decisions.flatMap((decision) =>
          decision.kind === 'PROPOSE_RELATION' ? [[decision.requestId, decision] as const] : [],
        ),
      ),
    [review.decisions],
  )
  const reviewDecisionByRequest = useMemo(
    () =>
      new Map(
        review.decisions.flatMap((decision) =>
          decision.kind === 'REVIEW_RELATION' ? [[decision.requestId, decision] as const] : [],
        ),
      ),
    [review.decisions],
  )
  const fromEvidence = candidateById.get(fromId)?.evidenceLocatorIds ?? []
  const toEvidence = candidateById.get(toId)?.evidenceLocatorIds ?? []
  const endpointEvidence = [...new Set([...fromEvidence, ...toEvidence])]
  const hasEvidenceForBoth =
    evidenceIds.some((id) => fromEvidence.includes(id)) &&
    evidenceIds.some((id) => toEvidence.includes(id)) &&
    evidenceIds.length <= 100
  const observationValid = observationKind === 'UNKNOWN' || Boolean(observedAt)
  const traversalValid =
    kind !== 'TRAVERSABLE' ||
    Boolean(connectionKind && bidirectional && accessibility && directions.trim())
  const relationValid =
    fromId &&
    toId &&
    fromId !== toId &&
    kind &&
    basis &&
    confidence &&
    rationale.trim() &&
    hasEvidenceForBoth &&
    observationValid &&
    traversalValid &&
    (kind !== 'CONTAINS' || basis === 'explicit_containment') &&
    (kind !== 'TRAVERSABLE' || ['explicit_path', 'doorway', 'map_route'].includes(basis))
  const relations = review.projection.relations
  const visibleRelations = relations.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  function resetEvidence() {
    setEvidenceIds([])
  }

  function propose() {
    if (!relationValid || !kind || !basis || !confidence) return
    const decision: MediaRelationProposalDecisionInput = {
      kind: 'PROPOSE_RELATION',
      relationId: crypto.randomUUID(),
      fromCandidateId: fromId,
      toCandidateId: toId,
      relationKind: kind,
      evidenceLocatorIds: evidenceIds,
      basis,
      confidence,
      observationTime:
        observationKind === 'UNKNOWN'
          ? { kind: 'UNKNOWN' }
          : { kind: 'OBSERVED_AT', observedAt: new Date(observedAt).toISOString() },
      uncertainties: uncertainties
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
      rationale: rationale.trim(),
      ...(kind === 'TRAVERSABLE'
        ? {
            traversal: {
              connectionKind: connectionKind as
                | 'WALKWAY'
                | 'DOOR'
                | 'STAIRS'
                | 'ELEVATOR'
                | 'ESCALATOR'
                | 'OUTDOOR_PATH'
                | 'SHUTTLE',
              bidirectional: bidirectional === 'yes',
              accessibility: accessibility as 'ACCESSIBLE' | 'NOT_ACCESSIBLE' | 'UNKNOWN',
              directions: directions.trim(),
            },
          }
        : {}),
    }
    onDecision(decision)
  }

  return (
    <section aria-labelledby="media-relations-heading" className="border-t border-pf-light pt-7">
      <div>
        <h3 id="media-relations-heading" className="text-lg font-semibold text-pf-deep">
          Relation evidence review
        </h3>
        <p className="mt-1 text-xs leading-5 text-pf-deep/75">
          Relations stay inside evidence review. Recording or accepting one does not activate or
          publish a canonical venue connection.
        </p>
      </div>

      <details className="mt-4 rounded-xl border border-pf-light bg-pf-surface p-4">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-pf-primary">
          Propose a relation from retained evidence
        </summary>
        <fieldset disabled={disabled} className="mt-4 grid gap-4 sm:grid-cols-2">
          <legend className="sr-only">Relation proposal</legend>
          <label className="text-sm font-medium text-pf-deep">
            From identity
            <select
              value={fromId}
              onChange={(event) => {
                setFromId(event.target.value)
                resetEvidence()
              }}
              className="mt-2 min-h-11 w-full rounded-lg border border-pf-light bg-white px-3"
            >
              <option value="">Choose the starting identity</option>
              {review.candidates.map((candidate) => (
                <option key={candidate.candidateId} value={candidate.candidateId}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-pf-deep">
            To identity
            <select
              value={toId}
              onChange={(event) => {
                setToId(event.target.value)
                resetEvidence()
              }}
              className="mt-2 min-h-11 w-full rounded-lg border border-pf-light bg-white px-3"
            >
              <option value="">Choose the ending identity</option>
              {review.candidates.map((candidate) => (
                <option key={candidate.candidateId} value={candidate.candidateId}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
          {kind === 'CONTAINS' ? (
            <p className="text-xs leading-5 text-pf-deep/75 sm:col-span-2">
              Direction matters: “from” is the container and “to” is the contained place.
            </p>
          ) : null}
          <label className="text-sm font-medium text-pf-deep">
            Relation kind
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as typeof kind)
                setBasis('')
              }}
              className="mt-2 min-h-11 w-full rounded-lg border border-pf-light bg-white px-3"
            >
              <option value="">Choose a relation</option>
              {relationKinds.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-pf-deep">
            Evidence basis
            <select
              value={basis}
              onChange={(event) => setBasis(event.target.value as typeof basis)}
              className="mt-2 min-h-11 w-full rounded-lg border border-pf-light bg-white px-3"
            >
              <option value="">Choose the explicit basis</option>
              {bases
                .filter(([value]) =>
                  kind === 'CONTAINS'
                    ? value === 'explicit_containment'
                    : kind === 'TRAVERSABLE'
                      ? ['explicit_path', 'doorway', 'map_route'].includes(value)
                      : true,
                )
                .map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-sm font-medium text-pf-deep">
            Confidence
            <select
              value={confidence}
              onChange={(event) => setConfidence(event.target.value as typeof confidence)}
              className="mt-2 min-h-11 w-full rounded-lg border border-pf-light bg-white px-3"
            >
              <option value="">Choose confidence</option>
              <option value="confirmed">Confirmed</option>
              <option value="probable">Probable</option>
              <option value="unverified">Unverified</option>
            </select>
          </label>
          <label className="text-sm font-medium text-pf-deep">
            Observation time
            <select
              value={observationKind}
              onChange={(event) => setObservationKind(event.target.value as typeof observationKind)}
              className="mt-2 min-h-11 w-full rounded-lg border border-pf-light bg-white px-3"
            >
              <option value="UNKNOWN">Unknown</option>
              <option value="OBSERVED_AT">Observed at a known time</option>
            </select>
          </label>
          {observationKind === 'OBSERVED_AT' ? (
            <label className="text-sm font-medium text-pf-deep sm:col-span-2">
              Observed at
              <input
                type="datetime-local"
                value={observedAt}
                onChange={(event) => setObservedAt(event.target.value)}
                className="mt-2 min-h-11 w-full rounded-lg border border-pf-light bg-white px-3"
              />
            </label>
          ) : null}

          <fieldset className="rounded-lg border border-pf-light bg-white p-3 sm:col-span-2">
            <legend className="px-1 text-sm font-medium text-pf-deep">Retained evidence</legend>
            {!fromId || !toId ? (
              <p className="text-xs text-pf-deep/65">Choose both endpoints to inspect evidence.</p>
            ) : endpointEvidence.length === 0 ? (
              <p className="text-xs text-rose-800">No retained endpoint evidence is available.</p>
            ) : (
              <div className="space-y-2">
                {endpointEvidence.map((id) => (
                  <label
                    key={id}
                    className="flex min-h-11 items-start gap-2 break-all text-xs text-pf-deep/75"
                  >
                    <input
                      type="checkbox"
                      checked={evidenceIds.includes(id)}
                      onChange={(event) =>
                        setEvidenceIds((current) =>
                          event.target.checked
                            ? [...current, id]
                            : current.filter((value) => value !== id),
                        )
                      }
                      className="mt-1 h-5 w-5 shrink-0"
                    />
                    <span>
                      {id}
                      <span className="mt-1 block text-pf-deep/55">
                        {fromEvidence.includes(id) ? 'From evidence' : ''}
                        {fromEvidence.includes(id) && toEvidence.includes(id) ? ' · ' : ''}
                        {toEvidence.includes(id) ? 'To evidence' : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {evidenceIds.length > 0 && !hasEvidenceForBoth ? (
              <p className="mt-2 text-xs text-amber-900">
                Select evidence retained for both endpoints.
              </p>
            ) : null}
          </fieldset>

          {kind === 'TRAVERSABLE' ? (
            <div className="grid gap-4 rounded-lg border border-amber-200 bg-amber-50 p-4 sm:col-span-2 sm:grid-cols-2">
              <p className="text-xs leading-5 text-amber-950 sm:col-span-2">
                Traversability needs explicit reviewed connection details. Accessibility remains
                unknown unless retained evidence confirms it.
              </p>
              <label className="text-sm font-medium text-amber-950">
                Connection kind
                <select
                  value={connectionKind}
                  onChange={(event) => setConnectionKind(event.target.value)}
                  className="mt-2 min-h-11 w-full rounded-lg border border-amber-300 bg-white px-3"
                >
                  <option value="">Choose connection</option>
                  {[
                    'WALKWAY',
                    'DOOR',
                    'STAIRS',
                    'ELEVATOR',
                    'ESCALATOR',
                    'OUTDOOR_PATH',
                    'SHUTTLE',
                  ].map((value) => (
                    <option key={value} value={value}>
                      {label(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium text-amber-950">
                Direction
                <select
                  value={bidirectional}
                  onChange={(event) => setBidirectional(event.target.value as typeof bidirectional)}
                  className="mt-2 min-h-11 w-full rounded-lg border border-amber-300 bg-white px-3"
                >
                  <option value="">Choose direction</option>
                  <option value="yes">Bidirectional</option>
                  <option value="no">One way</option>
                </select>
              </label>
              <label className="text-sm font-medium text-amber-950">
                Accessibility
                <select
                  value={accessibility}
                  onChange={(event) => setAccessibility(event.target.value)}
                  className="mt-2 min-h-11 w-full rounded-lg border border-amber-300 bg-white px-3"
                >
                  <option value="">Choose accessibility</option>
                  <option value="ACCESSIBLE">Accessible</option>
                  <option value="NOT_ACCESSIBLE">Not accessible</option>
                  <option value="UNKNOWN">Unknown</option>
                </select>
              </label>
              <label className="text-sm font-medium text-amber-950">
                Reviewed directions
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={directions}
                  onChange={(event) => setDirections(event.target.value)}
                  className="mt-2 w-full rounded-lg border border-amber-300 bg-white px-3 py-2"
                />
              </label>
            </div>
          ) : null}

          <label className="text-sm font-medium text-pf-deep sm:col-span-2">
            Uncertainties <span className="font-normal text-pf-deep/55">(one per line)</span>
            <textarea
              rows={2}
              maxLength={4000}
              value={uncertainties}
              onChange={(event) => setUncertainties(event.target.value)}
              className="mt-2 w-full rounded-lg border border-pf-light bg-white px-3 py-2"
            />
          </label>
          <label className="text-sm font-medium text-pf-deep sm:col-span-2">
            Proposal rationale
            <textarea
              rows={3}
              maxLength={2000}
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              className="mt-2 w-full rounded-lg border border-pf-light bg-white px-3 py-2"
            />
          </label>
          <button
            type="button"
            disabled={disabled || !relationValid}
            onClick={propose}
            className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50 sm:col-span-2 sm:justify-self-start"
          >
            Record evidence proposal
          </button>
        </fieldset>
      </details>

      <div className="mt-6">
        <h4 className="font-semibold text-pf-deep">Relation history</h4>
        {relations.length === 0 ? (
          <p className="mt-2 rounded-xl bg-pf-surface p-4 text-sm text-pf-deep/65">
            No relation evidence has been proposed.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {visibleRelations.map((relation) => (
              <article
                key={relation.proposalRequestId}
                className="rounded-xl border border-pf-light p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium text-pf-deep">
                    {candidateById.get(relation.originalFromCandidateId)?.label ??
                      relation.originalFromCandidateId}
                    {' → '}
                    {candidateById.get(relation.originalToCandidateId)?.label ??
                      relation.originalToCandidateId}
                  </p>
                  <span className="rounded-full bg-pf-surface px-2.5 py-1 text-xs font-semibold text-pf-deep">
                    {relation.reviewStatus}
                  </span>
                </div>
                <p className="mt-2 text-sm text-pf-deep/75">
                  {label(relation.relationKind)} · {label(relation.basis)} ·{' '}
                  {label(relation.confidence)}
                </p>
                <p className="mt-1 text-xs text-pf-deep/65">
                  Resolved endpoints: {relation.fromCandidateId} → {relation.toCandidateId} ·{' '}
                  {relation.endpointState} · {relation.ambiguity}
                </p>
                <details className="mt-3 rounded-lg border border-pf-light bg-white p-3">
                  <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-pf-primary">
                    Review retained relation details
                  </summary>
                  <div className="space-y-3 pb-1 text-xs leading-5 text-pf-deep/75">
                    <p>
                      <span className="font-semibold text-pf-deep">Proposal rationale:</span>{' '}
                      {proposalByRequest.get(relation.proposalRequestId)?.rationale ??
                        'Rationale unavailable in this retained revision.'}
                    </p>
                    <div>
                      <p className="font-semibold text-pf-deep">Evidence locators</p>
                      <ul className="mt-1 space-y-1 break-all">
                        {relation.evidenceLocatorIds.map((id) => (
                          <li key={id}>{id}</li>
                        ))}
                      </ul>
                    </div>
                    <p>
                      <span className="font-semibold text-pf-deep">Observation:</span>{' '}
                      {relation.observationTime.kind === 'UNKNOWN'
                        ? 'Unknown time'
                        : relation.observationTime.observedAt}
                    </p>
                    <p>
                      <span className="font-semibold text-pf-deep">Uncertainties:</span>{' '}
                      {relation.uncertainties.length > 0
                        ? relation.uncertainties.join(' · ')
                        : 'None recorded'}
                    </p>
                    {relation.traversal ? (
                      <p>
                        <span className="font-semibold text-pf-deep">Traversal:</span>{' '}
                        {label(relation.traversal.connectionKind)} ·{' '}
                        {relation.traversal.bidirectional ? 'Bidirectional' : 'One way'} ·{' '}
                        {label(relation.traversal.accessibility)} · {relation.traversal.directions}
                      </p>
                    ) : null}
                    {relation.reviewRequestId ? (
                      <p>
                        <span className="font-semibold text-pf-deep">
                          Current review rationale:
                        </span>{' '}
                        {reviewDecisionByRequest.get(relation.reviewRequestId)?.rationale ??
                          'Unavailable in this retained revision.'}
                      </p>
                    ) : null}
                  </div>
                </details>
                {relation.reviewStatus === 'PENDING' ? (
                  <div className="mt-3 rounded-lg bg-pf-surface p-3">
                    <div className="flex flex-wrap gap-2">
                      {(['ACCEPTED', 'REJECTED'] as const).map((verdict) => (
                        <button
                          key={verdict}
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            setReviewTarget({
                              proposalRequestId: relation.proposalRequestId,
                              verdict,
                            })
                            setReviewRationale('')
                          }}
                          className="min-h-11 rounded-lg border border-pf-light bg-white px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
                        >
                          {verdict === 'ACCEPTED' ? 'Review as accepted' : 'Review as rejected'}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : relation.reviewRequestId ? (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setRevertTarget(relation.reviewRequestId)
                      setRevertRationale('')
                    }}
                    className="mt-3 min-h-11 rounded-lg border border-pf-light px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
                  >
                    Revert this relation review
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        )}
        {relations.length > PAGE_SIZE ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={disabled || page === 0}
              onClick={() => setPage((value) => value - 1)}
              className="min-h-11 rounded-lg border border-pf-light px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
            >
              Previous relations
            </button>
            <span className="text-sm text-pf-deep/75">
              Page {page + 1} of {Math.ceil(relations.length / PAGE_SIZE)}
            </span>
            <button
              type="button"
              disabled={disabled || (page + 1) * PAGE_SIZE >= relations.length}
              onClick={() => setPage((value) => value + 1)}
              className="min-h-11 rounded-lg border border-pf-light px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
            >
              Next relations
            </button>
          </div>
        ) : null}
      </div>

      {reviewTarget ? (
        <div className="mt-4 rounded-xl border border-pf-light bg-pf-surface p-4">
          <label className="text-sm font-medium text-pf-deep">
            Why this proposal is {reviewTarget.verdict === 'ACCEPTED' ? 'accepted' : 'rejected'}
            <textarea
              rows={3}
              maxLength={2000}
              value={reviewRationale}
              disabled={disabled}
              onChange={(event) => setReviewRationale(event.target.value)}
              className="mt-2 w-full rounded-lg border border-pf-light bg-white px-3 py-2"
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled || !reviewRationale.trim()}
              onClick={() =>
                onDecision({
                  kind: 'REVIEW_RELATION',
                  proposalRequestId: reviewTarget.proposalRequestId,
                  verdict: reviewTarget.verdict,
                  rationale: reviewRationale.trim(),
                })
              }
              className="min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              Confirm relation review
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setReviewTarget(null)}
              className="min-h-11 rounded-xl border border-pf-light bg-white px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {revertTarget ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <label className="text-sm font-medium text-amber-950">
            Why this relation review should be reverted
            <textarea
              rows={3}
              maxLength={2000}
              value={revertRationale}
              disabled={disabled}
              onChange={(event) => setRevertRationale(event.target.value)}
              className="mt-2 w-full rounded-lg border border-amber-300 bg-white px-3 py-2"
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled || !revertRationale.trim()}
              onClick={() =>
                onDecision({
                  kind: 'REVERT_RELATION',
                  reviewRequestId: revertTarget,
                  rationale: revertRationale.trim(),
                })
              }
              className="min-h-11 rounded-xl bg-amber-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              Confirm review reversion
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setRevertTarget(null)}
              className="min-h-11 rounded-xl border border-amber-300 bg-white px-4 text-sm font-semibold text-amber-950 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
