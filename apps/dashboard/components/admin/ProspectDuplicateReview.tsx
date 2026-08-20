'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, ScanSearch } from 'lucide-react'

import { useTRPCClient } from '../../lib/trpc'

type Candidate = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['listProspectDuplicates']['query']>
>[number]

export function ProspectDuplicateReview() {
  const client = useTRPCClient()
  const [items, setItems] = useState<Candidate[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Loading duplicate review queue…')

  async function refresh() {
    const rows = await client.admin.listProspectDuplicates.query({ status: 'OPEN', limit: 200 })
    setItems(rows)
    setMessage(
      rows.length
        ? `${rows.length} conservative candidates need review.`
        : 'No open duplicate candidates.',
    )
  }

  useEffect(() => {
    void refresh().catch(() => setMessage('Duplicate review is unavailable.'))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function scan() {
    setBusy(true)
    setMessage('Scanning exact names, domains, venue names, and contact emails…')
    try {
      const result = await client.admin.scanProspectDuplicates.mutate({ prospectLimit: 20_000 })
      setMessage(
        `Scanned ${result.organizationsScanned.toLocaleString()} prospects; created ${result.candidatesCreated.toLocaleString()} review candidates.`,
      )
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Duplicate scan failed.')
    } finally {
      setBusy(false)
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
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Review could not be saved.')
    } finally {
      setBusy(false)
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
        role="status"
        className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600"
      >
        {message}
      </p>
      {!items.length ? (
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
