'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { createTRPCClient } from '../lib/trpc'
import { changedSnapshotFields } from '../lib/content-history-diff'

type EntityType = 'VENUE' | 'PLACE' | 'KNOWLEDGE_ENTRY'
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
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) clientRef.current = createTRPCClient()
  const client = clientRef.current
  const [isOpen, setIsOpen] = useState(false)
  const [versions, setVersions] = useState<ContentVersion[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [revertingId, setRevertingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function loadHistory(beforeSequence?: bigint) {
    setIsLoading(true)
    setError(null)
    try {
      const result = await client.contentHistory.list.query({
        entityType,
        entityId,
        limit: 50,
        ...(beforeSequence !== undefined ? { beforeSequence } : {}),
      })
      setVersions((current) => (beforeSequence === undefined ? result : [...current, ...result]))
      setHasMore(result.length === 50)
    } catch (loadError) {
      setError(getErrorMessage(loadError))
    } finally {
      setIsLoading(false)
    }
  }

  async function toggleOpen() {
    const nextOpen = !isOpen
    setIsOpen(nextOpen)
    if (nextOpen) await loadHistory()
  }

  async function revert(version: ContentVersion) {
    const current = versions[0]
    if (!current) return
    const confirmed = window.confirm(
      version.afterState === null
        ? 'Revert to this deletion? The current item will be removed and the action will be recorded.'
        : 'Restore this exact historical state? The current state will remain available in history.',
    )
    if (!confirmed) return

    setRevertingId(version.id)
    setError(null)
    try {
      await client.contentHistory.revert.mutate({
        versionId: version.id,
        expectedCurrentVersionId: current.id,
      })
      await loadHistory()
      router.refresh()
    } catch (revertError) {
      setError(getErrorMessage(revertError))
    } finally {
      setRevertingId(null)
    }
  }

  return (
    <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
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
          className="inline-flex min-h-10 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
        >
          {isOpen ? 'Hide history' : 'Show history'}
        </button>
      </div>

      {isOpen ? (
        <div className="mt-5 space-y-3">
          {error ? (
            <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>
          ) : null}
          {isLoading && versions.length === 0 ? (
            <p className="text-sm text-pf-deep/50">Loading history…</p>
          ) : versions.length === 0 ? (
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
                      ) : (
                        <button
                          type="button"
                          disabled={revertingId !== null}
                          onClick={(event) => {
                            event.preventDefault()
                            void revert(version)
                          }}
                          className="inline-flex min-h-9 items-center rounded-full bg-pf-primary px-4 text-xs font-semibold text-white transition hover:bg-pf-accent disabled:opacity-50"
                        >
                          {revertingId === version.id ? 'Restoring…' : 'Restore this state'}
                        </button>
                      )}
                    </div>
                  </summary>
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
              disabled={isLoading}
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
