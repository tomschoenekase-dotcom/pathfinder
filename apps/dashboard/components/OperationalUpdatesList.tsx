'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'

import { computeOperationalUpdateLifecycle } from '@pathfinder/contracts/operational-update-lifecycle'

import { runBoundedClientRequest } from '../lib/bounded-client-request'
import { useTRPCClient } from '../lib/trpc'
import { ContentHistoryPanel } from './ContentHistoryPanel'

const UPDATE_LIST_REFRESH_TIMEOUT_MS = 15_000

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
  NORMAL: 'border-tk-rule bg-white text-tk-ink',
  HIGH: 'border-amber-200 bg-amber-50 text-amber-700',
  URGENT: 'border-rose-200 bg-rose-50 text-rose-700',
} as const

// The shared lifecycle (never raw isActive) decides the section and the badge, recomputed against
// the ticking clock so a notice that expires while the page is open leaves "Current".
function lifecycleFor(update: OperationalUpdateItem, now: number) {
  return computeOperationalUpdateLifecycle(update, now)
}

function sectionFor(update: OperationalUpdateItem, now: number): Section {
  switch (lifecycleFor(update, now).lifecycle) {
    case 'DRAFT':
      return 'Draft'
    case 'SCHEDULED':
      return 'Scheduled'
    case 'LIVE':
      return 'Current'
    default:
      return 'Past'
  }
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
  const refreshControllerRef = useRef<AbortController | null>(null)

  useEffect(() => setUpdates(initialUpdates), [initialUpdates])
  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
      mutationInFlightRef.current = false
      refreshControllerRef.current?.abort()
      refreshControllerRef.current = null
    }
  }, [])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  async function refreshUpdates() {
    refreshControllerRef.current?.abort()
    const controller = new AbortController()
    refreshControllerRef.current = controller
    try {
      const rows = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: UPDATE_LIST_REFRESH_TIMEOUT_MS,
        request: (signal) => client.operationalUpdate.list.query(undefined, { signal }),
      })
      if (!isMountedRef.current) return
      setUpdates(rows.map((row) => serializeUpdate(row)))
      router.refresh()
    } finally {
      if (refreshControllerRef.current === controller) refreshControllerRef.current = null
    }
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
    <section aria-busy={pendingId !== null} className="text-tk-ink">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-portal text-[2rem] leading-[1.1] sm:text-[2.6rem]">Updates</h1>
          <p className="mt-2 max-w-2xl text-[0.95rem] leading-6 text-tk-soft">
            Short-term notices your visitors see in the guide, like a closure, an event or a parking
            change. To send Torchiko something privately, use Send us information on Home.
          </p>
        </div>
        <Link
          href="/operational-updates/new"
          className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg bg-tk-ink px-4 text-sm font-semibold text-white hover:bg-tk-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus focus-visible:ring-offset-2"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> New notice
        </Link>
      </div>

      {actionError ? (
        <p
          role="alert"
          className="mt-6 rounded-lg border border-tk-danger/40 bg-[#FBEFEF] px-4 py-3 text-sm text-tk-danger"
        >
          {actionError}
        </p>
      ) : null}

      <div className="mt-8 space-y-9">
        {sectionOrder.map((section) => (
          <section key={section} aria-labelledby={`updates-${section.toLowerCase()}`}>
            <div className="flex items-center justify-between gap-3">
              <h2
                id={`updates-${section.toLowerCase()}`}
                className="font-portal text-[1.3rem] leading-tight"
              >
                {section}
              </h2>
              <span className="text-sm text-tk-soft">{grouped[section].length}</span>
            </div>
            {grouped[section].length === 0 ? (
              <p className="mt-2 text-sm text-tk-soft">No {section.toLowerCase()} notices.</p>
            ) : (
              <div className="mt-3 space-y-4">
                {grouped[section].map((update) => (
                  <article
                    key={update.id}
                    className="rounded-xl border border-tk-rule bg-tk-card p-5"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 space-y-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span
                            className={`rounded-md border px-2 py-0.5 font-semibold ${priorityClass[update.priority]}`}
                          >
                            {update.priority.charAt(0) + update.priority.slice(1).toLowerCase()}{' '}
                            priority
                          </span>
                          <span className="rounded-md border border-tk-rule bg-white px-2 py-0.5 font-medium text-tk-soft">
                            {labelType(update.updateType)}
                          </span>
                          {(() => {
                            const state = lifecycleFor(update, now)
                            return (
                              <span
                                data-lifecycle={state.lifecycle}
                                className={`rounded-md border px-2 py-0.5 font-semibold ${
                                  state.isActiveButExpired
                                    ? 'border-amber-300 bg-amber-50 text-amber-800'
                                    : 'border-tk-rule bg-white text-tk-ink'
                                }`}
                              >
                                {state.label}
                              </span>
                            )
                          })()}
                          <span className="text-tk-soft">
                            {update.venue.name}
                            {update.place ? ` · ${update.place.name}` : ' · Entire venue'}
                          </span>
                        </div>
                        <div>
                          <h3 className="text-lg font-semibold">{update.title}</h3>
                          {update.body ? (
                            <p className="mt-1 text-sm leading-6 text-tk-soft">{update.body}</p>
                          ) : null}
                        </div>
                        <div className="text-xs leading-5 text-tk-soft">
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
                            className="inline-flex min-h-11 items-center rounded-lg border border-tk-rule-strong bg-white px-4 text-sm font-semibold text-tk-ink hover:border-tk-ink"
                          >
                            Edit
                          </Link>
                        ) : null}
                        {section === 'Draft' ? (
                          <button
                            type="button"
                            disabled={pendingId !== null}
                            onClick={() => void mutate(update.id, 'publish')}
                            className="inline-flex min-h-11 items-center rounded-lg bg-tk-ink px-4 text-sm font-semibold text-white hover:bg-tk-focus disabled:opacity-50"
                          >
                            {pendingId === update.id ? 'Publishing...' : 'Publish'}
                          </button>
                        ) : null}
                        {section === 'Scheduled' ||
                        section === 'Current' ||
                        (section === 'Past' && update.status === 'PUBLISHED' && update.isActive) ? (
                          <button
                            type="button"
                            disabled={pendingId !== null}
                            onClick={() => void mutate(update.id, 'deactivate')}
                            className="inline-flex min-h-11 items-center rounded-lg border border-tk-rule-strong bg-white px-4 text-sm font-semibold text-tk-ink hover:border-tk-ink disabled:opacity-50"
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
                        title="History"
                        variant="inline"
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
