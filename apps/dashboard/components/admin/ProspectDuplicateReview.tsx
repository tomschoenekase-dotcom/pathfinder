'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, ScanSearch } from 'lucide-react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const DUPLICATE_QUEUE_TIMEOUT_MS = 15_000

type Candidate = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['listProspectDuplicates']['query']>
>[number]

export function ProspectDuplicateReview() {
  const client = useTRPCClient()
  const [items, setItems] = useState<Candidate[]>([])
  const [busy, setBusy] = useState(false)
  const [readBusy, setReadBusy] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [message, setMessage] = useState('Loading duplicate review queue…')
  const requestSequence = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  const mounted = useRef(false)

  async function refresh(successPrefix?: string) {
    const sequence = ++requestSequence.current
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setReadBusy(true)
    setReadFailed(false)
    if (!successPrefix) setMessage('Loading duplicate review queue…')
    try {
      const rows = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: DUPLICATE_QUEUE_TIMEOUT_MS,
        request: (signal) =>
          client.admin.listProspectDuplicates.query({ status: 'OPEN', limit: 200 }, { signal }),
      })
      if (!mounted.current || requestSequence.current !== sequence) return false
      setItems(rows)
      setLoaded(true)
      setMessage(
        [
          successPrefix,
          rows.length
            ? `${rows.length} conservative candidates need review.`
            : 'No open duplicate candidates.',
        ]
          .filter(Boolean)
          .join(' '),
      )
      return true
    } catch {
      if (!mounted.current || requestSequence.current !== sequence) return false
      setReadFailed(true)
      setMessage(
        successPrefix
          ? `${successPrefix} The review queue could not be reloaded in time. Retry the queue read when ready.`
          : 'The duplicate review queue could not be loaded in time. Retry when ready.',
      )
      return false
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null
      if (mounted.current && requestSequence.current === sequence) setReadBusy(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      requestSequence.current += 1
      activeRequest.current?.abort()
      activeRequest.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function scan() {
    setBusy(true)
    setMessage('Scanning exact names, domains, venue names, and contact emails…')
    try {
      const result = await client.admin.scanProspectDuplicates.mutate({ prospectLimit: 20_000 })
      if (!mounted.current) return
      await refresh(
        `Scanned ${result.organizationsScanned.toLocaleString()} prospects; created ${result.candidatesCreated.toLocaleString()} review candidates.`,
      )
    } catch {
      if (mounted.current)
        setMessage('The duplicate scan outcome could not be confirmed. Retry when ready.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function resolve(
    candidateId: string,
    resolution: 'CONFIRMED_DUPLICATE' | 'CONFIRMED_DISTINCT' | 'DISMISSED',
  ) {
    const note = window.prompt(
      resolution === 'CONFIRMED_DUPLICATE'
        ? 'Record why these are duplicates. No records will be merged.'
        : 'Record the review evidence.',
    )
    if (!note?.trim()) return
    setBusy(true)
    try {
      await client.admin.resolveProspectDuplicate.mutate({
        candidateId,
        resolution,
        note: note.trim(),
      })
      if (!mounted.current) return
      await refresh('Review recorded.')
    } catch {
      if (mounted.current) setMessage('The review outcome could not be confirmed. Retry unchanged.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-700">
            Conservative matching
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
            Duplicate review
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Review evidence without destructive automatic merges. Confirming a duplicate records a
            decision; it does not delete either prospect.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void scan()}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}{' '}
          Scan prospects
        </button>
      </div>
      <p
        role={readFailed ? 'alert' : 'status'}
        className={`rounded-xl border bg-white px-4 py-3 text-sm ${readFailed ? 'border-rose-200 text-rose-700' : 'border-slate-200 text-slate-600'}`}
      >
        {message}
      </p>
      <button
        type="button"
        disabled={busy || readBusy}
        onClick={() => void refresh()}
        className="min-h-10 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-sky-700 disabled:opacity-50"
      >
        {readBusy ? 'Refreshing queue…' : 'Refresh queue'}
      </button>
      {loaded && !items.length ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <ScanSearch className="mx-auto h-8 w-8 text-slate-300" />
          <p className="mt-3 font-semibold text-slate-900">The review queue is clear</p>
          <p className="mt-1 text-sm text-slate-500">
            Run a scan after imports or manual research additions.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <article
              key={item.id}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-amber-700">
                    <AlertTriangle className="h-4 w-4" />
                    <span className="text-xs font-bold uppercase tracking-wider">
                      {Math.round(item.confidence * 100)}% match
                    </span>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Link
                      href={`/admin/prospects/${item.organizationA.id}`}
                      className="rounded-xl border border-slate-200 p-3 hover:border-sky-300"
                    >
                      <p className="font-semibold text-slate-900">
                        {item.organizationA.canonicalName}
                      </p>
                      <p className="mt-1 truncate text-xs text-slate-500">
                        {item.organizationA.website ?? 'No website'}
                      </p>
                    </Link>
                    <Link
                      href={`/admin/prospects/${item.organizationB.id}`}
                      className="rounded-xl border border-slate-200 p-3 hover:border-sky-300"
                    >
                      <p className="font-semibold text-slate-900">
                        {item.organizationB.canonicalName}
                      </p>
                      <p className="mt-1 truncate text-xs text-slate-500">
                        {item.organizationB.website ?? 'No website'}
                      </p>
                    </Link>
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    Signals:{' '}
                    {Array.isArray(item.reasons)
                      ? item.reasons.join(', ')
                      : 'review evidence retained'}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    disabled={busy}
                    onClick={() => void resolve(item.id, 'CONFIRMED_DUPLICATE')}
                    className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900"
                  >
                    Confirm duplicate
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void resolve(item.id, 'CONFIRMED_DISTINCT')}
                    className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900"
                  >
                    Distinct records
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void resolve(item.id, 'DISMISSED')}
                    className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-500"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
