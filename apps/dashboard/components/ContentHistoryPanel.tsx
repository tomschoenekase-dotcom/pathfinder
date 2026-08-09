'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../lib/trpc'
import { changedSnapshotFields } from '../lib/content-history-diff'

type EntityType = 'VENUE' | 'PLACE' | 'KNOWLEDGE_ENTRY' | 'OPERATIONAL_UPDATE'
type ContentVersion = {
  id: string
  sequence: bigint
  operation: string
  beforeState: unknown
  afterState: unknown
  actorId: string | null
  revertedFromId: string | null
  createdAt: Date
}

function displayValue(value: unknown): string {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function getErrorMessage(error: unknown): string {
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

function mergeVersions(current: ContentVersion[], incoming: ContentVersion[]) {
  const incomingIds = new Set(incoming.map((version) => version.id))
  return [...incoming, ...current.filter((version) => !incomingIds.has(version.id))]
}

function appendVersions(current: ContentVersion[], incoming: ContentVersion[]) {
  const currentIds = new Set(current.map((version) => version.id))
  return [...current, ...incoming.filter((version) => !currentIds.has(version.id))]
}

export function ContentHistoryPanel({
  entityType,
  entityId,
  title = 'Version history',
}: {
  entityType: EntityType
  entityId: string
  title?: string
}) {
  const router = useRouter()
  const client = useTRPCClient()
  const [isOpen, setIsOpen] = useState(false)
  const [versions, setVersions] = useState<ContentVersion[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [requiresReload, setRequiresReload] = useState(false)
  const mounted = useRef(false)
  const scopeGeneration = useRef(0)
  const actionSequence = useRef(0)
  const activeAction = useRef<number | null>(null)

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
    setIsOpen(false)
    setVersions([])
    setHasMore(false)
    setPending(null)
    setFeedback(null)
    setRequiresReload(false)
  }, [entityId, entityType])

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

  async function loadHistory(beforeSequence?: bigint) {
    const action = startAction({ kind: 'load' })
    if (!action) return
    setFeedback(null)
    try {
      const result = await client.contentHistory.list.query({
        entityType,
        entityId,
        limit: 50,
        ...(beforeSequence !== undefined ? { beforeSequence } : {}),
      })
      if (!isCurrentAction(action)) return
      setVersions((current) =>
        beforeSequence === undefined ? result : appendVersions(current, result),
      )
      setHasMore(result.length === 50)
      setRequiresReload(false)
    } catch (loadError) {
      if (!isCurrentAction(action)) return
      setFeedback({ kind: 'error', text: getErrorMessage(loadError) })
    } finally {
      finishAction(action)
    }
  }

  function toggleOpen() {
    if (activeAction.current !== null) return
    const nextOpen = !isOpen
    setIsOpen(nextOpen)
    if (nextOpen) void loadHistory()
  }

  async function revert(version: ContentVersion) {
    const current = versions[0]
    if (!current) return
    const action = startAction({ kind: 'restore', versionId: version.id })
    if (!action) return
    const confirmed = window.confirm(
      version.afterState === null
        ? 'Revert to this deletion? The current item will be removed and the action will be recorded.'
        : 'Restore this exact historical state? The current state will remain available in history.',
    )
    if (!confirmed) {
      finishAction(action)
      return
    }

    setFeedback(null)
    try {
      const applied = await client.contentHistory.revert.mutate({
        versionId: version.id,
        expectedCurrentVersionId: current.id,
      })
      if (!isCurrentAction(action)) return
      setVersions((loaded) => mergeVersions(loaded, [applied]))
      router.refresh()
      try {
        const result = await client.contentHistory.list.query({ entityType, entityId, limit: 50 })
        if (!isCurrentAction(action)) return
        setVersions(result)
        setHasMore(result.length === 50)
        setRequiresReload(false)
        setFeedback({ kind: 'success', text: 'Historical state restored.' })
      } catch {
        if (!isCurrentAction(action)) return
        setRequiresReload(true)
        setFeedback({
          kind: 'error',
          text: 'The historical state was restored, but history could not be refreshed. Do not repeat the restore; reload the page.',
        })
      }
    } catch (revertError) {
      if (!isCurrentAction(action)) return
      setRequiresReload(true)
      setFeedback({
        kind: 'error',
        text:
          errorCode(revertError) === 'CONFLICT'
            ? 'Content changed after this history view was loaded. Reloading authoritative state; review it before retrying.'
            : 'The restore outcome could not be confirmed. Reloading authoritative state; review history before retrying.',
      })
      router.refresh()
    } finally {
      finishAction(action)
    }
  }

  const isLoading = pending?.kind === 'load'
  const revertingId = pending?.kind === 'restore' ? pending.versionId : null

  return (
    <section
      className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm"
      aria-busy={pending !== null}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">{title}</h2>
          <p className="mt-1 text-sm text-pf-deep/60">
            Review exact changes or restore a prior state.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void toggleOpen()}
          disabled={pending !== null}
          aria-expanded={isOpen}
          className="inline-flex min-h-10 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
        >
          {isOpen ? 'Hide history' : 'Show history'}
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
              onClick={() => void loadHistory()}
              className="inline-flex min-h-9 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary"
            >
              Reload history
            </button>
          ) : null}
          {isLoading && versions.length > 0 ? (
            <p className="text-sm text-pf-deep/50" role="status">
              Refreshing history…
            </p>
          ) : null}
          {isLoading && versions.length === 0 ? (
            <p className="text-sm text-pf-deep/50" role="status">
              Loading history…
            </p>
          ) : feedback?.kind === 'error' && versions.length === 0 ? null : versions.length === 0 ? (
            <p className="text-sm text-pf-deep/50">No recorded versions yet.</p>
          ) : (
            versions.map((version, index) => {
              const changes = changedSnapshotFields(version.beforeState, version.afterState)
              return (
                <details key={version.id} className="rounded-2xl border border-pf-light p-4">
                  <summary className="cursor-pointer list-none marker:hidden">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-pf-deep">
                          {version.revertedFromId ? 'REVERT' : version.operation} · revision{' '}
                          {version.sequence.toString()}
                        </p>
                        <p className="mt-1 text-xs text-pf-deep/50">
                          {version.createdAt.toLocaleString()} · {version.actorId ?? 'system'}
                        </p>
                      </div>
                      {index === 0 ? (
                        <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                          Current
                        </span>
                      ) : null}
                    </div>
                  </summary>
                  {index !== 0 ? (
                    <button
                      type="button"
                      disabled={pending !== null || requiresReload}
                      onClick={() => void revert(version)}
                      className="mt-4 inline-flex min-h-9 items-center rounded-full bg-pf-primary px-4 text-xs font-semibold text-white transition hover:bg-pf-accent disabled:opacity-50"
                    >
                      {revertingId === version.id ? 'Restoring…' : 'Restore this state'}
                    </button>
                  ) : null}
                  <div className="mt-4 overflow-x-auto">
                    {changes.length === 0 ? (
                      <p className="text-sm text-pf-deep/50">No field-level changes.</p>
                    ) : (
                      <table className="min-w-full table-fixed text-left text-xs">
                        <thead className="text-pf-deep/50">
                          <tr>
                            <th className="w-1/5 px-2 py-2 font-medium">Field</th>
                            <th className="w-2/5 px-2 py-2 font-medium">Before</th>
                            <th className="w-2/5 px-2 py-2 font-medium">After</th>
                          </tr>
                        </thead>
                        <tbody>
                          {changes.map((change) => (
                            <tr key={change.key} className="border-t border-pf-light align-top">
                              <td className="px-2 py-3 font-mono text-pf-deep">{change.key}</td>
                              <td className="px-2 py-3">
                                <pre className="max-h-48 whitespace-pre-wrap break-words text-rose-700">
                                  {displayValue(change.before)}
                                </pre>
                              </td>
                              <td className="px-2 py-3">
                                <pre className="max-h-48 whitespace-pre-wrap break-words text-emerald-700">
                                  {displayValue(change.after)}
                                </pre>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </details>
              )
            })
          )}
          {hasMore && versions.length > 0 ? (
            <button
              type="button"
              disabled={pending !== null || requiresReload}
              onClick={() => void loadHistory(versions.at(-1)!.sequence)}
              className="inline-flex min-h-9 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary disabled:opacity-50"
            >
              {isLoading ? 'Loading…' : 'Load older versions'}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
