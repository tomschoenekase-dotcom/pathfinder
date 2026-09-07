'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'

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
}
type IdentityReview = {
  id: string
  revision: number
  projection: { groups: Array<{ representativeId: string; candidateIds: string[] }> }
  candidates: Array<{ candidateId: string; label: string; sourceIds: string[] }>
}
export type MediaIntakeHandoffAdapter = {
  preview: (scope: Scope & { sourceCursor?: string }) => Promise<Preview>
  create: (input: Request) => Promise<{ runId: string }>
  getIdentityReview?: (
    scope: Scope & { sourceGeneration: string },
  ) => Promise<IdentityReview | null>
}

const control =
  'min-h-11 rounded-lg border border-pf-light px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-pf-primary disabled:opacity-50'

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
  const [preview, setPreview] = useState<Preview | null>(null)
  const [identityReview, setIdentityReview] = useState<IdentityReview | null>(null)
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [rationale, setRationale] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [attempted, setAttempted] = useState(false)
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
  const controller = useRef(new AbortController())
  useEffect(() => {
    controller.current = new AbortController()
    return () => controller.current.abort()
  }, [])
  const load = async () => {
    if (inFlight.current || blocked || attempted) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const loaded = await runBoundedClientRequest({
        parentSignal: controller.current.signal,
        timeoutMs: 15_000,
        request: (signal) =>
          adapter
            ? adapter.preview(scope)
            : client.mediaIngestion.previewIntakeHandoff.query(scope, { signal }),
      })
      if (controller.current.signal.aborted) return
      const review = loaded.sourceGeneration
        ? await runBoundedClientRequest({
            parentSignal: controller.current.signal,
            timeoutMs: 15_000,
            request: (signal) =>
              adapter
                ? (adapter.getIdentityReview?.({
                    ...scope,
                    sourceGeneration: loaded.sourceGeneration!,
                  }) ?? Promise.resolve(null))
                : client.mediaIngestion.getIdentityReview.query(
                    { ...scope, sourceGeneration: loaded.sourceGeneration! },
                    { signal },
                  ),
          })
        : null
      if (controller.current.signal.aborted) return
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
    } catch {
      setError('Could not load the saved review. Try again.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const complete = Boolean(
    preview?.ready &&
    preview.sourceGeneration &&
    preview.items.length &&
    preview.items.every((item) => selections[`${item.kind}:${item.itemIndex}`]) &&
    rationale.trim(),
  )
  const loadMoreSources = async () => {
    if (inFlight.current || !preview?.nextSourceCursor || attempted || blocked) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const input = { ...scope, sourceCursor: preview.nextSourceCursor }
      const next = await runBoundedClientRequest({
        parentSignal: controller.current.signal,
        timeoutMs: 15_000,
        request: (signal) =>
          adapter
            ? adapter.preview(input)
            : client.mediaIngestion.previewIntakeHandoff.query(input, { signal }),
      })
      if (controller.current.signal.aborted) return
      if (
        next.updatedAt !== preview.updatedAt ||
        next.sourceGeneration !== preview.sourceGeneration
      ) {
        setError('The saved review changed. Reload it before choosing sources.')
        setPreview(null)
        setSelections({})
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
      setError('Could not load more sources. Your selections are retained.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const submit = async () => {
    if (
      inFlight.current ||
      blocked ||
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
            sourceIds: [selection.replace(/^source:/u, '')],
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
      }
    }
    inFlight.current = true
    setBusy(true)
    setAttempted(true)
    setError(null)
    try {
      const retainedRequest = requestRef.current
      const saved = await runBoundedClientRequest({
        parentSignal: controller.current.signal,
        timeoutMs: 15_000,
        request: (signal) =>
          adapter
            ? adapter.create(retainedRequest)
            : client.mediaIngestion.createIntakeHandoff.mutate(retainedRequest, { signal }),
      })
      if (controller.current.signal.aborted) return
      setRunId(saved.runId)
    } catch (failure) {
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
        setError(
          'The server declined this handoff. Reload the saved review and resolve any changed source or access details before trying again.',
        )
      } else {
        setError(
          'The handoff was not confirmed. Retry this same request to check or complete it; your source choices are retained.',
        )
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const selectedCount =
    preview?.items.filter((item) => selections[`${item.kind}:${item.itemIndex}`]).length ?? 0
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
      {!runId && !attempted && (
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
      {preview && !runId && (
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
                        onChange={(event) =>
                          setSelections((current) => ({ ...current, [key]: event.target.value }))
                        }
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
      {error && (
        <p role="alert" className="mt-3 text-sm text-rose-700">
          {error}
        </p>
      )}
      {runId && (
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
