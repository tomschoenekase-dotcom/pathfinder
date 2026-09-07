'use client'

import { useEffect, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

type EvidencePage = inferRouterOutputs<AppRouter>['mediaIngestion']['readIntakeHandoffEvidence']
type Scope = { tenantId: string; venueId: string; runId: string }

export function MediaIntakeEvidenceReader({
  scope,
  readPage,
}: {
  scope: Scope
  readPage?: (input: Scope & { offset: number }) => Promise<EvidencePage>
}) {
  const client = useTRPCClient()
  const [page, setPage] = useState<EvidencePage | null>(null)
  const [previous, setPrevious] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  async function load(offset: number, direction: 'first' | 'next' | 'previous') {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(null)
    try {
      const next = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: 15_000,
        request: (signal) =>
          readPage
            ? readPage({ ...scope, offset })
            : client.mediaIngestion.readIntakeHandoffEvidence.query(
                { ...scope, offset },
                { signal },
              ),
      })
      if (controller.signal.aborted) return
      if (page && next.snapshotHash !== page.snapshotHash)
        throw new Error('Evidence identity changed')
      setPrevious((current) =>
        direction === 'next' && page
          ? [...current, page.offset]
          : direction === 'previous'
            ? current.slice(0, -1)
            : [],
      )
      setPage(next)
    } catch {
      if (!controller.signal.aborted)
        setError(
          'The retained evidence page could not be loaded. Retry without changing the review.',
        )
    } finally {
      if (request.current === controller) request.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return (
    <section className="mt-4 border-t border-pf-light pt-4" aria-label="Retained media evidence">
      {!page && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void load(0, 'first')}
          className="min-h-11 rounded-lg border border-pf-light px-3 text-sm font-medium text-pf-deep disabled:opacity-50"
        >
          {busy ? 'Loading evidence…' : 'Read retained media evidence'}
        </button>
      )}
      {page && (
        <>
          <p className="text-sm text-pf-deep/70">
            Page {previous.length + 1} · {page.sourceCount} retained sources
          </p>
          <pre
            tabIndex={0}
            aria-label="Retained media evidence page"
            className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-pf-primary"
          >
            {page.text}
          </pre>
          <div className="mt-3 flex flex-wrap gap-3">
            {previous.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void load(previous.at(-1)!, 'previous')}
                className="min-h-11 rounded-lg border border-pf-light px-3 text-sm text-pf-deep disabled:opacity-50"
              >
                Previous evidence page
              </button>
            )}
            {page.nextOffset !== null && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void load(page.nextOffset!, 'next')}
                className="min-h-11 rounded-lg border border-pf-light px-3 text-sm text-pf-deep disabled:opacity-50"
              >
                {busy ? 'Loading evidence…' : 'Next evidence page'}
              </button>
            )}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-rose-700">
          {error}
        </p>
      )}
    </section>
  )
}
