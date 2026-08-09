'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../lib/trpc'
import { currentDeletedVersions } from '../lib/content-history-diff'

type VenueVersion = {
  id: string
  sequence: bigint
  entityType: string
  entityId: string
  beforeState: unknown
  afterState: unknown
  createdAt: Date
}

function labelFor(version: VenueVersion): string {
  const before = version.beforeState
  if (typeof before === 'object' && before !== null && !Array.isArray(before)) {
    const record = before as Record<string, unknown>
    if (typeof record.name === 'string') return record.name
    if (typeof record.title === 'string') return record.title
  }
  return version.entityId
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'History request failed.'
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

type PendingAction = { kind: 'load' | 'restore'; versionId?: string }
type Feedback = { kind: 'error' | 'success'; text: string }

function mergeVersions(current: VenueVersion[], incoming: VenueVersion[]) {
  const incomingIds = new Set(incoming.map((version) => version.id))
  return [...incoming, ...current.filter((version) => !incomingIds.has(version.id))]
}

function appendVersions(current: VenueVersion[], incoming: VenueVersion[]) {
  const currentIds = new Set(current.map((version) => version.id))
  return [...current, ...incoming.filter((version) => !currentIds.has(version.id))]
}

export function DeletedContentHistoryPanel({ venueId }: { venueId: string }) {
  const router = useRouter()
  const client = useTRPCClient()
  const [versions, setVersions] = useState<VenueVersion[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [requiresReload, setRequiresReload] = useState(false)
  const mounted = useRef(false)
  const scopeGeneration = useRef(0)
  const actionSequence = useRef(0)
  const activeAction = useRef<number | null>(null)
  const deleted = currentDeletedVersions(versions).filter(
    (version) => version.entityType !== 'VENUE',
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeAction.current = null
    }
  }, [])

  useLayoutEffect(() => {
    scopeGeneration.current += 1
    activeAction.current = null
    setVersions([])
    setIsOpen(false)
    setHasMore(false)
    setPending(null)
    setFeedback(null)
    setRequiresReload(false)
  }, [venueId])

  function startAction(next: PendingAction): { scope: number; token: number } | null {
    if (activeAction.current !== null) return null
    const token = ++actionSequence.current
    activeAction.current = token
    setPending(next)
    return { scope: scopeGeneration.current, token }
  }

  function isCurrentAction(action: { scope: number; token: number }) {
    return (
      mounted.current &&
      scopeGeneration.current === action.scope &&
      activeAction.current === action.token
    )
  }

  function finishAction(action: { scope: number; token: number }) {
    if (!isCurrentAction(action)) return
    activeAction.current = null
    setPending(null)
  }

  async function load(beforeSequence?: bigint) {
    const action = startAction({ kind: 'load' })
    if (!action) return
    setFeedback(null)
    try {
      const result = await client.contentHistory.listForVenue.query({
        venueId,
        limit: 100,
        ...(beforeSequence !== undefined ? { beforeSequence } : {}),
      })
      if (!isCurrentAction(action)) return
      setVersions((current) =>
        beforeSequence === undefined ? result : appendVersions(current, result),
      )
      setHasMore(result.length === 100)
      setRequiresReload(false)
    } catch (loadError) {
      if (!isCurrentAction(action)) return
      setFeedback({ kind: 'error', text: errorMessage(loadError) })
    } finally {
      finishAction(action)
    }
  }

  async function restore(version: VenueVersion) {
    const action = startAction({ kind: 'restore', versionId: version.id })
    if (!action) return
    if (!window.confirm(`Restore deleted ${labelFor(version)}?`)) {
      finishAction(action)
      return
    }
    setFeedback(null)
    try {
      const applied = await client.contentHistory.revert.mutate({
        versionId: version.id,
        expectedCurrentVersionId: version.id,
        snapshotSide: 'BEFORE',
      })
      if (!isCurrentAction(action)) return
      setVersions((loaded) => mergeVersions(loaded, [applied]))
      router.refresh()
      try {
        const result = await client.contentHistory.listForVenue.query({ venueId, limit: 100 })
        if (!isCurrentAction(action)) return
        setVersions(result)
        setHasMore(result.length === 100)
        setRequiresReload(false)
        setFeedback({ kind: 'success', text: 'Deleted content restored.' })
      } catch {
        if (!isCurrentAction(action)) return
        setRequiresReload(true)
        setFeedback({
          kind: 'error',
          text: 'The content was restored, but deleted-content history could not be refreshed. Do not repeat the restore; reload the page.',
        })
      }
    } catch (restoreError) {
      if (!isCurrentAction(action)) return
      setRequiresReload(true)
      setFeedback({
        kind: 'error',
        text:
          errorCode(restoreError) === 'CONFLICT'
            ? 'Deleted content changed after this recovery view was loaded. Reloading authoritative state; review it before retrying.'
            : 'The restore outcome could not be confirmed. Reloading authoritative state; review deleted content before retrying.',
      })
      router.refresh()
    } finally {
      finishAction(action)
    }
  }

  const isLoading = pending?.kind === 'load'
  const restoringId = pending?.kind === 'restore' ? pending.versionId : null

  return (
    <section
      className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm"
      aria-busy={pending !== null}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Deleted content</h2>
          <p className="mt-1 text-sm text-pf-deep/60">
            Find and restore deleted guide items or knowledge entries.
          </p>
        </div>
        <button
          type="button"
          disabled={pending !== null}
          aria-expanded={isOpen}
          onClick={() => {
            if (activeAction.current !== null) return
            const next = !isOpen
            setIsOpen(next)
            if (next) void load()
          }}
          className="inline-flex min-h-10 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary"
        >
          {isOpen ? 'Hide deleted content' : 'Review deleted content'}
        </button>
      </div>

      {isOpen ? (
        <div className="mt-5 space-y-3">
          {feedback ? (
            <p
              className={`rounded-xl p-3 text-sm ${
                feedback.kind === 'error'
                  ? 'bg-rose-50 text-rose-700'
                  : 'bg-emerald-50 text-emerald-700'
              }`}
              role={feedback.kind === 'error' ? 'alert' : 'status'}
            >
              {feedback.text}
            </p>
          ) : null}
          {requiresReload && pending === null ? (
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex min-h-9 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary"
            >
              Reload deleted content
            </button>
          ) : null}
          {isLoading && versions.length > 0 ? (
            <p className="text-sm text-pf-deep/50" role="status">
              Refreshing deleted content…
            </p>
          ) : null}
          {isLoading && versions.length === 0 ? (
            <p className="text-sm text-pf-deep/50" role="status">
              Loading…
            </p>
          ) : feedback?.kind === 'error' && versions.length === 0 ? null : deleted.length === 0 ? (
            <p className="text-sm text-pf-deep/50">No deleted content in loaded history.</p>
          ) : (
            deleted.map((version) => (
              <div
                key={version.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-pf-light p-4"
              >
                <div>
                  <p className="font-medium text-pf-deep">{labelFor(version)}</p>
                  <p className="mt-1 text-xs text-pf-deep/50">
                    {version.entityType === 'PLACE' ? 'Guide item' : 'Knowledge entry'} · deleted{' '}
                    {version.createdAt.toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={pending !== null || requiresReload}
                  onClick={() => void restore(version)}
                  className="inline-flex min-h-9 items-center rounded-full bg-pf-primary px-4 text-sm font-medium text-white disabled:opacity-50"
                >
                  {restoringId === version.id ? 'Restoring…' : 'Restore'}
                </button>
              </div>
            ))
          )}
          {hasMore && versions.length > 0 ? (
            <button
              type="button"
              disabled={pending !== null || requiresReload}
              onClick={() => void load(versions.at(-1)!.sequence)}
              className="inline-flex min-h-9 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary disabled:opacity-50"
            >
              {isLoading ? 'Loading…' : 'Load older history'}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
