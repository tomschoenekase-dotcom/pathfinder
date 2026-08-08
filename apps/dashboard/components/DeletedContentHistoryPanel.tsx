'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { createTRPCClient } from '../lib/trpc'
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

export function DeletedContentHistoryPanel({ venueId }: { venueId: string }) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) clientRef.current = createTRPCClient()
  const client = clientRef.current
  const [versions, setVersions] = useState<VenueVersion[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const deleted = currentDeletedVersions(versions).filter(
    (version) => version.entityType !== 'VENUE',
  )

  async function load(beforeSequence?: bigint) {
    setIsLoading(true)
    setError(null)
    try {
      const result = await client.contentHistory.listForVenue.query({
        venueId,
        limit: 100,
        ...(beforeSequence !== undefined ? { beforeSequence } : {}),
      })
      setVersions((current) => (beforeSequence === undefined ? result : [...current, ...result]))
      setHasMore(result.length === 100)
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setIsLoading(false)
    }
  }

  async function restore(version: VenueVersion) {
    if (!window.confirm(`Restore deleted ${labelFor(version)}?`)) return
    setRestoringId(version.id)
    setError(null)
    try {
      await client.contentHistory.revert.mutate({
        versionId: version.id,
        expectedCurrentVersionId: version.id,
        snapshotSide: 'BEFORE',
      })
      await load()
      router.refresh()
    } catch (restoreError) {
      setError(errorMessage(restoreError))
    } finally {
      setRestoringId(null)
    }
  }

  return (
    <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Deleted content</h2>
          <p className="mt-1 text-sm text-pf-deep/60">
            Find and restore deleted guide items or knowledge entries.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
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
          {error ? (
            <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>
          ) : null}
          {isLoading && versions.length === 0 ? (
            <p className="text-sm text-pf-deep/50">Loading…</p>
          ) : deleted.length === 0 ? (
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
                  disabled={restoringId !== null}
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
              disabled={isLoading}
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
