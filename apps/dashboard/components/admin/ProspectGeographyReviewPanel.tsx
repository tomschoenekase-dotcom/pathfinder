'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import superjson from 'superjson'
import type { readProspectPhysicalGeography, listProspectGeographyProposals } from '@pathfinder/db'
import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'

type Geography = Awaited<ReturnType<typeof readProspectPhysicalGeography>>
type Proposals = Awaited<ReturnType<typeof listProspectGeographyProposals>>
type ResolveInput = {
  idempotencyKey: string
  reviewId: string
  expectedReviewRevision: number
  expectedRegistryHash: string
  decision: 'ACCEPT' | 'REJECT'
  reason: string
}
type InvalidateInput = {
  idempotencyKey: string
  venueId: string
  expectedVenueUpdatedAt: string
  expectedRevision: number
  expectedRegistryHash: string
  reason: string
}
export type GeographyReviewTransport = {
  load: (venueId: string, signal: AbortSignal) => Promise<Geography>
  proposals: (venueId: string, page: number, signal: AbortSignal) => Promise<Proposals>
  resolve?: ((input: ResolveInput) => Promise<unknown>) | undefined
  invalidate?: ((input: InvalidateInput) => Promise<unknown>) | undefined
  confirmed?: (() => void) | undefined
}
type PendingAction =
  | { kind: 'resolve'; input: ResolveInput }
  | { kind: 'invalidate'; input: InvalidateInput }
const control =
  'min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-700'
const stamp = (value: Date | string) => (value instanceof Date ? value.toISOString() : value)
const publicLink = (value: string | null) => {
  try {
    const url = new URL(value ?? '')
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}
function DecisionReadback({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  const text = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : '')
  return (
    <div className="mt-3 border-l-2 border-emerald-300 pl-3 text-sm leading-6">
      <p className="font-medium">Recorded decision: {text('decision') || 'See retained review'}</p>
      <p className="whitespace-pre-wrap break-words">{text('reason')}</p>
      <p className="break-words text-xs text-slate-600">
        {text('at')}
        {text('actorId') ? ` · ${text('actorId')}` : ''}
      </p>
      {text('assignmentReceiptId') && (
        <p className="break-words text-xs">Assignment receipt: {text('assignmentReceiptId')}</p>
      )}
    </div>
  )
}

/** This panel consumes the existing admin actions; it owns no alternative database or review state. */
export function ProspectGeographyReviewPanel({
  venueId,
  transport,
}: {
  venueId: string
  transport: GeographyReviewTransport
}) {
  const [view, setView] = useState<Geography | null>(null),
    [proposals, setProposals] = useState<Proposals | null>(null)
  const [page, setPage] = useState(1),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false)
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reason, setReason] = useState(''),
    [checked, setChecked] = useState(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const inFlight = useRef(false)
  useEffect(() => {
    setPage(1)
    setView(null)
    setProposals(null)
    setReason('')
    setChecked(false)
    setNotice('')
  }, [venueId])
  useEffect(() => {
    let active = true
    const controller = new AbortController(),
      timer = setTimeout(() => {
        if (active) {
          setError('Location read timed out. Reload before making a decision.')
          setLoading(false)
        }
        controller.abort()
      }, 20000)
    setLoading(true)
    setError('')
    setView(null)
    setProposals(null)
    setChecked(false)
    Promise.all([
      transport.load(venueId, controller.signal),
      transport.proposals(venueId, page, controller.signal),
    ])
      .then(([record, items]) => {
        if (active && !controller.signal.aborted) {
          setView(record)
          setProposals(items)
        }
      })
      .catch(() => {
        if (active && !controller.signal.aborted)
          setError(
            'The current location and proposals could not be loaded. Reload before making a decision.',
          )
      })
      .finally(() => {
        clearTimeout(timer)
        if (active && !controller.signal.aborted) setLoading(false)
      })
    return () => {
      active = false
      clearTimeout(timer)
      controller.abort()
    }
  }, [venueId, page, refresh, transport])
  async function execute(action: PendingAction) {
    if (inFlight.current) return
    const operation = action.kind === 'resolve' ? transport.resolve : transport.invalidate
    if (!operation) return
    inFlight.current = true
    setPending(action)
    setBusy(true)
    setError('')
    setNotice('')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const request =
        action.kind === 'resolve'
          ? transport.resolve!(action.input)
          : transport.invalidate!(action.input)
      const result = await Promise.race([
        Promise.resolve(request),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Decision response timed out')), 20000)
        }),
      ])
      const receipt =
        result && typeof result === 'object' && 'receiptId' in result
          ? String(result.receiptId)
          : ''
      if (!receipt) throw new Error('A durable receipt is required to confirm this operation')
      setNotice(
        `${action.kind === 'invalidate' ? 'County assignment reopened; prior evidence remains available.' : action.input.decision === 'ACCEPT' ? 'County evidence accepted.' : 'Proposal rejected; existing facts are preserved.'} Receipt: ${receipt}`,
      )
      setPending(null)
      setChecked(false)
      setRefresh((x) => x + 1)
      transport.confirmed?.()
    } catch {
      setError(
        'The outcome is unconfirmed. Reload to inspect the record, or retry the same request below. No new decision key will be created while this request is pending.',
      )
    } finally {
      clearTimeout(timer)
      inFlight.current = false
      setBusy(false)
    }
  }
  async function decide(reviewId: string, revision: number, decision: 'ACCEPT' | 'REJECT') {
    if (!view || !transport.resolve || busy || loading || error || pending) return
    await execute({
      kind: 'resolve',
      input: {
        idempotencyKey: crypto.randomUUID(),
        reviewId,
        expectedReviewRevision: revision,
        expectedRegistryHash: view.registryHash,
        decision,
        reason,
      },
    })
  }
  async function reopen() {
    if (
      !view?.venue ||
      !view.geography ||
      !transport.invalidate ||
      busy ||
      loading ||
      error ||
      pending
    )
      return
    await execute({
      kind: 'invalidate',
      input: {
        idempotencyKey: crypto.randomUUID(),
        venueId,
        expectedVenueUpdatedAt: stamp(view.venue.updatedAt),
        expectedRevision: view.geography.revision,
        expectedRegistryHash: view.registryHash,
        reason,
      },
    })
  }
  return (
    <section
      aria-labelledby="physical-location-review"
      className="my-8 border-y border-emerald-300 bg-white px-4 py-6 sm:px-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="physical-location-review" className="text-xl font-semibold">
          Review physical location
        </h2>
        <button className={control} onClick={() => setRefresh((x) => x + 1)} disabled={busy}>
          Reload location
        </button>
      </div>
      {loading && (
        <p role="status" className="mt-4">
          Loading current CRM location and evidence…
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-4 border-l-4 border-red-700 bg-red-50 p-3 text-sm text-red-900"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mt-4 break-words border-l-4 border-emerald-700 bg-emerald-50 p-3 text-sm"
        >
          {notice}
        </p>
      )}
      {pending && (
        <div className="mt-4 border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm">
            An unconfirmed{' '}
            {pending.kind === 'resolve' ? 'proposal decision' : 'assignment correction'} is retained
            with its original input and retry key.
          </p>
          <button
            className={`${control} mt-3`}
            disabled={busy}
            onClick={() => void execute(pending)}
          >
            Retry the same request
          </button>
          <p className="mt-2 text-xs">
            Keep this panel open until its receipt is confirmed. Reloading the location does not
            create another decision.
          </p>
        </div>
      )}
      {!loading && view && !view.venue && (
        <p className="mt-4">
          This native location is unavailable. Return to the directory and select a current record.
        </p>
      )}
      {!loading && view?.venue && (
        <>
          <h3 className="mt-5 text-lg font-semibold">{view.venue.name}</h3>
          <p className="mt-1 text-sm text-slate-600">
            {view.venue.city ?? 'City unknown'}, {view.venue.region ?? 'state unknown'} ·{' '}
            {view.geography?.legacyTerritory?.name ?? 'No legacy territory'}
          </p>
          <p className="mt-3 text-sm leading-6">
            {view.geography?.status === 'ASSIGNED'
              ? `Assigned to ${view.geography.county?.countyName ?? 'county unavailable'} · ${view.territory?.name ?? 'territory unavailable'}`
              : 'County not yet verified. Source-sheet membership is preserved, not treated as a geocode.'}
          </p>
          {view.physicalEvidence && (
            <details className="mt-4 border border-slate-200 p-4">
              <summary className="min-h-11 cursor-pointer font-medium focus-visible:outline focus-visible:outline-2">
                {view.geography?.status === 'ASSIGNED'
                  ? 'Current assignment evidence'
                  : 'Retained evidence — assignment is not currently verified'}
              </summary>
              <p className="mt-2 break-words text-sm">
                {view.physicalEvidence.physicalAddress} · observed{' '}
                {view.physicalEvidence.observedAt}
              </p>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                {[
                  [
                    'Physical visitor location',
                    view.physicalEvidence.addressSourceUrl,
                    view.physicalEvidence.addressQuote,
                  ],
                  [
                    'Authoritative county',
                    view.physicalEvidence.countySourceUrl,
                    view.physicalEvidence.countyQuote,
                  ],
                ].map(([label, url, quote]) => (
                  <div key={label} className="min-w-0">
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center text-sm text-emerald-800 underline"
                    >
                      {label}
                    </a>
                    <p className="whitespace-pre-wrap break-words text-sm leading-6">{quote}</p>
                  </div>
                ))}
              </div>
            </details>
          )}
          {publicLink(view.venue.website) && (
            <a
              href={publicLink(view.venue.website)!}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex min-h-11 items-center text-sm text-emerald-800 underline"
            >
              Recorded venue website
            </a>
          )}
          {!transport.resolve && (
            <p className="mt-3 text-sm text-amber-900">
              This local view can display research proposals. Approve or reject them in the
              authenticated CRM; this route cannot grant approval.
            </p>
          )}
          <p className="mt-4 text-sm text-slate-600">
            {proposals?.total ?? 0} proposals. A source observation is not an approved county
            assignment or permission to contact.
          </p>
          {proposals?.items.length === 0 && (
            <p className="mt-3 rounded border border-slate-200 p-4 text-sm">
              No county evidence has been proposed for this location. A research agent can submit a
              source-backed physical address and county through the existing geography proposal
              tool.
            </p>
          )}
          {transport.resolve && (
            <div className="mt-5 grid gap-3">
              <label className="text-sm font-medium">
                Decision reason
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  minLength={12}
                  maxLength={2000}
                  rows={2}
                  className={`${control} mt-1 block w-full py-2`}
                  placeholder="What do the address and county sources establish?"
                />
              </label>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                  className="size-5"
                />
                I checked both sources against this physical visitor location.
              </label>
            </div>
          )}
          <div className="mt-4 divide-y divide-slate-200">
            {proposals?.items.map((item) => (
              <article key={item.reviewId} className="py-5">
                <h4 className="font-semibold">
                  {item.proposal?.evidence.physicalAddress ??
                    'Invalid proposal — retained for review'}
                </h4>
                <p className="mt-1 text-sm text-slate-600">
                  {item.status}
                  {item.stale ? ' · Record changed since this proposal' : ''} · review revision{' '}
                  {item.revision}
                </p>
                {item.proposal && (
                  <>
                    <p className="mt-2 text-sm">
                      County code {item.proposal.evidence.countyGeoid} · observed{' '}
                      {item.proposal.evidence.observedAt} ·{' '}
                      {item.proposal.evidence.method.replaceAll('_', ' ').toLowerCase()}
                    </p>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      {[
                        [
                          'Physical address source',
                          item.proposal.evidence.addressSourceUrl,
                          item.proposal.evidence.addressQuote,
                        ],
                        [
                          'County source',
                          item.proposal.evidence.countySourceUrl,
                          item.proposal.evidence.countyQuote,
                        ],
                      ].map(([label, url, quote]) => (
                        <div key={label} className="min-w-0 border-l-2 border-slate-200 pl-3">
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex min-h-11 items-center text-sm font-medium text-emerald-800 underline"
                          >
                            {label}
                          </a>
                          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
                            {quote}
                          </p>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {item.stale && item.status === 'OPEN' && (
                  <p className="mt-3 text-sm text-amber-900">
                    Do not accept this stale proposal. Ask for fresh evidence bound to the current
                    record, or reject the old proposal.
                  </p>
                )}
                <DecisionReadback value={item.decision} />
                {transport.resolve && item.status === 'OPEN' && (
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button
                      className={`${control} bg-emerald-800 text-white disabled:opacity-50`}
                      disabled={
                        busy ||
                        loading ||
                        Boolean(error) ||
                        Boolean(pending) ||
                        item.stale ||
                        !item.proposal ||
                        !checked ||
                        reason.trim().length < 12
                      }
                      onClick={() => void decide(item.reviewId, item.revision, 'ACCEPT')}
                    >
                      Accept county evidence
                    </button>
                    <button
                      className={`${control} disabled:opacity-50`}
                      disabled={
                        busy ||
                        loading ||
                        Boolean(error) ||
                        Boolean(pending) ||
                        reason.trim().length < 12
                      }
                      onClick={() => void decide(item.reviewId, item.revision, 'REJECT')}
                    >
                      Reject proposal
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
          {proposals && (
            <nav
              aria-label="Location proposal pages"
              className="mt-3 flex items-center justify-between gap-3"
            >
              <button
                className={control}
                disabled={page === 1 || loading}
                onClick={() => setPage((x) => x - 1)}
              >
                Previous proposals
              </button>
              <span className="text-sm">Page {page}</span>
              <button
                className={control}
                disabled={!proposals.hasMore || loading}
                onClick={() => setPage((x) => x + 1)}
              >
                Next proposals
              </button>
            </nav>
          )}
          {transport.invalidate && view.geography?.status === 'ASSIGNED' && (
            <button
              className={`${control} mt-5 disabled:opacity-50`}
              disabled={
                busy || loading || Boolean(error) || Boolean(pending) || reason.trim().length < 12
              }
              onClick={() => void reopen()}
            >
              Reopen county assignment
            </button>
          )}
        </>
      )}
    </section>
  )
}

export function AuthenticatedProspectGeographyPanel({ venueId }: { venueId: string }) {
  const client = useTRPCClient()
  const router = useRouter()
  // Stable transport avoids refetch loops when the panel updates its own form fields.
  const [transport] = useState<GeographyReviewTransport>(() => ({
    load: (id, parentSignal) =>
      runBoundedClientRequest({
        parentSignal,
        timeoutMs: 15000,
        request: (signal) =>
          client.admin.getProspectPhysicalGeography.query({ venueId: id }, { signal }),
      }),
    proposals: (id, page, parentSignal) =>
      runBoundedClientRequest({
        parentSignal,
        timeoutMs: 15000,
        request: (signal) =>
          client.admin.listProspectGeographyProposals.query(
            { venueId: id, page, limit: 20, status: 'ALL' },
            { signal },
          ),
      }),
    resolve: (input) => client.admin.resolveProspectGeographyProposal.mutate(input),
    invalidate: (input) => client.admin.invalidateProspectPhysicalGeography.mutate(input),
    confirmed: () => router.refresh(),
  }))
  return <ProspectGeographyReviewPanel venueId={venueId} transport={transport} />
}
export function LocalProspectGeographyPanel({ venueId }: { venueId: string }) {
  const [transport] = useState<GeographyReviewTransport>(() => {
    async function read<T>(operation: string, input: unknown, signal: AbortSignal): Promise<T> {
      const response = await fetch(
        `/dev-fixtures/prospect-research/territories/data?${new URLSearchParams({ operation, input: JSON.stringify(input) })}`,
        { signal, redirect: 'error', cache: 'no-store' },
      )
      if (!response.ok) throw new Error('Local geography read unavailable')
      return superjson.parse<T>(await response.text())
    }
    return {
      load: (id, signal) => read('geography', { venueId: id }, signal),
      proposals: (id, page, signal) =>
        read('proposals', { venueId: id, page, limit: 20, status: 'ALL' }, signal),
    }
  })
  return <ProspectGeographyReviewPanel venueId={venueId} transport={transport} />
}
