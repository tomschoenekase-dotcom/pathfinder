'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'

import { useTRPCClient } from '../lib/trpc'
import { ContentHistoryPanel } from './ContentHistoryPanel'

type OperationalUpdateItem = {
  id: string
  venueId: string
  placeId: string | null
  updateType: string
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
  status: 'DRAFT' | 'PUBLISHED'
  title: string
  body: string | null
  redirectTo: string | null
  startsAt: string
  expiresAt: string
  isActive: boolean
  createdBy: string
  publishedBy: string | null
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  venue: { id: string; name: string }
  place: { id: string; name: string } | null
}

type Props = { initialUpdates: OperationalUpdateItem[] }
type Section = 'Draft' | 'Scheduled' | 'Current' | 'Past'

const sectionOrder: Section[] = ['Draft', 'Scheduled', 'Current', 'Past']
const priorityClass = {
  LOW: 'border-slate-200 bg-slate-50 text-slate-600',
  NORMAL: 'border-pf-light bg-pf-surface text-pf-primary',
  HIGH: 'border-amber-200 bg-amber-50 text-amber-700',
  URGENT: 'border-rose-200 bg-rose-50 text-rose-700',
} as const

function sectionFor(update: OperationalUpdateItem, now: number): Section {
  if (update.status === 'DRAFT') return 'Draft'
  if (!update.isActive || new Date(update.expiresAt).getTime() <= now) return 'Past'
  if (new Date(update.startsAt).getTime() > now) return 'Scheduled'
  return 'Current'
}

function labelType(value: string) {
  return value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (character) => character.toUpperCase())
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : 'The update could not be changed. Please try again.'
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

function mutationErrorMessage(error: unknown, listRefreshed: boolean) {
  if (errorCode(error) === 'CONFLICT') {
    return listRefreshed
      ? 'This operational update changed in another session. The list was refreshed; review the current version and try again.'
      : 'This operational update changed in another session, and the current list could not be refreshed. Reload the page before trying again.'
  }

  const message = errorMessage(error)
  if (/conflict|changed|stale/i.test(message)) {
    return listRefreshed
      ? `${message} The list was refreshed; review the current version and try again.`
      : `${message} The current list could not be refreshed. Reload the page before trying again.`
  }
  return listRefreshed
    ? message
    : `${message} The action status and current list could not be confirmed. Reload the page before trying again.`
}

function serializeUpdate(
  row: {
    startsAt: Date
    expiresAt: Date
    publishedAt: Date | null
    createdAt: Date
    updatedAt: Date
  } & Omit<
    OperationalUpdateItem,
    'startsAt' | 'expiresAt' | 'publishedAt' | 'createdAt' | 'updatedAt'
  >,
): OperationalUpdateItem {
  return {
    ...row,
    startsAt: row.startsAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function OperationalUpdatesList({ initialUpdates }: Props) {
  const router = useRouter()
  const client = useTRPCClient()
  const [updates, setUpdates] = useState(initialUpdates)
  const [now, setNow] = useState(Date.now())
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const isMountedRef = useRef(true)
  const mutationInFlightRef = useRef(false)

  useEffect(() => setUpdates(initialUpdates), [initialUpdates])
  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
      mutationInFlightRef.current = false
    }
  }, [])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  async function refreshUpdates() {
    const rows = await client.operationalUpdate.list.query()
    if (!isMountedRef.current) return
    setUpdates(rows.map((row) => serializeUpdate(row)))
    router.refresh()
  }

  async function mutate(id: string, action: 'publish' | 'deactivate') {
    if (mutationInFlightRef.current) return
    const update = updates.find((candidate) => candidate.id === id)
    if (!update) return
    mutationInFlightRef.current = true
    setPendingId(id)
    setActionError(null)
    try {
      try {
        await client.operationalUpdate[action].mutate({
          id,
          expectedUpdatedAt: new Date(update.updatedAt),
        })
      } catch (mutationError) {
        if (!isMountedRef.current) return
        let listRefreshed = false
        try {
          await refreshUpdates()
          listRefreshed = isMountedRef.current
        } catch {
          // Preserve the actionable mutation error when the recovery query is also unavailable.
        }
        if (isMountedRef.current) {
          setActionError(mutationErrorMessage(mutationError, listRefreshed))
        }
        return
      }

      if (!isMountedRef.current) return
      try {
        await refreshUpdates()
      } catch {
        if (isMountedRef.current) {
          setActionError(
            'The action succeeded, but the current list could not be refreshed. Reload the page to see the confirmed state; do not repeat the action.',
          )
        }
      }
    } finally {
      mutationInFlightRef.current = false
      if (isMountedRef.current) setPendingId(null)
    }
  }

  const grouped = Object.fromEntries(
    sectionOrder.map((section) => [
      section,
      updates.filter((update) => sectionFor(update, now) === section),
    ]),
  ) as Record<Section, OperationalUpdateItem[]>

  return (
    <section
      aria-busy={pendingId !== null}
      className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
            Operational updates
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-pf-deep">
            Guest-facing notices
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/60">
            Draft, schedule, publish, and retire time-sensitive venue guidance.
          </p>
        </div>
        <Link
          href="/operational-updates/new"
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> New update
        </Link>
      </div>

      {actionError ? (
        <p
          role="alert"
          className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
        >
          {actionError}
        </p>
      ) : null}

      <div className="mt-8 space-y-8">
        {sectionOrder.map((section) => (
          <section key={section} aria-labelledby={`updates-${section.toLowerCase()}`}>
            <div className="flex items-center justify-between gap-3">
              <h2
                id={`updates-${section.toLowerCase()}`}
                className="text-xl font-semibold text-pf-deep"
              >
                {section}
              </h2>
              <span className="rounded-full bg-pf-surface px-3 py-1 text-xs font-semibold text-pf-deep/60">
                {grouped[section].length}
              </span>
            </div>
            {grouped[section].length === 0 ? (
              <p className="mt-3 rounded-2xl border border-dashed border-pf-light bg-pf-surface px-5 py-6 text-sm text-pf-deep/50">
                No {section.toLowerCase()} updates.
              </p>
            ) : (
              <div className="mt-3 space-y-4">
                {grouped[section].map((update) => (
                  <article
                    key={update.id}
                    className="rounded-[1.75rem] border border-pf-light bg-pf-surface p-5"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 space-y-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span
                            className={`rounded-full border px-3 py-1 font-semibold uppercase tracking-wide ${priorityClass[update.priority]}`}
                          >
                            {update.priority}
                          </span>
                          <span className="rounded-full border border-pf-light bg-white px-3 py-1 font-medium text-pf-deep/60">
                            {labelType(update.updateType)}
                          </span>
                          <span className="text-pf-deep/50">
                            {update.venue.name}
                            {update.place ? ` · ${update.place.name}` : ' · Entire venue'}
                          </span>
                        </div>
                        <div>
                          <h3 className="text-lg font-semibold text-pf-deep">{update.title}</h3>
                          {update.body ? (
                            <p className="mt-1 text-sm leading-6 text-pf-deep/60">{update.body}</p>
                          ) : null}
                        </div>
                        <div className="text-xs leading-5 text-pf-deep/50">
                          <p>
                            Starts {new Date(update.startsAt).toLocaleString()} · Expires{' '}
                            {new Date(update.expiresAt).toLocaleString()}
                          </p>
                          <p>
                            Created by {update.createdBy}
                            {update.publishedBy ? ` · Published by ${update.publishedBy}` : ''} ·
                            Updated {new Date(update.updatedAt).toLocaleString()}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 lg:justify-end">
                        {section === 'Draft' ? (
                          <Link
                            href={`/operational-updates/${update.id}/edit`}
                            className="inline-flex min-h-10 items-center rounded-full border border-pf-light bg-white px-4 text-sm font-medium text-pf-primary"
                          >
                            Edit
                          </Link>
                        ) : null}
                        {section === 'Draft' ? (
                          <button
                            type="button"
                            disabled={pendingId !== null}
                            onClick={() => void mutate(update.id, 'publish')}
                            className="inline-flex min-h-10 items-center rounded-full bg-pf-primary px-4 text-sm font-medium text-white disabled:opacity-50"
                          >
                            {pendingId === update.id ? 'Publishing...' : 'Publish'}
                          </button>
                        ) : null}
                        {section === 'Scheduled' || section === 'Current' ? (
                          <button
                            type="button"
                            disabled={pendingId !== null}
                            onClick={() => void mutate(update.id, 'deactivate')}
                            className="inline-flex min-h-10 items-center rounded-full border border-pf-light bg-white px-4 text-sm font-medium text-pf-primary disabled:opacity-50"
                          >
                            {pendingId === update.id ? 'Deactivating...' : 'Deactivate'}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-4">
                      <ContentHistoryPanel
                        entityType="OPERATIONAL_UPDATE"
                        entityId={update.id}
                        title="Update history"
                      />
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </section>
  )
}
