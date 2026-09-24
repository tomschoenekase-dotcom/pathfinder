'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { ChicagoVenueDetail as VenueDetail } from '@pathfinder/api/chicago-intelligence-contract'
import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { chicagoLabel, chicagoSafeUrl } from '../../lib/chicago-directory-state'
import { ChicagoVenueActions, type ChicagoMutationTransport } from './ChicagoVenueActions'

export const chicagoControl =
  'min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:border-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:cursor-not-allowed disabled:opacity-50'

export function ChicagoEvidenceValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '')
    return <span className="text-slate-600">Unknown</span>
  if (typeof value === 'object')
    return (
      <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-xs leading-5">
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  return <span>{String(value)}</span>
}

export function ChicagoSourceLink({ url, label }: { url: string; label?: string }) {
  const safe = chicagoSafeUrl(url)
  return safe ? (
    <a
      className="break-all text-sky-800 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700"
      href={safe}
      target="_blank"
      rel="noreferrer"
    >
      {label ?? url}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : (
    <span className="break-all text-slate-600">{label ?? url} (URL unverified)</span>
  )
}

export function ChicagoVenueDetail({
  venueId,
  onBack,
  previousId,
  nextId,
  onNavigate,
  onMutation,
  loadDetail,
  act,
  organizationHref = '/admin/prospects',
  readOnly = false,
}: {
  venueId: string
  onBack: () => void
  previousId?: string | undefined
  nextId?: string | undefined
  onNavigate: (id: string) => void
  onMutation?: (() => void) | undefined
  loadDetail?: ((venueId: string, signal: AbortSignal) => Promise<VenueDetail>) | undefined
  act?: ChicagoMutationTransport | undefined
  organizationHref?: string
  readOnly?: boolean
}) {
  const client = useTRPCClient()
  const [detail, setDetail] = useState<VenueDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [changed, setChanged] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    setDetail(null)
    void runBoundedClientRequest({
      parentSignal: controller.signal,
      timeoutMs: 15_000,
      request: (signal) =>
        loadDetail
          ? loadDetail(venueId, signal)
          : client.admin.getChicagoVenue.query({ venueId }, { signal }),
    })
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [client, venueId, retry, loadDetail])
  return (
    <div className="min-w-0 space-y-7 text-slate-900 [overflow-wrap:anywhere]">
      <nav
        aria-label="Chicago venue results"
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <button className={chicagoControl} onClick={onBack}>
          ← Back to Chicago results
        </button>
        <div className="flex gap-2">
          <button
            className={chicagoControl}
            disabled={!previousId}
            onClick={() => previousId && onNavigate(previousId)}
          >
            ← Previous
          </button>
          <button
            className={chicagoControl}
            disabled={!nextId}
            onClick={() => nextId && onNavigate(nextId)}
          >
            Next →
          </button>
        </div>
      </nav>
      {loading ? (
        <p role="status" className="border-y border-slate-200 py-12 text-sm">
          Loading venue evidence…
        </p>
      ) : failed ? (
        <div role="alert" className="border border-rose-300 bg-rose-50 p-5">
          <h1 className="font-semibold">Venue could not be loaded</h1>
          <p className="mt-2 text-sm">
            Your result filters are retained. Retry the read or return to the directory.
          </p>
          <button
            className={`${chicagoControl} mt-3`}
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry venue
          </button>
        </div>
      ) : detail ? (
        <>
          <header className="border-b border-slate-300 pb-6">
            <h1 className="text-3xl font-semibold tracking-tight">{detail.name}</h1>
            <p className="mt-2 text-sm text-slate-600">
              {[detail.city, detail.state].filter(Boolean).join(', ') || 'Location unknown'} ·{' '}
              {detail.category ?? 'Category unknown'} ·{' '}
              {detail.chicagoProper ? 'Chicago proper' : 'Chicago operating region'}
            </p>
            <dl className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-600">Organization</dt>
                <dd className="mt-1 font-medium">{detail.organization.name}</dd>
                <dd className="mt-1 text-xs text-slate-600">{detail.organization.identityNote}</dd>
              </div>
              <div>
                <dt className="text-slate-600">Relationship / record revision</dt>
                <dd className="mt-1">
                  {chicagoLabel(detail.relationshipState)} · revision {detail.revision}
                </dd>
                <dd className="mt-1 text-xs text-slate-600">
                  {chicagoLabel(detail.confidence)} confidence ·{' '}
                  {detail.stale ? 'Stale or undated evidence' : 'Current evidence'}
                </dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-5 text-sm">
              {detail.website ? (
                <ChicagoSourceLink url={detail.website} label="Venue website" />
              ) : (
                <span className="text-slate-600">Website unknown</span>
              )}
              <Link
                className="font-medium text-sky-800 underline underline-offset-4"
                href={`${organizationHref}/${encodeURIComponent(detail.organizationId)}?directoryQuery=${encodeURIComponent(typeof window === 'undefined' ? 'scope=chicago' : window.location.search.slice(1))}`}
              >
                Organization, contacts & correspondence →
              </Link>
            </div>
          </header>
          {!readOnly && (
            <ChicagoVenueActions
              key={`${detail.venueId}-${detail.revision}`}
              venue={{ venueId: detail.venueId, revision: detail.revision }}
              act={act}
              onSuccess={() => {
                setChanged(true)
                onMutation?.()
              }}
            />
          )}
          {changed && (
            <div role="status" className="flex flex-wrap items-center gap-3 text-sm">
              <p>
                A mutation result is available above. Refresh to read the current canonical record.
              </p>
              <button
                className={chicagoControl}
                onClick={() => {
                  setChanged(false)
                  setRetry((value) => value + 1)
                }}
              >
                Refresh venue & audit
              </button>
            </div>
          )}
          <section aria-labelledby="chicago-ranking-title">
            <h2 id="chicago-ranking-title" className="text-xl font-semibold">
              Why this venue ranks here
            </h2>
            <p className="mt-2 text-sm">
              <strong>{chicagoLabel(detail.ranking.state)}</strong> · {detail.ranking.stateReason}
            </p>
            <p className="mt-2 break-all text-xs text-slate-600">
              Rules {detail.ranking.version} · evaluated {detail.ranking.asOf}. Dimensions remain
              separate; unknown evidence is not zero.
            </p>
            <div className="mt-5 divide-y divide-slate-200 border-y border-slate-200">
              {(
                [
                  'productFit',
                  'attainability',
                  'contactability',
                  'evidenceQuality',
                  'evidenceFreshness',
                  'completeness',
                  'researchPriority',
                ] as const
              ).map((key) => {
                const dimension = detail.ranking[key]
                return (
                  <details key={key} className="py-3">
                    <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
                      <span className="font-medium">
                        {chicagoLabel(key)}{' '}
                        <span aria-hidden="true" className="ml-2 text-slate-500">
                          ＋
                        </span>
                      </span>
                      <span className="text-sm tabular-nums">
                        {dimension.value === null ? 'Unknown' : `${dimension.value} / 100`}
                        <span className="ml-3 text-xs text-slate-600">
                          {Math.round(dimension.coverage * 100)}% component coverage
                        </span>
                      </span>
                    </summary>
                    <ul className="mt-3 space-y-4 text-sm">
                      {dimension.components.map((part, index) => (
                        <li key={`${part.key}-${index}`} className="border-l border-slate-300 pl-4">
                          <div className="flex flex-wrap justify-between gap-2">
                            <strong>{chicagoLabel(part.key)}</strong>
                            <span className="text-xs text-slate-600">
                              {part.value === null ? 'Unknown' : `${part.value} / 100`} ·{' '}
                              {chicagoLabel(part.basis)} · {part.researchedAt ?? 'Date unknown'}
                            </span>
                          </div>
                          <p className="mt-1 leading-6">{part.reason}</p>
                          {part.sourceUrls.length > 0 && (
                            <ul className="mt-1 space-y-1 text-xs">
                              {part.sourceUrls.map((url) => (
                                <li key={url}>
                                  <ChicagoSourceLink url={url} />
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                    {dimension.reasons.length > 0 && (
                      <p className="mt-3 text-xs leading-5 text-slate-600">
                        {dimension.reasons.join(' ')}
                      </p>
                    )}
                  </details>
                )
              })}
            </div>
            {detail.ranking.override && (
              <aside className="mt-4 border border-amber-300 bg-amber-50 p-4 text-sm">
                <strong>Human override</strong>
                <p className="mt-1">
                  {chicagoLabel(detail.ranking.override.dimension)}: {detail.ranking.override.value}{' '}
                  · {detail.ranking.override.actor} · {detail.ranking.override.at}
                </p>
                <p className="mt-2">{detail.ranking.override.rationale}</p>
              </aside>
            )}
          </section>
          <section aria-labelledby="chicago-gaps-title">
            <h2 id="chicago-gaps-title" className="text-xl font-semibold">
              Research needs & uncertainty
            </h2>
            <ol className="mt-4 divide-y divide-slate-200">
              {detail.researchGaps.map((gap, index) => (
                <li key={`${gap.key}-${index}`} className="flex gap-4 py-3 text-sm">
                  <span className="w-10 shrink-0 tabular-nums text-slate-600">{gap.priority}</span>
                  <div>
                    <strong>{chicagoLabel(gap.key)}</strong>
                    <p className="mt-1 text-slate-600">{gap.reason}</p>
                  </div>
                </li>
              ))}
            </ol>
            {!detail.researchGaps.length && (
              <p className="mt-3 text-sm text-slate-600">
                No research gaps reported by this rules version.
              </p>
            )}
            <details className="mt-3 text-sm">
              <summary className="min-h-11 cursor-pointer py-3 font-medium">
                All ranking uncertainty ({detail.ranking.uncertainty.length})
              </summary>
              <ul className="list-disc space-y-2 pl-5 text-slate-600">
                {detail.ranking.uncertainty.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
          </section>
          <section aria-labelledby="chicago-fields-title">
            <h2 id="chicago-fields-title" className="text-xl font-semibold">
              Normalized fields & provenance
            </h2>
            <dl className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
              {Object.entries(detail.fields).map(([key, field]) => (
                <div
                  key={key}
                  className="grid gap-2 py-4 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]"
                >
                  <dt className="font-medium">{chicagoLabel(key)}</dt>
                  <dd>
                    <ChicagoEvidenceValue value={field.value} />
                    <p className="mt-1 text-xs text-slate-600">
                      {chicagoLabel(field.status)} · researched{' '}
                      {field.researchedAt ?? 'date unknown'}
                      {field.actor ? ` · ${field.actor}` : ''}
                    </p>
                    <ul className="mt-2 space-y-1 text-xs">
                      {field.sourceUrls.map((url) => (
                        <li key={url}>
                          <ChicagoSourceLink url={url} />
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <section aria-labelledby="chicago-sources-title">
            <h2 id="chicago-sources-title" className="text-xl font-semibold">
              Source evidence
            </h2>
            <ul className="mt-4 divide-y divide-slate-200">
              {detail.sources.map((source) => (
                <li key={source.id} className="py-3 text-sm">
                  {source.url ? (
                    <ChicagoSourceLink url={source.url} label={source.label ?? source.url} />
                  ) : (
                    <span>{source.label ?? 'Recorded source without a URL'}</span>
                  )}
                  <p className="mt-1 text-xs text-slate-600">
                    {chicagoLabel(source.type)} · researched {source.researchedAt ?? 'date unknown'}
                  </p>
                </li>
              ))}
            </ul>
            {!detail.sources.length && (
              <p className="mt-3 text-sm text-slate-600">No source evidence recorded.</p>
            )}
          </section>
          <section aria-labelledby="chicago-contacts-title">
            <h2 id="chicago-contacts-title" className="text-xl font-semibold">
              Contact claims
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Routing: {chicagoLabel(detail.contactability)}. A recorded contact claim does not
              establish permission to contact.
            </p>
            <ul className="mt-3 divide-y divide-slate-200">
              {detail.contactClaims.map((claim, index) => (
                <li key={index} className="py-3">
                  <ChicagoEvidenceValue value={claim} />
                </li>
              ))}
            </ul>
            {!detail.contactClaims.length && (
              <p className="mt-3 text-sm text-slate-600">No contact claims recorded.</p>
            )}
          </section>
          <section aria-labelledby="chicago-reviews-title">
            <h2 id="chicago-reviews-title" className="text-xl font-semibold">
              Conflicts, duplicates & quarantine
            </h2>
            <ul className="mt-3 divide-y divide-slate-200">
              {detail.reviews.map((review) => (
                <li key={review.id} className="py-4 text-sm">
                  <p className="font-medium">
                    {chicagoLabel(review.kind)} · {chicagoLabel(review.status)}
                  </p>
                  <p className="mt-1">{review.reason}</p>
                  <details className="mt-2">
                    <summary className="min-h-11 cursor-pointer py-3 text-slate-600">
                      Original claim · {review.id}
                    </summary>
                    <ChicagoEvidenceValue value={review.original} />
                  </details>
                </li>
              ))}
            </ul>
            {!detail.reviews.length && (
              <p className="mt-3 text-sm text-slate-600">
                No review items recorded for this venue.
              </p>
            )}
          </section>
          <section aria-labelledby="chicago-imports-title">
            <h2 id="chicago-imports-title" className="text-xl font-semibold">
              Original import records
            </h2>
            <ul className="mt-3 divide-y divide-slate-200">
              {detail.imports.map((item) => (
                <li key={item.id} className="py-4 text-sm">
                  <p className="font-medium">
                    {item.externalRecordId} · {chicagoLabel(item.processingStatus)}
                  </p>
                  <p className="mt-2 break-all text-xs text-slate-600">
                    Workbook SHA-256: {item.sourceWorkbookHash}
                  </p>
                  <details className="mt-2">
                    <summary className="min-h-11 cursor-pointer py-3">
                      Original and normalized values
                    </summary>
                    <h3 className="mb-2 font-medium">Original</h3>
                    <ChicagoEvidenceValue value={item.rawPayload} />
                    <h3 className="mb-2 mt-5 font-medium">Normalized at import</h3>
                    <ChicagoEvidenceValue value={item.normalizedPayload} />
                  </details>
                </li>
              ))}
            </ul>
            {!detail.imports.length && (
              <p className="mt-3 text-sm text-slate-600">
                No workbook import; inspect source evidence and audit receipts.
              </p>
            )}
          </section>
          <section aria-labelledby="chicago-audit-title">
            <h2 id="chicago-audit-title" className="text-xl font-semibold">
              Audit history & receipts
            </h2>
            <ol className="mt-3 divide-y divide-slate-200">
              {detail.audit.map((entry) => (
                <li key={entry.id} className="py-4 text-sm">
                  <p className="font-medium">{chicagoLabel(entry.operation)}</p>
                  <p className="mt-1 text-xs text-slate-600">
                    {entry.createdAt} · {entry.actorId} · run {entry.runId}
                  </p>
                  <details className="mt-2">
                    <summary className="min-h-11 cursor-pointer py-3">Receipt {entry.id}</summary>
                    <h3 className="mb-2 font-medium">Before</h3>
                    <ChicagoEvidenceValue value={entry.beforeState} />
                    <h3 className="mb-2 mt-4 font-medium">After</h3>
                    <ChicagoEvidenceValue value={entry.afterState} />
                    <h3 className="mb-2 mt-4 font-medium">Result</h3>
                    <ChicagoEvidenceValue value={entry.result} />
                  </details>
                </li>
              ))}
            </ol>
            {!detail.audit.length && (
              <p className="mt-3 text-sm text-slate-600">No mutation receipts recorded.</p>
            )}
          </section>
          {readOnly && (
            <p className="border-t border-slate-200 py-4 text-sm text-slate-600">
              Read-only local evidence view.
            </p>
          )}
        </>
      ) : null}
    </div>
  )
}
