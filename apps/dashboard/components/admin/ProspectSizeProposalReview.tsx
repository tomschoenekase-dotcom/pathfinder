'use client'

import { ChangeEvent, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FileJson2,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'

import { useTRPCClient } from '../../lib/trpc'

const SCHEMA = 'torchiko.prospect-size-proposals/v1'
const MAX_FILE_BYTES = 5 * 1024 * 1024

type ProposalFile = { schema: typeof SCHEMA; status: 'proposal-only'; records: unknown[] }
type Size = {
  class: string
  basis: string
  value?: number
  unit?: string
  sourceUrl?: string
  observedAt: string
  confidence?: 'measured' | 'rule'
}
type PreviewRow = {
  venueId: string
  organizationId: string | null
  snapshotName: string
  snapshotCity: string | null
  snapshotRegion: string | null
  currentName: string | null
  currentCity: string | null
  currentRegion: string | null
  currentUpdatedAt: string | null
  currentSize: string | null
  currentSizeEvidence: Size | null
  proposedSize: Size
  status: 'READY' | 'CONFLICT'
  reasons: string[]
}
type AppliedRow = {
  venueId: string
  status: 'APPLIED' | 'CONFLICT'
  reasons: string[]
  updatedAt?: string
  readbackSize?: string | null
}
type ProposalClient = {
  admin: {
    previewProspectSizeProposals: {
      mutate: (input: { proposalFile: ProposalFile }) => Promise<{ rows: PreviewRow[] }>
    }
    applyProspectSizeProposals: {
      mutate: (input: {
        rows: Array<{
          venueId: string
          organizationId: string
          expectedUpdatedAt: string | null
          snapshotName: string
          snapshotCity: string | null
          snapshotRegion: string | null
          size: Size
        }>
      }) => Promise<{ results: AppliedRow[] }>
    }
  }
}

function formatSize(size: Size | string | null | undefined) {
  if (!size) return 'Unknown'
  if (typeof size === 'string') return size
  const measure =
    size.value === undefined ? '' : ` · ${size.value.toLocaleString()} ${size.unit ?? ''}`
  return `${size.class}${measure}`
}

function validProposalFile(value: unknown): value is ProposalFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { schema?: unknown }).schema === SCHEMA &&
    (value as { status?: unknown }).status === 'proposal-only' &&
    Array.isArray((value as { records?: unknown }).records)
  )
}

export function ProspectSizeProposalReview() {
  const client = useTRPCClient() as unknown as ProposalClient
  const [fileName, setFileName] = useState('')
  const [proposalFile, setProposalFile] = useState<ProposalFile | null>(null)
  const [rows, setRows] = useState<PreviewRow[] | null>(null)
  const [results, setResults] = useState<AppliedRow[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setError(null)
    setNotice('')
    setRows(null)
    setResults(null)
    setSelected(new Set())
    if (!file.name.toLowerCase().endsWith('.json')) {
      setProposalFile(null)
      setFileName('')
      setError('Choose a JSON proposal file.')
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setProposalFile(null)
      setFileName('')
      setError('Proposal files must be 5 MB or smaller.')
      return
    }
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!validProposalFile(parsed)) throw new Error('schema')
      setProposalFile(parsed)
      setFileName(file.name)
      setNotice(
        `${parsed.records.length} proposal rows loaded. Preview them against the current CRM before applying.`,
      )
    } catch {
      setProposalFile(null)
      setFileName('')
      setError('This file is not valid JSON for torchiko.prospect-size-proposals/v1.')
    }
  }

  async function preview() {
    if (!proposalFile) return
    setBusy(true)
    setError(null)
    setNotice('Comparing proposal rows with the current CRM…')
    setRows(null)
    setResults(null)
    setSelected(new Set())
    try {
      const result = await client.admin.previewProspectSizeProposals.mutate({ proposalFile })
      setRows(result.rows)
      const ready = result.rows.filter((row) => row.status === 'READY')
      setSelected(new Set())
      setNotice(
        `${ready.length} ready to review · ${result.rows.length - ready.length} conflict${result.rows.length - ready.length === 1 ? '' : 's'} held back. Select only rows you approve.`,
      )
    } catch {
      setError(
        'The CRM could not preview this proposal. Retry the preview before applying anything.',
      )
      setNotice('')
    } finally {
      setBusy(false)
    }
  }

  async function applySelected() {
    if (!rows?.length || !selected.size) return
    const readyRows = rows.filter(
      (row): row is PreviewRow & { organizationId: string; currentUpdatedAt: string } =>
        row.status === 'READY' &&
        selected.has(row.venueId) &&
        !!row.organizationId &&
        !!row.currentUpdatedAt,
    )
    if (!readyRows.length) return
    setBusy(true)
    setError(null)
    setNotice('Applying selected size evidence and reading each row back…')
    try {
      const response = await client.admin.applyProspectSizeProposals.mutate({
        rows: readyRows.map((row) => ({
          venueId: row.venueId,
          organizationId: row.organizationId,
          expectedUpdatedAt: row.currentUpdatedAt,
          snapshotName: row.snapshotName,
          snapshotCity: row.snapshotCity,
          snapshotRegion: row.snapshotRegion,
          size: row.proposedSize,
        })),
      })
      setResults(response.results)
      const applied = response.results.filter((item) => item.status === 'APPLIED').length
      setNotice(
        `${applied} row${applied === 1 ? '' : 's'} applied and read back · ${response.results.length - applied} conflict${response.results.length - applied === 1 ? '' : 's'}`,
      )
    } catch {
      setError(
        'The CRM did not confirm the apply operation. Reload the proposal and preview current row versions before retrying.',
      )
      setNotice('')
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    setProposalFile(null)
    setRows(null)
    setResults(null)
    setSelected(new Set())
    setFileName('')
    setError(null)
    setNotice('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const readyCount = rows?.filter((row) => row.status === 'READY').length ?? 0
  const selectedCount =
    rows?.filter((row) => row.status === 'READY' && selected.has(row.venueId)).length ?? 0

  return (
    <main className="mx-auto max-w-7xl space-y-7 px-4 py-7 sm:px-6 lg:px-8">
      <header className="border-b border-slate-200 pb-5">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-700">
          Venue intelligence CRM
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
          Review size proposals
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Compare researched size evidence with the current venue record. Only rows that still match
          can be selected for Tom to apply.
        </p>
      </header>

      <section
        aria-labelledby="proposal-file-heading"
        className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-end"
      >
        <div>
          <h2 id="proposal-file-heading" className="text-base font-semibold text-slate-900">
            1. Choose a proposal file
          </h2>
          <label className="mt-3 flex min-h-24 cursor-pointer items-center gap-4 border border-dashed border-slate-300 bg-white px-4 py-5 transition-colors hover:border-sky-500 focus-within:outline-none focus-within:ring-2 focus-within:ring-sky-500">
            <FileJson2 aria-hidden="true" className="h-6 w-6 shrink-0 text-sky-700" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-slate-900">
                {fileName || 'Select a size proposal JSON'}
              </span>
              <span className="mt-1 block text-xs text-slate-600">
                Schema torchiko.prospect-size-proposals/v1 · up to 5 MB
              </span>
            </span>
            <span className="shrink-0 border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800">
              Browse
            </span>
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              onChange={chooseFile}
              className="sr-only"
              aria-label="Choose a size proposal JSON file"
            />
          </label>
          {proposalFile ? (
            <p className="mt-2 text-xs text-slate-600">
              {proposalFile.records.length} records in {fileName}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          <button
            type="button"
            onClick={() => void preview()}
            disabled={!proposalFile || busy}
            className="inline-flex min-h-11 items-center justify-center gap-2 bg-sky-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {busy && !rows ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            Preview rows
          </button>
          {proposalFile ? (
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="min-h-11 border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 disabled:opacity-50"
            >
              Choose another
            </button>
          ) : null}
        </div>
      </section>

      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <p
            role="alert"
            className="flex items-start gap-2 border-l-4 border-rose-600 bg-rose-50 px-4 py-3 text-sm text-rose-900"
          >
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        ) : null}
        {notice ? (
          <p
            role="status"
            className="flex items-start gap-2 border-l-4 border-sky-700 bg-sky-50 px-4 py-3 text-sm text-sky-950"
          >
            <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            {notice}
          </p>
        ) : null}
      </div>

      {rows ? (
        <section aria-labelledby="proposal-review-heading" className="space-y-4">
          <div className="flex flex-col gap-3 border-b border-slate-200 pb-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="proposal-review-heading" className="text-lg font-semibold text-slate-950">
                2. Review changes and conflicts
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {readyCount} ready · {rows.length - readyCount} held for review · {selectedCount}{' '}
                selected
              </p>
            </div>
            {readyCount ? (
              <label className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-slate-800">
                <input
                  type="checkbox"
                  checked={selectedCount === readyCount}
                  onChange={(event) =>
                    setSelected(
                      new Set(
                        event.target.checked
                          ? rows.filter((row) => row.status === 'READY').map((row) => row.venueId)
                          : [],
                      ),
                    )
                  }
                  className="h-4 w-4 accent-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                />
                Select all ready rows
              </label>
            ) : null}
          </div>

          {rows.length ? (
            <div className="divide-y divide-slate-200 border-y border-slate-200">
              {rows.map((row) => {
                const result = results?.find((item) => item.venueId === row.venueId)
                const canSelect = row.status === 'READY' && !result
                return (
                  <article
                    key={row.venueId}
                    className="grid gap-3 py-4 sm:grid-cols-[2rem_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-start"
                  >
                    <div className="pt-1">
                      {canSelect ? (
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.snapshotName}`}
                          checked={selected.has(row.venueId)}
                          onChange={(event) =>
                            setSelected((previous) => {
                              const next = new Set(previous)
                              if (event.target.checked) next.add(row.venueId)
                              else next.delete(row.venueId)
                              return next
                            })
                          }
                          className="h-4 w-4 accent-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                        />
                      ) : (
                        <span aria-hidden="true" className="block h-4 w-4" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <h3 className="break-words font-semibold text-slate-950">
                        {row.snapshotName}
                      </h3>
                      <p className="mt-1 break-words text-sm text-slate-600">
                        Proposal identity: {row.snapshotCity ?? 'city unknown'},{' '}
                        {row.snapshotRegion ?? 'region unknown'}
                      </p>
                      <p className="mt-1 break-words text-sm text-slate-600">
                        Current: {row.currentName ?? 'No matching venue'}
                        {row.currentCity ? ` · ${row.currentCity}` : ''}
                        {row.currentRegion ? `, ${row.currentRegion}` : ''}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Row version:{' '}
                        {row.currentUpdatedAt
                          ? new Date(row.currentUpdatedAt).toLocaleString()
                          : 'No current row'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Current size
                      </p>
                      <p className="mt-1 text-sm font-medium text-slate-800">
                        {formatSize(row.currentSizeEvidence ?? row.currentSize)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Proposed size
                      </p>
                      <p className="mt-1 text-sm font-semibold text-slate-950">
                        {formatSize(row.proposedSize)}
                      </p>
                      <p className="mt-1 text-xs text-slate-600">
                        {row.proposedSize.basis} · {row.proposedSize.confidence ?? 'unverified'} ·{' '}
                        {row.proposedSize.observedAt}
                      </p>
                      {row.proposedSize.sourceUrl ? (
                        <a
                          className="mt-1 inline-block break-all text-xs text-sky-800 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                          href={row.proposedSize.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Evidence source
                        </a>
                      ) : null}
                      {result ? (
                        <p
                          className={`mt-2 flex items-center gap-1 text-sm font-semibold ${result.status === 'APPLIED' ? 'text-emerald-800' : 'text-amber-900'}`}
                        >
                          {result.status === 'APPLIED' ? (
                            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                          )}
                          {result.status === 'APPLIED'
                            ? `Read back: ${formatSize(result.readbackSize)}`
                            : 'Apply conflict'}
                        </p>
                      ) : (
                        <p
                          className={`mt-2 text-xs font-semibold ${row.status === 'READY' ? 'text-emerald-800' : 'text-amber-900'}`}
                        >
                          {row.status === 'READY' ? 'Ready' : 'Conflict'}
                        </p>
                      )}
                      {[...row.reasons, ...(result?.reasons ?? [])].length ? (
                        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-amber-950">
                          {[...row.reasons, ...(result?.reasons ?? [])].map((reason, index) => (
                            <li key={`${index}-${reason}`}>{reason}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <p className="border-y border-slate-200 py-8 text-center text-sm text-slate-600">
              No proposal rows were returned for review.
            </p>
          )}

          {!results ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-xs leading-5 text-slate-600">
                Apply uses the row version shown above. Rows that changed since preview will be held
                as conflicts, and every successful update is read back.
              </p>
              <button
                type="button"
                onClick={() => void applySelected()}
                disabled={!selectedCount || busy}
                className="inline-flex min-h-11 items-center justify-center gap-2 bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Apply {selectedCount} selected
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setRows(null)
                setResults(null)
                void preview()
              }}
              disabled={busy}
              className="inline-flex min-h-10 items-center gap-2 border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Refresh from CRM
            </button>
          )}
        </section>
      ) : !proposalFile ? (
        <p className="border-y border-slate-200 py-8 text-center text-sm text-slate-600">
          Choose a validated proposal file to compare it with current venue records.
        </p>
      ) : null}
    </main>
  )
}
