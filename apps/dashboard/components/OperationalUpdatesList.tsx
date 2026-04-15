'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowRight, Ban, Info, Plus } from 'lucide-react'

import { createTRPCClient } from '../lib/trpc'

type OperationalUpdateItem = {
  id: string
  venueId: string
  placeId: string | null
  severity: 'INFO' | 'WARNING' | 'CLOSURE' | 'REDIRECT'
  title: string
  body: string | null
  redirectTo: string | null
  expiresAt: string
  isActive: boolean
  createdAt: string
  venue: {
    id: string
    name: string
  }
  place: {
    id: string
    name: string
  } | null
}

type OperationalUpdatesListProps = {
  initialUpdates: OperationalUpdateItem[]
}

const severityConfig = {
  INFO: {
    badge: 'bg-sky-50 text-sky-700 border-sky-200',
    icon: Info,
    label: 'Info',
  },
  WARNING: {
    badge: 'bg-amber-50 text-amber-700 border-amber-200',
    icon: AlertTriangle,
    label: 'Warning',
  },
  CLOSURE: {
    badge: 'bg-rose-50 text-rose-700 border-rose-200',
    icon: Ban,
    label: 'Closure',
  },
  REDIRECT: {
    badge: 'bg-violet-50 text-violet-700 border-violet-200',
    icon: ArrowRight,
    label: 'Redirect',
  },
} as const

function formatTimeRemaining(expiresAt: Date, now: number) {
  const remainingMs = expiresAt.getTime() - now

  if (remainingMs <= 0) {
    return 'Expired'
  }

  const totalMinutes = Math.ceil(remainingMs / 60000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) {
    return `${days}d ${hours}h remaining`
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m remaining`
  }

  return `${minutes}m remaining`
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

export function OperationalUpdatesList({ initialUpdates }: OperationalUpdatesListProps) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }
  const client = clientRef.current

  const [updates, setUpdates] = useState(initialUpdates)
  const [now, setNow] = useState(Date.now())
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 30000)

    return () => {
      window.clearInterval(timer)
    }
  }, [])

  const visibleUpdates = useMemo(
    () => updates.filter((update) => update.isActive && new Date(update.expiresAt).getTime() > now),
    [now, updates],
  )
  const pastUpdates = useMemo(
    () =>
      updates.filter((update) => !update.isActive || new Date(update.expiresAt).getTime() <= now),
    [now, updates],
  )

  async function handleDeactivate(id: string) {
    setPendingId(id)
    setActionError(null)

    try {
      await client.operationalUpdate.deactivate.mutate({ id })
      setUpdates((current) =>
        current.map((update) => (update.id === id ? { ...update, isActive: false } : update)),
      )
      router.refresh()
    } catch (error) {
      setActionError(getErrorMessage(error))
    } finally {
      setPendingId(null)
    }
  }

  return (
    <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700">
            Operational Updates
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Active Alerts
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Publish short-lived venue notices that staff can deactivate the moment conditions
            change.
          </p>
        </div>
        <Link
          href="/operational-updates/new"
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>Create Alert</span>
        </Link>
      </div>

      {actionError ? (
        <p className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {actionError}
        </p>
      ) : null}

      {visibleUpdates.length === 0 ? (
        <div className="mt-8 rounded-[1.75rem] border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
          <p className="text-lg font-semibold text-slate-950">No active alerts</p>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            The guest experience is currently running without operational notices.
          </p>
        </div>
      ) : (
        <div className="mt-8 space-y-4">
          {visibleUpdates.map((update) => {
            const config = severityConfig[update.severity]
            const Icon = config.icon

            return (
              <article
                key={update.id}
                className="rounded-[1.75rem] border border-slate-200 bg-slate-50 p-5"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 space-y-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${config.badge}`}
                      >
                        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                        {config.label}
                      </span>
                      <span className="text-sm text-slate-500">{update.venue.name}</span>
                      {update.place ? (
                        <span className="text-sm text-slate-500">• {update.place.name}</span>
                      ) : null}
                    </div>

                    <div>
                      <h2 className="text-xl font-semibold text-slate-950">{update.title}</h2>
                      {update.body ? (
                        <p className="mt-2 text-sm leading-6 text-slate-600">{update.body}</p>
                      ) : null}
                      {update.redirectTo ? (
                        <p className="mt-2 text-sm text-slate-600">
                          Redirect target:{' '}
                          <span className="font-medium text-slate-900">{update.redirectTo}</span>
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 lg:items-end">
                    <div className="text-sm text-slate-600">
                      <p className="font-medium text-slate-900">
                        {formatTimeRemaining(new Date(update.expiresAt), now)}
                      </p>
                      <p>Expires {new Date(update.expiresAt).toLocaleString()}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        void handleDeactivate(update.id)
                      }}
                      disabled={pendingId === update.id}
                      className="inline-flex min-h-11 items-center justify-center rounded-full border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {pendingId === update.id ? 'Deactivating...' : 'Deactivate'}
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {pastUpdates.length > 0 ? (
        <details className="mt-8 group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-[1.75rem] border border-slate-200 bg-slate-50 px-5 py-4">
            <span className="text-sm font-medium text-slate-700">
              Past alerts ({pastUpdates.length})
            </span>
            <span className="text-xs text-slate-400 group-open:hidden">Show</span>
            <span className="hidden text-xs text-slate-400 group-open:inline">Hide</span>
          </summary>
          <div className="mt-3 space-y-3">
            {pastUpdates.map((update) => {
              const config = severityConfig[update.severity]
              const Icon = config.icon

              return (
                <article
                  key={update.id}
                  className="rounded-[1.75rem] border border-slate-200 bg-white p-5 opacity-60"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span
                      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${config.badge}`}
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      {config.label}
                    </span>
                    <span className="text-sm text-slate-500">{update.venue.name}</span>
                  </div>
                  <p className="mt-3 text-sm font-medium text-slate-700">{update.title}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Expired {new Date(update.expiresAt).toLocaleString()}
                  </p>
                </article>
              )
            })}
          </div>
        </details>
      ) : null}
    </section>
  )
}
