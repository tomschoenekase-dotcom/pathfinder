'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'
import { MediaIntakeEvidenceReader } from './MediaIntakeEvidenceReader'
import {
  MediaRelationReviewControls,
  type MediaRelationDecision,
} from './MediaRelationReviewControls'

type Inputs = inferRouterInputs<AppRouter>['mediaIngestion']
type Outputs = inferRouterOutputs<AppRouter>['mediaIngestion']
type Preview = Outputs['previewIdentityCandidates']
type Review = NonNullable<Outputs['getIdentityReview']>
type SaveInput = Inputs['saveIdentityReview']

export type MediaIdentityReviewDataSource = {
  preview: (input: Inputs['previewIdentityCandidates'], signal: AbortSignal) => Promise<Preview>
  get: (input: Inputs['getIdentityReview'], signal: AbortSignal) => Promise<Review | null>
  save: (input: SaveInput, signal: AbortSignal) => Promise<Outputs['saveIdentityReview']>
}

const REQUEST_TIMEOUT_MS = 15_000

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
    ? data.code
    : null
}

export function MediaIdentityReviewPanel({
  scope,
  expectedUpdatedAt,
  blocked,
  dataSource,
}: {
  scope: { tenantId: string; venueId: string; projectId: string; sourceGeneration: string }
  expectedUpdatedAt: string
  blocked: boolean
  dataSource?: MediaIdentityReviewDataSource
}) {
  const client = useTRPCClient()
  const source = useMemo<MediaIdentityReviewDataSource>(
    () =>
      dataSource ?? {
        preview: (input, signal) =>
          client.mediaIngestion.previewIdentityCandidates.query(input, { signal }),
        get: (input, signal) => client.mediaIngestion.getIdentityReview.query(input, { signal }),
        save: (input, signal) => client.mediaIngestion.saveIdentityReview.mutate(input, { signal }),
      },
    [client, dataSource],
  )
  const scopeKey = JSON.stringify([
    scope.tenantId,
    scope.venueId,
    scope.projectId,
    scope.sourceGeneration,
    expectedUpdatedAt,
  ])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selectedGroups, setSelectedGroups] = useState<string[]>([])
  const [groupPage, setGroupPage] = useState(0)
  const [representativeId, setRepresentativeId] = useState('')
  const [mergeRationale, setMergeRationale] = useState('')
  const [revertTarget, setRevertTarget] = useState<string | null>(null)
  const [revertRationale, setRevertRationale] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uncertainInput, setUncertainInput] = useState<SaveInput | null>(null)
  const [dataScopeKey, setDataScopeKey] = useState(scopeKey)
  const requestRef = useRef<AbortController | null>(null)
  const inFlightRef = useRef(false)
  const renderedScope = useRef(scopeKey)
  const scopeGeneration = useRef(0)

  if (renderedScope.current !== scopeKey) {
    renderedScope.current = scopeKey
    scopeGeneration.current += 1
  }

  useEffect(() => {
    requestRef.current?.abort()
    setPreview(null)
    setReview(null)
    setLoaded(false)
    setSelectedGroups([])
    setGroupPage(0)
    setRepresentativeId('')
    setMergeRationale('')
    setRevertTarget(null)
    setRevertRationale('')
    setNotice(null)
    setError(null)
    setUncertainInput(null)
    setDataScopeKey(scopeKey)
    inFlightRef.current = false
    setBusy(false)
  }, [scopeKey])

  useEffect(
    () => () => {
      scopeGeneration.current += 1
      requestRef.current?.abort()
    },
    [],
  )

  const candidateIndex = useMemo(
    () => new Map(review?.candidates.map((candidate) => [candidate.candidateId, candidate]) ?? []),
    [review],
  )
  const selectedCandidateIds = useMemo(
    () =>
      review?.projection.groups
        .filter((group) => selectedGroups.includes(group.representativeId))
        .flatMap((group) => group.candidateIds) ?? [],
    [review, selectedGroups],
  )
  const groups = review?.projection.groups ?? []
  const visibleGroups = groups.slice(groupPage * 20, (groupPage + 1) * 20)
  const activeMergeIds = new Set(review?.projection.activeMergeIds ?? [])
  const activeMerges =
    review?.decisions.flatMap((decision) =>
      decision.kind === 'MERGE' && activeMergeIds.has(decision.requestId) ? [decision] : [],
    ) ?? []
  const scopeReady = dataScopeKey === scopeKey
  const controlsLocked = !scopeReady || blocked || busy || uncertainInput !== null

  async function bounded<T>(request: (signal: AbortSignal) => Promise<T>) {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    try {
      return await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        request,
      })
    } finally {
      if (requestRef.current === controller) requestRef.current = null
    }
  }

  async function load() {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    const generation = scopeGeneration.current
    try {
      const [nextPreview, nextReview] = await bounded((signal) =>
        Promise.all([source.preview(scope, signal), source.get(scope, signal)]),
      )
      if (scopeGeneration.current !== generation) return
      setPreview(nextPreview)
      setReview(nextReview)
      setLoaded(true)
    } catch {
      if (scopeGeneration.current === generation) {
        setError('Identity candidates could not be loaded within the bounded review window. Retry.')
      }
    } finally {
      if (scopeGeneration.current === generation) {
        inFlightRef.current = false
        setBusy(false)
      }
    }
  }

  async function refresh(generation: number): Promise<boolean> {
    const [nextPreview, nextReview] = await bounded((signal) =>
      Promise.all([source.preview(scope, signal), source.get(scope, signal)]),
    )
    if (scopeGeneration.current !== generation) return false
    setPreview(nextPreview)
    setReview(nextReview)
    setLoaded(true)
    setSelectedGroups([])
    setGroupPage(0)
    setRepresentativeId('')
    setMergeRationale('')
    setRevertTarget(null)
    setRevertRationale('')
    return true
  }

  async function submit(input: SaveInput, successMessage: string) {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    const generation = scopeGeneration.current
    try {
      await bounded((signal) => source.save(input, signal))
      if (scopeGeneration.current !== generation) return
      if (!(await refresh(generation))) return
      setUncertainInput(null)
      setNotice(successMessage)
    } catch (cause) {
      if (scopeGeneration.current !== generation) return
      const code = errorCode(cause)
      if (
        code === 'CONFLICT' ||
        code === 'BAD_REQUEST' ||
        code === 'NOT_FOUND' ||
        code === 'PRECONDITION_FAILED' ||
        code === 'UNAUTHORIZED' ||
        code === 'FORBIDDEN'
      ) {
        setUncertainInput(null)
        try {
          await refresh(generation)
        } catch {
          // The actionable error below remains truthful when authoritative refresh also fails.
        }
        if (scopeGeneration.current !== generation) return
        setError(
          code === 'CONFLICT'
            ? 'The identity review changed. Review the refreshed revision before continuing.'
            : 'This identity review is no longer available for the selected source generation.',
        )
      } else {
        setUncertainInput(input)
        setError(
          'The save outcome could not be confirmed. Inputs are locked; retry the exact decision with the same request identity.',
        )
      }
    } finally {
      if (scopeGeneration.current === generation) {
        inFlightRef.current = false
        setBusy(false)
      }
    }
  }

  function startReview() {
    if (!preview || preview.truncated || preview.candidates.length === 0 || controlsLocked) return
    void submit(
      {
        ...scope,
        requestId: crypto.randomUUID(),
        expectedUpdatedAt: preview.expectedUpdatedAt,
        expectedRevision: 0,
        candidates: preview.candidates,
      },
      'Identity review started. Every mention remains distinct until you record a merge.',
    )
  }

  function mergeGroups() {
    if (
      !review ||
      selectedGroups.length < 2 ||
      !selectedCandidateIds.includes(representativeId) ||
      !mergeRationale.trim() ||
      controlsLocked
    )
      return
    void submit(
      {
        ...scope,
        requestId: crypto.randomUUID(),
        expectedUpdatedAt: preview?.expectedUpdatedAt ?? expectedUpdatedAt,
        expectedRevision: review.revision,
        decision: {
          kind: 'MERGE',
          candidateIds: selectedCandidateIds,
          representativeId,
          rationale: mergeRationale.trim(),
        },
      },
      'Selected groups merged as one reviewed identity.',
    )
  }

  function revertMerge() {
    if (!review || !revertTarget || !revertRationale.trim() || controlsLocked) return
    void submit(
      {
        ...scope,
        requestId: crypto.randomUUID(),
        expectedUpdatedAt: preview?.expectedUpdatedAt ?? expectedUpdatedAt,
        expectedRevision: review.revision,
        decision: {
          kind: 'REVERT_MERGE',
          mergeRequestId: revertTarget,
          rationale: revertRationale.trim(),
        },
      },
      'Merge reverted. Original mention identities and source references were restored.',
    )
  }

  function recordRelationDecision(decision: MediaRelationDecision) {
    if (!review || controlsLocked) return
    void submit(
      {
        ...scope,
        requestId: crypto.randomUUID(),
        expectedUpdatedAt: preview?.expectedUpdatedAt ?? expectedUpdatedAt,
        expectedRevision: review.revision,
        decision,
      },
      decision.kind === 'PROPOSE_RELATION'
        ? 'Relation evidence proposal recorded for review.'
        : decision.kind === 'REVIEW_RELATION'
          ? 'Relation evidence review recorded.'
          : 'Relation evidence review reverted to pending.',
    )
  }

  return (
    <section
      aria-labelledby="media-identity-heading"
      aria-busy={busy}
      className="rounded-2xl border border-pf-light bg-pf-white p-5 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2
            id="media-identity-heading"
            className="text-2xl font-semibold tracking-tight text-pf-deep"
          >
            Identity review
          </h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/65">
            Similar names remain separate source mentions until you explicitly merge them. This
            review does not publish venue content.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={!scopeReady || busy || uncertainInput !== null}
          className="min-h-11 rounded-full border border-pf-light px-4 text-sm font-semibold text-pf-primary hover:border-pf-accent disabled:opacity-50"
        >
          {busy && !loaded ? 'Loading…' : loaded ? 'Refresh candidates' : 'Preview candidates'}
        </button>
      </div>

      {blocked ? (
        <p
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
          role="status"
        >
          Save or discard the current media review edits before changing identity history.
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 text-sm text-rose-800" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-4 text-sm text-emerald-800" role="status">
          {notice}
        </p>
      ) : null}
      {uncertainInput ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit(uncertainInput, 'The exact identity decision was confirmed.')}
          className="mt-4 min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Confirming exact decision…' : 'Retry exact decision'}
        </button>
      ) : null}

      {scopeReady && loaded && preview?.truncated ? (
        <p
          className="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
          role="alert"
        >
          More than 500 identity candidates were found. Narrow the retained source review before
          starting; an incomplete candidate set cannot be frozen.
        </p>
      ) : null}
      {scopeReady && loaded && !review && preview && !preview.truncated ? (
        <div className="mt-5 rounded-xl border border-pf-light bg-pf-surface p-4">
          <p className="text-sm text-pf-deep/75">
            {preview.candidates.length} source mention{preview.candidates.length === 1 ? '' : 's'}{' '}
            ready to freeze. Starting records no merges.
          </p>
          <button
            type="button"
            disabled={controlsLocked || preview.candidates.length === 0}
            onClick={startReview}
            className="mt-3 min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
          >
            Start identity review
          </button>
        </div>
      ) : null}

      {scopeReady && review ? (
        <div className="mt-6 space-y-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-pf-deep">Revision {review.revision}</p>
            <p className="text-xs text-pf-deep/75">
              {review.projection.groups.length} reviewed identities · {review.candidates.length}{' '}
              source mentions
            </p>
          </div>

          <MediaIntakeEvidenceReader
            key={review.id}
            scope={{ tenantId: scope.tenantId, venueId: scope.venueId, runId: review.id }}
            readPage={(input, options) =>
              client.mediaIngestion.readIdentityEvidence.query(
                {
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  projectId: scope.projectId,
                  sourceGeneration: scope.sourceGeneration,
                  revisionId: input.runId,
                  offset: input.offset,
                },
                options,
              )
            }
          />
          <p className="text-xs leading-5 text-pf-deep/75">
            Source method and coverage appear only when retained evidence records them. Missing
            method or coverage fields mean unknown coverage, never exhaustive review.
          </p>

          <fieldset disabled={controlsLocked}>
            <legend className="text-sm font-semibold text-pf-deep">
              Choose whole identity groups to merge
            </legend>
            <p className="mt-1 text-xs leading-5 text-pf-deep/75">
              Selecting a group always includes every original mention and retained source
              reference.
            </p>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {visibleGroups.map((group) => {
                const members = group.candidateIds
                  .map((id) => candidateIndex.get(id))
                  .filter(Boolean)
                const selected = selectedGroups.includes(group.representativeId)
                return (
                  <label
                    key={group.representativeId}
                    className={`flex min-h-11 items-start gap-3 rounded-xl border p-4 ${selected ? 'border-pf-accent bg-pf-surface' : 'border-pf-light bg-white'}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...selectedGroups, group.representativeId]
                          : selectedGroups.filter((id) => id !== group.representativeId)
                        setSelectedGroups(next)
                        const ids = review.projection.groups
                          .filter((item) => next.includes(item.representativeId))
                          .flatMap((item) => item.candidateIds)
                        if (!ids.includes(representativeId)) setRepresentativeId(ids[0] ?? '')
                      }}
                      className="mt-1 h-5 w-5 shrink-0"
                    />
                    <span className="min-w-0">
                      <span className="block font-semibold text-pf-deep">
                        {candidateIndex.get(group.representativeId)?.label ??
                          group.representativeId}
                      </span>
                      <span className="mt-1 block text-xs text-pf-deep/75">
                        {group.candidateIds.length === 1
                          ? 'Distinct mention'
                          : `Merged · ${group.candidateIds.length} mentions`}
                      </span>
                      <span className="mt-2 block break-words text-xs text-pf-deep/75">
                        {members
                          .map((item) => item?.sourceIds.join(', '))
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
            {groups.length > 20 ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={controlsLocked || groupPage === 0}
                  onClick={() => setGroupPage((page) => page - 1)}
                  className="min-h-11 rounded-lg border border-pf-light px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
                >
                  Previous groups
                </button>
                <span className="text-sm text-pf-deep/75">
                  Page {groupPage + 1} of {Math.ceil(groups.length / 20)} · selections persist
                </span>
                <button
                  type="button"
                  disabled={controlsLocked || (groupPage + 1) * 20 >= groups.length}
                  onClick={() => setGroupPage((page) => page + 1)}
                  className="min-h-11 rounded-lg border border-pf-light px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
                >
                  Next groups
                </button>
              </div>
            ) : null}
          </fieldset>

          <div className="grid gap-4 rounded-xl border border-pf-light p-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-pf-deep">
              Representative mention
              <select
                value={representativeId}
                disabled={controlsLocked || selectedCandidateIds.length < 2}
                onChange={(event) => setRepresentativeId(event.target.value)}
                className="mt-2 min-h-11 w-full rounded-lg border border-pf-light bg-white px-3"
              >
                <option value="">Choose a representative</option>
                {selectedCandidateIds.map((id) => (
                  <option key={id} value={id}>
                    {candidateIndex.get(id)?.label ?? id}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-pf-deep">
              Why these mentions are the same entity
              <textarea
                rows={3}
                maxLength={2000}
                value={mergeRationale}
                disabled={controlsLocked}
                onChange={(event) => setMergeRationale(event.target.value)}
                className="mt-2 w-full rounded-lg border border-pf-light bg-white px-3 py-2"
              />
            </label>
            <button
              type="button"
              disabled={
                controlsLocked ||
                selectedGroups.length < 2 ||
                !representativeId ||
                !mergeRationale.trim()
              }
              onClick={mergeGroups}
              className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50 sm:col-span-2 sm:justify-self-start"
            >
              Merge selected groups
            </button>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-pf-deep">Active merge history</h3>
            {activeMerges.length === 0 ? (
              <p className="mt-2 rounded-xl bg-pf-surface p-4 text-sm text-pf-deep/65">
                No active merges. Every mention is currently distinct.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                {activeMerges.map((decision, index) => {
                  const hasDependentMerge = activeMerges
                    .slice(index + 1)
                    .some((later) =>
                      later.candidateIds.some((candidateId) =>
                        decision.candidateIds.includes(candidateId),
                      ),
                    )
                  return (
                    <article
                      key={decision.requestId}
                      className="rounded-xl border border-pf-light p-4"
                    >
                      <p className="font-medium text-pf-deep">
                        {decision.candidateIds.length} mentions merged
                      </p>
                      <p className="mt-1 text-sm text-pf-deep/65">{decision.rationale}</p>
                      <button
                        type="button"
                        disabled={controlsLocked || hasDependentMerge}
                        onClick={() => {
                          setRevertTarget(decision.requestId)
                          setRevertRationale('')
                        }}
                        className="mt-3 min-h-11 rounded-lg border border-pf-light px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
                      >
                        {hasDependentMerge ? 'Revert dependent merge first' : 'Revert this merge'}
                      </button>
                    </article>
                  )
                })}
              </div>
            )}
          </div>

          {revertTarget ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <label className="text-sm font-medium text-amber-950">
                Why this merge should be reverted
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={revertRationale}
                  disabled={controlsLocked}
                  onChange={(event) => setRevertRationale(event.target.value)}
                  className="mt-2 w-full rounded-lg border border-amber-300 bg-white px-3 py-2"
                />
              </label>
              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={controlsLocked || !revertRationale.trim()}
                  onClick={revertMerge}
                  className="min-h-11 rounded-xl bg-amber-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
                >
                  Confirm merge reversion
                </button>
                <button
                  type="button"
                  disabled={controlsLocked}
                  onClick={() => setRevertTarget(null)}
                  className="min-h-11 rounded-xl border border-amber-300 bg-white px-4 text-sm font-semibold text-amber-950 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          <MediaRelationReviewControls
            key={`relations-${review.revision}`}
            review={review}
            disabled={controlsLocked}
            onDecision={recordRelationDecision}
          />
        </div>
      ) : null}
    </section>
  )
}
