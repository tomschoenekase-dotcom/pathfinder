'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MediaTemporalClaimSchema,
  type MediaTemporalClaim,
} from '@pathfinder/contracts/media-temporal-claims'

import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import {
  MediaTemporalReviewPanel,
  type MediaTemporalReviewAdapter,
} from './MediaTemporalReviewPanel'

type Scope = { tenantId: string; venueId: string; projectId: string }
type Preview = {
  sourceGeneration: string | null
  updatedAt: string
  ready: boolean
  issues: string[]
  items: Array<{ kind: 'place' | 'knowledge'; itemIndex: number; itemHash: string; label: string }>
  sources: Array<{ sourceId: string; filename: string }>
  nextSourceCursor: string | null
}
type Request = Scope & {
  requestId: string
  sourceGeneration: string
  expectedUpdatedAt: string
  bindings: Array<{
    kind: 'place' | 'knowledge'
    itemIndex: number
    itemHash: string
    sourceIds: string[]
    entityRepresentativeId?: string
  }>
  rationale: string
  identityReviewId?: string
  temporalClaims?: MediaTemporalClaim[]
}
type TemporalPreview = {
  evaluatedAt: string
  authorityBasis: 'REVIEW_ASSERTED'
  authorityVerified: false
  reviewReceiptHash: string
  reconciliation: {
    comparisonCount: number
    comparisonsTruncated: boolean
    selectedClaimIds: string[]
  }
  items: Array<{
    kind: 'place' | 'knowledge'
    itemIndex: number
    itemHash: string
    label: string
    handoffStatus: 'ELIGIBLE' | 'HELD'
    holdReasons: Array<'CONFLICT' | 'DATE_BOUND' | 'NO_CURRENT_SUPPORT'>
  }>
}
type IdentityReview = {
  id: string
  revision: number
  projection: { groups: Array<{ representativeId: string; candidateIds: string[] }> }
  candidates: Array<{ candidateId: string; label: string; sourceIds: string[] }>
}
export type MediaIntakeHandoffAdapter = {
  preview: (scope: Scope & { sourceCursor?: string }, signal: AbortSignal) => Promise<Preview>
  create: (input: Request, signal: AbortSignal) => Promise<{ runId: string }>
  getIdentityReview?: (
    scope: Scope & { sourceGeneration: string },
    signal: AbortSignal,
  ) => Promise<IdentityReview | null>
  previewTemporal?: (
    input: Scope & {
      sourceGeneration: string
      expectedUpdatedAt: string
      claims: MediaTemporalClaim[]
    },
    signal: AbortSignal,
  ) => Promise<TemporalPreview>
  temporalReview?: MediaTemporalReviewAdapter
}

const control =
  'min-h-11 rounded-lg border border-pf-light px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-pf-primary disabled:opacity-50'
const TemporalClaimsInput = MediaTemporalClaimSchema.array().min(1).max(100)

/** Deliberate source selection turns a saved extraction into an auditable Builder proposal. */
export function MediaIntakeHandoffPanel({
  scope,
  blocked,
  adapter,
}: {
  scope: Scope
  blocked: boolean
  adapter?: MediaIntakeHandoffAdapter
}) {
  const client = useTRPCClient()
  const scopeKey = JSON.stringify([scope.tenantId, scope.venueId, scope.projectId])
  const [dataScopeKey, setDataScopeKey] = useState(scopeKey)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [identityReview, setIdentityReview] = useState<IdentityReview | null>(null)
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [rationale, setRationale] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [attempted, setAttempted] = useState(false)
  const [temporalJson, setTemporalJson] = useState('')
  const [temporalClaims, setTemporalClaims] = useState<MediaTemporalClaim[] | null>(null)
  const [temporalPreview, setTemporalPreview] = useState<TemporalPreview | null>(null)
  const [temporalError, setTemporalError] = useState<string | null>(null)
  const [temporalPage, setTemporalPage] = useState(0)
  const identityOptions = useMemo(() => {
    const candidates = new Map(
      identityReview?.candidates.map((candidate) => [candidate.candidateId, candidate]) ?? [],
    )
    return (
      identityReview?.projection.groups.map((group) => {
        const members = group.candidateIds.map((id) => candidates.get(id)).filter(Boolean)
        const sourceCount = new Set(members.flatMap((candidate) => candidate!.sourceIds)).size
        const label = members
          .slice(0, 2)
          .map((candidate) => candidate!.label)
          .join(' + ')
        return {
          representativeId: group.representativeId,
          sourceCount,
          label: `${label}${members.length > 2 ? ` + ${members.length - 2} more` : ''}`,
        }
      }) ?? []
    )
  }, [identityReview])
  const requestRef = useRef<Request | null>(null)
  const inFlight = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const renderedScope = useRef(scopeKey)
  const scopeGeneration = useRef(0)
  if (renderedScope.current !== scopeKey) {
    renderedScope.current = scopeKey
    scopeGeneration.current += 1
  }
  const scopeReady = dataScopeKey === scopeKey
  const selectionFingerprint = JSON.stringify(
    Object.entries(selections).sort(([left], [right]) => left.localeCompare(right)),
  )
  const renderedSelectionFingerprint = useRef(selectionFingerprint)
  renderedSelectionFingerprint.current = selectionFingerprint
  useEffect(() => {
    controller.current?.abort()
    controller.current = null
    inFlight.current = false
    requestRef.current = null
    setPreview(null)
    setIdentityReview(null)
    setSelections({})
    setRationale('')
    setBusy(false)
    setError(null)
    setRunId(null)
    setPage(0)
    setAttempted(false)
    setTemporalJson('')
    setTemporalClaims(null)
    setTemporalPreview(null)
    setTemporalError(null)
    setTemporalPage(0)
    setDataScopeKey(scopeKey)
  }, [scopeKey])
  useEffect(
    () => () => {
      scopeGeneration.current += 1
      controller.current?.abort()
    },
    [],
  )
  const bounded = async <T,>(request: (signal: AbortSignal) => Promise<T>) => {
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    try {
      return await runBoundedClientRequest({
        parentSignal: next.signal,
        timeoutMs: 15_000,
        request,
      })
    } finally {
      if (controller.current === next) controller.current = null
    }
  }
  const load = async () => {
    if (inFlight.current || blocked || attempted || !scopeReady) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    const generation = scopeGeneration.current
    try {
      const loaded = await bounded((signal) =>
        adapter
          ? adapter.preview(scope, signal)
          : client.mediaIngestion.previewIntakeHandoff.query(scope, { signal }),
      )
      if (scopeGeneration.current !== generation) return
      const review = loaded.sourceGeneration
        ? await bounded((signal) =>
            adapter
              ? (adapter.getIdentityReview?.(
                  {
                    ...scope,
                    sourceGeneration: loaded.sourceGeneration!,
                  },
                  signal,
                ) ?? Promise.resolve(null))
              : client.mediaIngestion.getIdentityReview.query(
                  { ...scope, sourceGeneration: loaded.sourceGeneration! },
                  { signal },
                ),
          )
        : null
      if (scopeGeneration.current !== generation) return
      setPreview({
        ...loaded,
        updatedAt:
          typeof loaded.updatedAt === 'string'
            ? loaded.updatedAt
            : new Date(loaded.updatedAt).toISOString(),
      })
      setSelections({})
      setIdentityReview(review)
      setPage(0)
      setTemporalJson('')
      setTemporalClaims(null)
      setTemporalPreview(null)
      setTemporalError(null)
      setTemporalPage(0)
    } catch {
      if (scopeGeneration.current === generation)
        setError('Could not load the saved review. Try again.')
    } finally {
      if (scopeGeneration.current === generation) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }
  const sourcesForSelection = (selection: string | undefined) => {
    if (!selection) return []
    if (!selection.startsWith('group:')) return [selection.replace(/^source:/u, '')]
    const representativeId = selection.slice('group:'.length)
    const group = identityReview?.projection.groups.find(
      (item) => item.representativeId === representativeId,
    )
    return [
      ...new Set(
        group?.candidateIds.flatMap(
          (candidateId) =>
            identityReview?.candidates.find((candidate) => candidate.candidateId === candidateId)
              ?.sourceIds ?? [],
        ) ?? [],
      ),
    ]
  }
  const allItemsBound = Boolean(
    preview?.ready &&
    preview.items.length &&
    preview.items.every((item) => selections[`${item.kind}:${item.itemIndex}`]),
  )
  const temporalReady =
    !temporalJson.trim() ||
    Boolean(
      temporalClaims && temporalPreview?.items.some((item) => item.handoffStatus === 'ELIGIBLE'),
    )
  const complete = Boolean(
    preview?.sourceGeneration && allItemsBound && temporalReady && rationale.trim(),
  )

  const previewTemporalClaims = async () => {
    if (
      inFlight.current ||
      blocked ||
      attempted ||
      !scopeReady ||
      !preview?.sourceGeneration ||
      !allItemsBound
    )
      return
    setTemporalError(null)
    let claims: MediaTemporalClaim[]
    try {
      claims = TemporalClaimsInput.parse(JSON.parse(temporalJson))
    } catch {
      setTemporalClaims(null)
      setTemporalPreview(null)
      setTemporalError('Enter a valid array of 1–100 temporal claims before previewing.')
      return
    }
    const itemsByHash = new Map(preview.items.map((item) => [item.itemHash, item]))
    const mismatched = claims.find((claim) => {
      const item = itemsByHash.get(claim.targetItemHash)
      if (!item) return true
      return !sourcesForSelection(selections[`${item.kind}:${item.itemIndex}`]).includes(
        claim.source.sourceId,
      )
    })
    if (mismatched) {
      setTemporalClaims(null)
      setTemporalPreview(null)
      setTemporalError(
        `Claim ${mismatched.claimId} must use evidence selected for its exact draft item.`,
      )
      return
    }
    const generation = scopeGeneration.current
    const bindingFingerprint = renderedSelectionFingerprint.current
    inFlight.current = true
    setBusy(true)
    try {
      const input = {
        ...scope,
        sourceGeneration: preview.sourceGeneration,
        expectedUpdatedAt: preview.updatedAt,
        claims,
      }
      const next = await bounded((signal) =>
        adapter?.previewTemporal
          ? adapter.previewTemporal(input, signal)
          : client.mediaIngestion.previewTemporalReview.query(input, { signal }),
      )
      if (
        scopeGeneration.current !== generation ||
        renderedSelectionFingerprint.current !== bindingFingerprint
      )
        return
      setTemporalClaims(claims)
      setTemporalPreview(next)
      setTemporalPage(0)
    } catch {
      if (scopeGeneration.current === generation) {
        setTemporalClaims(null)
        setTemporalPreview(null)
        setTemporalError('Temporal claims could not be previewed against the saved review.')
      }
    } finally {
      if (scopeGeneration.current === generation) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }
  const loadMoreSources = async () => {
    if (inFlight.current || !preview?.nextSourceCursor || attempted || blocked || !scopeReady)
      return
    inFlight.current = true
    setBusy(true)
    setError(null)
    const generation = scopeGeneration.current
    try {
      const input = { ...scope, sourceCursor: preview.nextSourceCursor }
      const next = await bounded((signal) =>
        adapter
          ? adapter.preview(input, signal)
          : client.mediaIngestion.previewIntakeHandoff.query(input, { signal }),
      )
      if (scopeGeneration.current !== generation) return
      if (
        next.updatedAt !== preview.updatedAt ||
        next.sourceGeneration !== preview.sourceGeneration
      ) {
        setError('The saved review changed. Reload it before choosing sources.')
        setPreview(null)
        setSelections({})
        setTemporalClaims(null)
        setTemporalPreview(null)
        setTemporalError(null)
        setTemporalPage(0)
        return
      }
      setPreview({
        ...preview,
        sources: [
          ...new Map(
            [...preview.sources, ...next.sources].map((source) => [source.sourceId, source]),
          ).values(),
        ],
        nextSourceCursor: next.nextSourceCursor,
      })
    } catch {
      if (scopeGeneration.current === generation)
        setError('Could not load more sources. Your selections are retained.')
    } finally {
      if (scopeGeneration.current === generation) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }
  const submit = async () => {
    if (
      inFlight.current ||
      blocked ||
      !scopeReady ||
      (!requestRef.current && !complete) ||
      !preview?.sourceGeneration
    )
      return
    if (!requestRef.current) {
      const candidates = new Map(
        identityReview?.candidates.map((candidate) => [candidate.candidateId, candidate]) ?? [],
      )
      const groups = new Map(
        identityReview?.projection.groups.map((group) => [group.representativeId, group]) ?? [],
      )
      const bindings = preview.items.map((item) => {
        const selection = selections[`${item.kind}:${item.itemIndex}`]!
        if (!selection.startsWith('group:')) {
          return {
            kind: item.kind,
            itemIndex: item.itemIndex,
            itemHash: item.itemHash,
            sourceIds: sourcesForSelection(selection),
          }
        }
        const representativeId = selection.slice('group:'.length)
        const group = groups.get(representativeId)!
        return {
          kind: item.kind,
          itemIndex: item.itemIndex,
          itemHash: item.itemHash,
          sourceIds: [
            ...new Set(
              group.candidateIds.flatMap(
                (candidateId) => candidates.get(candidateId)?.sourceIds ?? [],
              ),
            ),
          ],
          entityRepresentativeId: representativeId,
        }
      })
      const usesIdentityReview = bindings.some((binding) => binding.entityRepresentativeId)
      requestRef.current = {
        ...scope,
        requestId: crypto.randomUUID(),
        sourceGeneration: preview.sourceGeneration,
        expectedUpdatedAt: preview.updatedAt,
        bindings,
        rationale: rationale.trim(),
        ...(usesIdentityReview && identityReview ? { identityReviewId: identityReview.id } : {}),
        ...(temporalClaims && temporalPreview ? { temporalClaims } : {}),
      }
    }
    inFlight.current = true
    setBusy(true)
    setAttempted(true)
    setError(null)
    const generation = scopeGeneration.current
    try {
      const retainedRequest = requestRef.current
      const saved = await bounded((signal) =>
        adapter
          ? adapter.create(retainedRequest, signal)
          : client.mediaIngestion.createIntakeHandoff.mutate(retainedRequest, { signal }),
      )
      if (scopeGeneration.current !== generation) return
      setRunId(saved.runId)
    } catch (failure) {
      if (scopeGeneration.current !== generation) return
      const data = failure && typeof failure === 'object' && 'data' in failure ? failure.data : null
      const code = data && typeof data === 'object' && 'code' in data ? data.code : null
      if (
        typeof code === 'string' &&
        [
          'BAD_REQUEST',
          'UNAUTHORIZED',
          'FORBIDDEN',
          'NOT_FOUND',
          'CONFLICT',
          'PRECONDITION_FAILED',
        ].includes(code)
      ) {
        requestRef.current = null
        setAttempted(false)
        setPreview(null)
        setSelections({})
        setTemporalClaims(null)
        setTemporalPreview(null)
        setError(
          'The server declined this handoff. Reload the saved review and resolve any changed source or access details before trying again.',
        )
      } else {
        setError(
          'The handoff was not confirmed. Retry this same request to check or complete it; your source choices are retained.',
        )
      }
    } finally {
      if (scopeGeneration.current === generation) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }
  const selectedCount =
    preview?.items.filter((item) => selections[`${item.kind}:${item.itemIndex}`]).length ?? 0
  const heldCount =
    temporalPreview?.items.filter((item) => item.handoffStatus === 'HELD').length ?? 0
  const eligibleCount = temporalPreview ? temporalPreview.items.length - heldCount : null
  const visibleTemporalItems =
    temporalPreview?.items.slice(temporalPage * 50, (temporalPage + 1) * 50) ?? []
  const visibleItems = preview?.items.slice(page * 20, (page + 1) * 20) ?? []
  return (
    <section className="border-t border-pf-light pt-6" aria-labelledby="media-handoff-heading">
      <h2 id="media-handoff-heading" className="text-2xl font-semibold tracking-tight text-pf-deep">
        Send reviewed content to Builder
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/70">
        Choose the source supporting each saved item. Builder will keep the review and its source
        evidence together for the next approval.
      </p>
      {blocked && (
        <p className="mt-3 text-sm text-amber-800">
          Save your review changes before preparing the handoff.
        </p>
      )}
      {scopeReady && !runId && !attempted && (
        <button
          type="button"
          className={`${control} mt-4`}
          disabled={blocked || busy}
          onClick={() => void load()}
        >
          {busy
            ? 'Loading saved review…'
            : preview
              ? 'Reload saved review'
              : 'Prepare saved review'}
        </button>
      )}
      {scopeReady && preview && !runId && (
        <div className="mt-5 space-y-5">
          {preview.issues.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800">
              {preview.issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          )}
          {preview.ready && (
            <>
              <p className="text-sm font-medium text-pf-deep" aria-live="polite">
                {selectedCount} of {preview.items.length} items linked to a source
              </p>
              {preview.nextSourceCursor && (
                <button
                  type="button"
                  className={control}
                  disabled={busy || blocked || attempted}
                  onClick={() => void loadMoreSources()}
                >
                  Load more supporting sources
                </button>
              )}
              <div className="divide-y divide-pf-light">
                {visibleItems.map((item) => {
                  const key = `${item.kind}:${item.itemIndex}`
                  return (
                    <label
                      key={key}
                      className="grid gap-2 py-4 sm:grid-cols-2 sm:items-center sm:gap-5"
                    >
                      <span className="min-w-0 break-words text-sm font-medium text-pf-deep">
                        {item.label}
                      </span>
                      <select
                        className={`${control} w-full min-w-0`}
                        value={selections[key] ?? ''}
                        disabled={busy || blocked || attempted}
                        onChange={(event) => {
                          setSelections((current) => ({ ...current, [key]: event.target.value }))
                          setTemporalClaims(null)
                          setTemporalPreview(null)
                          setTemporalError(
                            temporalJson.trim()
                              ? 'Source selection changed. Preview the temporal claims again.'
                              : null,
                          )
                          setTemporalPage(0)
                          requestRef.current = null
                        }}
                      >
                        <option value="">Choose supporting source</option>
                        {preview.sources.map((source) => (
                          <option key={source.sourceId} value={`source:${source.sourceId}`}>
                            {source.filename}
                          </option>
                        ))}
                        {identityOptions.map((group) => {
                          return (
                            <option
                              key={`group:${group.representativeId}`}
                              value={`group:${group.representativeId}`}
                              disabled={group.sourceCount > 20}
                            >
                              Reviewed group — {group.label} (
                              {group.sourceCount > 20
                                ? 'exceeds 20-source handoff limit'
                                : 'grouped by reviewer; identity unconfirmed'}
                              )
                            </option>
                          )
                        })}
                      </select>
                    </label>
                  )
                })}
              </div>
              {preview.items.length > 20 && (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    className={control}
                    disabled={page === 0}
                    onClick={() => setPage((current) => current - 1)}
                  >
                    Previous items
                  </button>
                  <span className="text-sm">
                    Page {page + 1} of {Math.ceil(preview.items.length / 20)}
                  </span>
                  <button
                    type="button"
                    className={control}
                    disabled={(page + 1) * 20 >= preview.items.length}
                    onClick={() => setPage((current) => current + 1)}
                  >
                    Next items
                  </button>
                </div>
              )}
              <details className="rounded-xl border border-pf-light bg-pf-surface p-4">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-pf-primary">
                  Optional temporal claim review
                </summary>
                <div className="mt-3 space-y-4">
                  <p className="text-xs leading-5 text-pf-deep/70">
                    Paste an agent-prepared JSON array of exact temporal claims. Authority is a
                    reviewer assertion and is not independently verified. Dated, conflicting, or
                    no-longer-current items stay on local hold and do not enter the static Builder
                    candidate.
                  </p>
                  <label className="block text-sm font-medium text-pf-deep">
                    Temporal claims JSON
                    <textarea
                      className={`${control} mt-2 block min-h-40 w-full font-mono text-xs`}
                      value={temporalJson}
                      disabled={busy || blocked || attempted}
                      spellCheck={false}
                      onChange={(event) => {
                        setTemporalJson(event.target.value)
                        setTemporalClaims(null)
                        setTemporalPreview(null)
                        setTemporalError(null)
                        setTemporalPage(0)
                        requestRef.current = null
                      }}
                      placeholder='[{"claimId":"…","targetItemHash":"…","source":{…}}]'
                    />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      className={control}
                      disabled={
                        busy || blocked || attempted || !allItemsBound || !temporalJson.trim()
                      }
                      onClick={() => void previewTemporalClaims()}
                    >
                      {busy ? 'Previewing…' : 'Preview temporal claims'}
                    </button>
                    {temporalJson ? (
                      <button
                        type="button"
                        className={control}
                        disabled={busy || blocked || attempted}
                        onClick={() => {
                          setTemporalJson('')
                          setTemporalClaims(null)
                          setTemporalPreview(null)
                          setTemporalError(null)
                          setTemporalPage(0)
                          requestRef.current = null
                        }}
                      >
                        Clear temporal claims
                      </button>
                    ) : null}
                  </div>
                  {temporalError ? (
                    <p role="alert" className="text-sm text-rose-700">
                      {temporalError}
                    </p>
                  ) : null}
                  {temporalPreview ? (
                    <div className="rounded-lg border border-pf-light bg-white p-4">
                      <p className="text-sm font-semibold text-pf-deep">
                        {eligibleCount} eligible for the static candidate · {heldCount} retained on
                        local hold
                      </p>
                      <p className="mt-1 text-xs leading-5 text-pf-deep/70">
                        Evaluated {new Date(temporalPreview.evaluatedAt).toLocaleString()} ·
                        authority asserted for review, not verified ·{' '}
                        {temporalPreview.reconciliation.selectedClaimIds.length} claim
                        recommendation
                        {temporalPreview.reconciliation.selectedClaimIds.length === 1 ? '' : 's'}.
                      </p>
                      {temporalPreview.reconciliation.comparisonsTruncated ? (
                        <p className="mt-2 text-xs font-medium text-amber-900">
                          Showing a bounded comparison preview;{' '}
                          {temporalPreview.reconciliation.comparisonCount} comparison groups were
                          retained in the review.
                        </p>
                      ) : null}
                      <ul className="mt-3 divide-y divide-pf-light text-sm">
                        {visibleTemporalItems.map((item) => (
                          <li
                            key={`${item.kind}:${item.itemIndex}`}
                            className="flex flex-wrap items-start justify-between gap-2 py-3"
                          >
                            <span className="min-w-0 break-words text-pf-deep">{item.label}</span>
                            <span
                              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${item.handoffStatus === 'HELD' ? 'bg-amber-100 text-amber-950' : 'bg-emerald-100 text-emerald-900'}`}
                            >
                              {item.handoffStatus === 'HELD'
                                ? `Held · ${item.holdReasons
                                    .map((reason) =>
                                      reason === 'DATE_BOUND'
                                        ? 'date-bound'
                                        : reason === 'NO_CURRENT_SUPPORT'
                                          ? 'no current supporting evidence'
                                          : 'conflict',
                                    )
                                    .join(' + ')}`
                                : 'Eligible'}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {temporalPreview.items.length > 50 ? (
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            className={control}
                            disabled={temporalPage === 0 || busy || attempted}
                            onClick={() => setTemporalPage((current) => current - 1)}
                          >
                            Previous temporal items
                          </button>
                          <span className="text-xs text-pf-deep/70">
                            Page {temporalPage + 1} of{' '}
                            {Math.ceil(temporalPreview.items.length / 50)}
                          </span>
                          <button
                            type="button"
                            className={control}
                            disabled={
                              (temporalPage + 1) * 50 >= temporalPreview.items.length ||
                              busy ||
                              attempted
                            }
                            onClick={() => setTemporalPage((current) => current + 1)}
                          >
                            Next temporal items
                          </button>
                        </div>
                      ) : null}
                      {eligibleCount === 0 ? (
                        <>
                          <p className="mt-3 text-sm font-medium text-amber-900">
                            Every item is held. Resolve conflicting or time-bound evidence and items
                            without current support before creating a static Builder candidate.
                          </p>
                          {preview.sourceGeneration && temporalClaims ? (
                            <div className="mt-4">
                              <MediaTemporalReviewPanel
                                scope={scope}
                                sourceGeneration={preview.sourceGeneration}
                                expectedUpdatedAt={preview.updatedAt}
                                rationale={rationale}
                                claims={temporalClaims}
                                bindings={preview.items.map((draftItem) => ({
                                  kind: draftItem.kind,
                                  itemIndex: draftItem.itemIndex,
                                  itemHash: draftItem.itemHash,
                                  sourceIds: sourcesForSelection(
                                    selections[`${draftItem.kind}:${draftItem.itemIndex}`],
                                  ),
                                }))}
                                allHeld
                                blocked={blocked || attempted}
                                {...(adapter?.temporalReview
                                  ? { adapter: adapter.temporalReview }
                                  : {})}
                              />
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </details>
              <label className="block text-sm font-medium text-pf-deep">
                Review note
                <textarea
                  className={`${control} mt-2 block min-h-24 w-full`}
                  maxLength={2000}
                  value={rationale}
                  disabled={busy || blocked || attempted}
                  onChange={(event) => setRationale(event.target.value)}
                  placeholder="What did you verify or limit in this review?"
                />
              </label>
              <button
                type="button"
                className={`${control} bg-pf-primary text-white`}
                disabled={busy || blocked || (!attempted && !complete)}
                onClick={() => void submit()}
              >
                {busy
                  ? 'Confirming handoff…'
                  : attempted
                    ? 'Retry same handoff'
                    : 'Create Builder proposal'}
              </button>
            </>
          )}
        </div>
      )}
      {scopeReady && error && (
        <p role="alert" className="mt-3 text-sm text-rose-700">
          {error}
        </p>
      )}
      {scopeReady && runId && (
        <p role="status" className="mt-4 text-sm text-pf-deep">
          Proposal created.{' '}
          <a
            className="inline-flex min-h-11 items-center font-semibold text-pf-primary underline"
            href={`/admin/clients/${encodeURIComponent(scope.tenantId)}/venues/${encodeURIComponent(scope.venueId)}/intake?runId=${encodeURIComponent(runId)}`}
          >
            Open in Builder
          </a>
        </p>
      )}
    </section>
  )
}
