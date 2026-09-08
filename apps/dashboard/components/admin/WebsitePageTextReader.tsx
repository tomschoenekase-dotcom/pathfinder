'use client'

import { useEffect, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const READ_TIMEOUT_MS = 15_000
type Listing = inferRouterOutputs<AppRouter>['admin']['listWebsitePageText']
type PageMetadata = Extract<Listing, { status: 'RECORDED' }>['pages'][number]
type PageRead = inferRouterOutputs<AppRouter>['admin']['readWebsitePageText']

type Props = {
  tenantId: string
  venueId: string
  runId: string
  receiptId: string
}

function formatCapturedAt(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

function WebsitePageTextReaderInner({ tenantId, venueId, runId, receiptId }: Props) {
  const client = useTRPCClient()
  const [opened, setOpened] = useState(false)
  const [listing, setListing] = useState<Listing | null>(null)
  const [selected, setSelected] = useState<PageMetadata | null>(null)
  const [reads, setReads] = useState<PageRead[]>([])
  const [readIndex, setReadIndex] = useState(0)
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [readNotRecorded, setReadNotRecorded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const requestAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => requestAbort.current?.abort()
  }, [])

  async function loadListing() {
    const requestGeneration = ++generation.current
    requestAbort.current?.abort()
    const controller = new AbortController()
    requestAbort.current = controller
    setOpened(true)
    setListing(null)
    setSelected(null)
    setReads([])
    setReadIndex(0)
    setAppliedSearch('')
    setReadNotRecorded(false)
    setBusy(true)
    setError(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: READ_TIMEOUT_MS,
        request: (signal) =>
          client.admin.listWebsitePageText.query(
            { tenantId, venueId, runId, receiptId },
            { signal },
          ),
      })
      if (requestGeneration !== generation.current || controller.signal.aborted) return
      setListing(result)
      setReadNotRecorded(false)
      setSelected(result.status === 'RECORDED' ? (result.pages[0] ?? null) : null)
      setReads([])
      setReadIndex(0)
    } catch {
      if (requestGeneration !== generation.current || controller.signal.aborted) return
      setError('The retained website text could not be loaded. Try this exact receipt again.')
    } finally {
      if (requestGeneration === generation.current && !controller.signal.aborted) setBusy(false)
    }
  }

  async function readPage(cursor?: string, requestedSearch = search.trim()) {
    if (!selected) return
    const requestGeneration = ++generation.current
    requestAbort.current?.abort()
    const controller = new AbortController()
    requestAbort.current = controller
    setBusy(true)
    setError(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: READ_TIMEOUT_MS,
        request: (signal) =>
          client.admin.readWebsitePageText.query(
            {
              tenantId,
              venueId,
              runId,
              receiptId,
              sourceUrl: selected.sourceUrl,
              expectedExactByteHash: selected.exactByteHash,
              expectedRetainedTextHash: selected.retainedTextHash,
              pageSize: 2_000,
              ...(cursor ? { cursor } : {}),
              ...(requestedSearch ? { search: requestedSearch } : {}),
            },
            { signal },
          ),
      })
      if (requestGeneration !== generation.current || controller.signal.aborted) return
      if (result.status === 'NOT_RECORDED') {
        setReadNotRecorded(true)
        setReads([])
        return
      }
      setReadNotRecorded(false)
      if (cursor) {
        setReads((current) => [...current.slice(0, readIndex + 1), result])
        setReadIndex(readIndex + 1)
      } else {
        setReads([result])
        setReadIndex(0)
        setAppliedSearch(requestedSearch)
      }
    } catch {
      if (requestGeneration !== generation.current || controller.signal.aborted) return
      setError(
        'This retained page could not be read. Its receipt or fingerprints may have changed.',
      )
    } finally {
      if (requestGeneration === generation.current && !controller.signal.aborted) setBusy(false)
    }
  }

  const current = reads[readIndex]
  return (
    <section
      className="mt-4 border-t border-slate-200 pt-4"
      aria-labelledby={`website-text-${receiptId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p id={`website-text-${receiptId}`} className="text-sm font-semibold text-pf-deep">
            Retained website text
          </p>
          <p className="mt-1 text-xs leading-5 text-pf-deep/70">
            Original source observation for review. This text is not an approved fact. PDF text is
            extracted from embedded document text; it is not OCR or map interpretation.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadListing()}
          disabled={busy}
          className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-pf-deep disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && !listing
            ? 'Opening retained text…'
            : opened
              ? 'Reload retained text'
              : 'Open retained website text'}
        </button>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
      {opened && !busy && listing?.status === 'NOT_RECORDED' ? (
        <p className="mt-3 text-sm text-pf-deep/75" role="status">
          This legacy research receipt has no retained website page text.
        </p>
      ) : null}
      {readNotRecorded ? (
        <p className="mt-3 text-sm text-pf-deep/75" role="status">
          This page has no retained text in the selected receipt.
        </p>
      ) : null}
      {listing?.status === 'RECORDED' && listing.pages.length === 0 ? (
        <p className="mt-3 text-sm text-pf-deep/75" role="status">
          No readable page text was retained for this receipt.
        </p>
      ) : null}

      {listing?.status === 'RECORDED' && listing.pages.length > 0 ? (
        <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]">
          <div className="min-w-0">
            <label
              className="text-xs font-semibold text-pf-deep"
              htmlFor={`website-page-${receiptId}`}
            >
              Retained page
            </label>
            <select
              id={`website-page-${receiptId}`}
              value={selected?.sourceUrl ?? ''}
              onChange={(event) => {
                generation.current += 1
                requestAbort.current?.abort()
                requestAbort.current = null
                setBusy(false)
                setSelected(
                  listing.pages.find((page) => page.sourceUrl === event.target.value) ?? null,
                )
                setReads([])
                setReadIndex(0)
                setAppliedSearch('')
                setReadNotRecorded(false)
                setError(null)
              }}
              className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-pf-deep"
            >
              {listing.pages.map((page) => (
                <option key={page.sourceUrl} value={page.sourceUrl}>
                  {page.sourceUrl}
                </option>
              ))}
            </select>
            {selected ? (
              <>
                <p className="mt-2 break-all text-xs leading-5 text-pf-deep/75">
                  {selected.sourceUrl}
                </p>
                <dl className="mt-3 space-y-2 border-l-2 border-slate-200 pl-3 text-xs leading-5 text-pf-deep/75">
                  <div>
                    <dt className="font-semibold text-pf-deep">Captured</dt>
                    <dd>{formatCapturedAt(selected.capturedAt)}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-pf-deep">Extraction</dt>
                    <dd>
                      {selected.extractionProfile === 'static-html-v1'
                        ? 'Static HTML body'
                        : selected.extractionProfile === 'pdfjs-document-v1'
                          ? `PDF embedded text · ${selected.pdfPageCount!.toLocaleString()} page${selected.pdfPageCount === 1 ? '' : 's'}`
                          : 'Plain text'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-pf-deep">Retention</dt>
                    <dd>
                      {selected.retainedCodePointCount.toLocaleString()} of{' '}
                      {selected.fullCodePointCount.toLocaleString()} characters
                      {selected.truncated ? ' · truncated at collection' : ' · complete'}
                    </dd>
                  </div>
                </dl>
              </>
            ) : null}
            <button
              type="button"
              disabled={busy || !selected}
              onClick={() => void readPage(undefined, '')}
              className="mt-3 min-h-11 rounded-lg bg-pf-deep px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Reading page…' : 'Read selected page'}
            </button>
          </div>

          <div className="min-w-0">
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault()
                void readPage(undefined, search.trim())
              }}
            >
              <label className="min-w-0 flex-1 text-xs font-semibold text-pf-deep">
                Find exact text (case-sensitive)
                <input
                  value={search}
                  maxLength={200}
                  onChange={(event) => setSearch(event.target.value)}
                  className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm font-normal"
                />
              </label>
              <button
                type="submit"
                disabled={busy || !selected || !search.trim()}
                className="min-h-11 self-end rounded-lg border border-slate-300 px-4 text-sm font-semibold text-pf-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                Find and restart
              </button>
            </form>
            {current?.status === 'RECORDED' ? (
              <div className="mt-3 min-w-0">
                <p className="text-xs text-pf-deep/65">
                  Characters {current.page.offset.toLocaleString()}–
                  {(current.page.offset + Array.from(current.page.text).length).toLocaleString()} of{' '}
                  {current.retainedCodePointCount.toLocaleString()}
                  {appliedSearch
                    ? ` · ${current.page.matchOffsets.length} exact match${current.page.matchOffsets.length === 1 ? '' : 'es'} in this segment`
                    : ''}
                </p>
                <pre
                  tabIndex={0}
                  className="mt-2 max-h-96 min-w-0 overflow-auto whitespace-pre-wrap break-words border-y border-slate-200 bg-slate-50 px-3 py-4 font-mono text-xs leading-5 text-slate-900"
                >
                  {current.page.text || 'This segment is empty.'}
                </pre>
                <nav
                  aria-label="Retained text segments"
                  className="mt-3 flex flex-wrap items-center gap-3 text-sm"
                >
                  <button
                    type="button"
                    disabled={busy || readIndex === 0}
                    onClick={() => setReadIndex((value) => Math.max(0, value - 1))}
                    className="min-h-11 rounded-lg border border-slate-300 px-3 disabled:opacity-50"
                  >
                    Previous segment
                  </button>
                  <span>Segment {readIndex + 1}</span>
                  <button
                    type="button"
                    disabled={busy || !current.nextCursor}
                    onClick={() =>
                      current.nextCursor && void readPage(current.nextCursor, appliedSearch)
                    }
                    className="min-h-11 rounded-lg border border-slate-300 px-3 disabled:opacity-50"
                  >
                    Next segment
                  </button>
                </nav>
              </div>
            ) : (
              <p className="mt-3 text-sm text-pf-deep/70">
                Choose a retained page, then read its bounded plain-text segments.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}

export function WebsitePageTextReader(props: Props) {
  const scope = JSON.stringify([props.tenantId, props.venueId, props.runId, props.receiptId])
  return <WebsitePageTextReaderInner key={scope} {...props} />
}
