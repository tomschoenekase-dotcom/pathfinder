'use client'

import { useRef, useState } from 'react'
import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import type { readCountyResearch, readCountyDiscoveries } from '@pathfinder/db'

type Leases = Awaited<ReturnType<typeof readCountyResearch>>
type Cases = Awaited<ReturnType<typeof readCountyDiscoveries>>
const control =
  'min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50'
const lines = (value: FormDataEntryValue | null) =>
  String(value ?? '')
    .split(/\r?\n/u)
    .map((v) => v.trim())
    .filter(Boolean)
const humanDate = (value: Date | string) => new Date(value).toLocaleString()
type PlanCell = { id: string; locality: string; category: string; question: string }
function storedPlan(value: unknown): { success: true; data: PlanCell[] } | { success: false } {
  if (!Array.isArray(value) || !value.length || value.length > 100) return { success: false }
  if (
    value.some(
      (cell) =>
        !cell ||
        typeof cell !== 'object' ||
        ['id', 'locality', 'category', 'question'].some(
          (key) => typeof cell[key] !== 'string' || !cell[key].trim(),
        ),
    )
  )
    return { success: false }
  return { success: true, data: value as PlanCell[] }
}

/** Uses the existing authenticated admin owner. The local fixture adapter never
 * receives these human controls and no actor/approval status comes from inputs. */
export function ProspectCountyResearchPanel({ registryHash }: { registryHash: string }) {
  const client = useTRPCClient(),
    inFlight = useRef(false)
  const [leases, setLeases] = useState<Leases | null>(null),
    [cases, setCases] = useState<Cases | null>(null)
  const [county, setCounty] = useState(''),
    [leasePage, setLeasePage] = useState(1),
    [casePage, setCasePage] = useState(1)
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [pending, setPending] = useState<{ label: string; run: () => Promise<unknown> } | null>(
    null,
  )
  async function load(lp = leasePage, cp = casePage) {
    if (county && !/^\d{5}$/u.test(county)) {
      setError('Enter a five-digit county GEOID, or leave the filter empty.')
      return
    }
    setLoading(true)
    setError('')
    setLeases(null)
    setCases(null)
    try {
      const [l, c] = await Promise.all([
        runBoundedClientRequest({
          parentSignal: new AbortController().signal,
          timeoutMs: 15000,
          request: (signal) =>
            client.admin.readCountyResearch.query(
              { ...(county ? { countyGeoid: county } : {}), page: lp, limit: 10 },
              { signal },
            ),
        }),
        runBoundedClientRequest({
          parentSignal: new AbortController().signal,
          timeoutMs: 15000,
          request: (signal) =>
            client.admin.readCountyDiscoveries.query(
              { ...(county ? { countyGeoid: county } : {}), status: 'ALL', page: cp, limit: 10 },
              { signal },
            ),
        }),
      ])
      setLeases(l)
      setCases(c)
      setLeasePage(lp)
      setCasePage(cp)
    } catch {
      setError(
        'County research controls could not be loaded. This is not an empty queue. Check the authenticated admin session and whether this operating instance has the county lease migration and matching release.',
      )
    } finally {
      setLoading(false)
    }
  }
  async function execute(action: { label: string; run: () => Promise<unknown> }) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setNotice('')
    setPending(action)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        action.run(),
        new Promise<never>((_r, reject) => {
          timer = setTimeout(() => reject(new Error('Response timeout')), 25000)
        }),
      ])
      if (
        !result ||
        typeof result !== 'object' ||
        !('receiptId' in result) ||
        typeof result.receiptId !== 'string'
      )
        throw new Error('A durable receipt is required')
      setNotice(`${action.label}. Receipt: ${result.receiptId}`)
      setPending(null)
      await load()
    } catch {
      setError(
        `The outcome of “${action.label}” is unconfirmed. Retry the identical request below, or reload to inspect current records. Do not create another request key.`,
      )
    } finally {
      clearTimeout(timer)
      inFlight.current = false
      setBusy(false)
    }
  }
  const disabled = busy || loading || Boolean(pending) || !leases || Boolean(error)
  function claim(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled) return
    const form = new FormData(event.currentTarget)
    const input = {
      idempotencyKey: crypto.randomUUID(),
      expectedRegistryHash: registryHash,
      countyGeoid: String(form.get('county')).trim(),
      scopeKind: 'WHOLE_COUNTY' as const,
      leaseSeconds: 900,
      plannedCells: [
        {
          id: 'planned-cell-1',
          locality: String(form.get('locality')).trim(),
          category: String(form.get('category')).trim(),
          question: String(form.get('question')).trim(),
        },
      ],
    }
    if (
      !/^\d{5}$/u.test(input.countyGeoid) ||
      !input.plannedCells[0]!.locality ||
      !input.plannedCells[0]!.category ||
      input.plannedCells[0]!.question.length < 12
    ) {
      setNotice(
        'Enter an exact five-digit county and a named locality, category, and research question of at least 12 characters.',
      )
      return
    }
    void execute({
      label: 'County claim saved',
      run: () => client.admin.claimCountyResearch.mutate(input),
    })
  }
  return (
    <section
      className="mt-10 min-w-0 border-t border-slate-300 pt-8"
      aria-labelledby="county-research-heading"
    >
      <h2 id="county-research-heading" className="text-2xl font-semibold">
        County research and new-site review
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
        A claim reserves one whole county; it does not start a crawler or certify completeness. New
        physical-site findings remain in the shared identity review queue until a human rejects,
        links, or admits a distinct venue.
      </p>
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void load(1, 1)
        }}
      >
        <label className="text-sm font-medium">
          County GEOID filter
          <input
            value={county}
            onChange={(event) => setCounty(event.target.value)}
            maxLength={5}
            inputMode="numeric"
            placeholder="All counties"
            className={`${control} mt-1 block w-44`}
          />
        </label>
        <button className={control} disabled={busy || loading}>
          {loading ? 'Loading county work…' : 'Load county work'}
        </button>
      </form>
      {error && (
        <p
          role="alert"
          className="mt-4 border-l-4 border-amber-600 bg-amber-50 p-4 text-sm leading-6"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mt-4 break-words border-l-4 border-emerald-700 bg-emerald-50 p-4 text-sm"
        >
          {notice}
        </p>
      )}
      {pending && (
        <div className="mt-4 border border-amber-300 p-4">
          <p className="text-sm">
            An unconfirmed request is retained with its original retry key. Keep this panel open
            until its receipt is confirmed.
          </p>
          <button
            disabled={busy}
            className={`${control} mt-3`}
            onClick={() => void execute(pending)}
          >
            Retry identical county request
          </button>
        </div>
      )}
      {leases && (
        <>
          <h3 className="mt-6 text-lg font-semibold">
            Work ownership{' '}
            <span className="font-normal text-slate-600">
              ({leases.total} counties with a recorded claim)
            </span>
          </h3>
          <p className="mt-2 text-sm text-slate-600">
            An expired or released claim is not completed coverage. Every attempt remains in the
            durable receipt history; this view shows the current generation for each county.
          </p>
          {!leases.items.length && (
            <p className="mt-4 rounded-md border border-slate-200 p-4 text-sm">
              No county claim matches this filter. This says nothing about whether the county has
              been researched exhaustively.
            </p>
          )}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {leases.items.map((lease) => {
              const plan = storedPlan(lease.plannedCells)
              const token =
                'claimToken' in lease && typeof lease.claimToken === 'string'
                  ? lease.claimToken
                  : null
              const binding = token
                ? {
                    expectedRegistryHash: registryHash,
                    countyGeoid: lease.countyGeoid,
                    claimToken: token,
                    generation: lease.generation,
                  }
                : null
              const usable = binding && lease.status === 'LEASED' && !lease.expired
              const outcome =
                lease.outcome && typeof lease.outcome === 'object' && !Array.isArray(lease.outcome)
                  ? (lease.outcome as Record<string, unknown>)
                  : {}
              return (
                <article
                  key={lease.countyGeoid}
                  className="min-w-0 rounded-lg border border-slate-300 p-4"
                >
                  <h4 className="font-semibold">
                    {lease.county.countyName}, {lease.county.state}{' '}
                    <span className="font-mono text-xs">{lease.countyGeoid}</span>
                  </h4>
                  <p className="mt-2 text-sm">
                    {lease.expired ? 'EXPIRED — completion not established' : lease.status} ·
                    generation {lease.generation}
                  </p>
                  <p className="mt-1 break-words text-xs leading-5 text-slate-600">
                    Owner: {lease.actorId} · run {lease.actorRunId}
                    <br />
                    Lease deadline: {humanDate(lease.leaseExpiresAt)}
                  </p>
                  {plan.success && (
                    <ul className="mt-3 space-y-2 text-sm">
                      {plan.data.map((cell) => (
                        <li key={cell.id}>
                          {cell.locality} · {cell.category}
                          <p className="text-slate-600">{cell.question}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                  {typeof outcome.summary === 'string' && (
                    <p className="mt-3 whitespace-pre-wrap break-words text-sm">
                      Recorded attempt: {outcome.summary}
                    </p>
                  )}
                  {typeof outcome.searchedCells === 'number' && (
                    <p className="mt-2 text-sm">
                      Searched cells: {outcome.searchedCells}; unattempted:{' '}
                      {String(outcome.unattemptedCells ?? 'not reported')}. Exhaustive coverage: not
                      certified.
                    </p>
                  )}
                  {usable && (
                    <div className="mt-4 space-y-4">
                      <button
                        className={control}
                        disabled={disabled}
                        onClick={() => {
                          const input = {
                            ...binding,
                            idempotencyKey: crypto.randomUUID(),
                            leaseSeconds: 900,
                          }
                          void execute({
                            label: 'County lease renewed',
                            run: () => client.admin.renewCountyResearch.mutate(input),
                          })
                        }}
                      >
                        Renew my claim for 15 minutes
                      </button>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault()
                          if (disabled) return
                          const data = new FormData(event.currentTarget)
                          const input = {
                            ...binding,
                            idempotencyKey: crypto.randomUUID(),
                            reason: String(data.get('reason')),
                          }
                          void execute({
                            label: 'Incomplete county claim released',
                            run: () => client.admin.releaseCountyResearch.mutate(input),
                          })
                        }}
                      >
                        <label className="block text-sm">
                          Release reason
                          <textarea
                            name="reason"
                            required
                            minLength={12}
                            maxLength={2000}
                            className={`${control} mt-1 block w-full`}
                          />
                        </label>
                        <button className={`${control} mt-2`} disabled={disabled}>
                          Release incomplete claim
                        </button>
                      </form>
                      {plan.success && (
                        <details className="border-t border-slate-200 pt-3">
                          <summary className="min-h-11 cursor-pointer text-sm font-medium">
                            Record attempted coverage and close my claim
                          </summary>
                          <form
                            onSubmit={(event) => {
                              event.preventDefault()
                              if (disabled) return
                              const data = new FormData(event.currentTarget)
                              const input = {
                                ...binding,
                                idempotencyKey: crypto.randomUUID(),
                                summary: String(data.get('summary')),
                                cells: plan.data.map((cell) => ({
                                  id: cell.id,
                                  status: String(data.get(`${cell.id}:status`)) as
                                    | 'NOT_ATTEMPTED'
                                    | 'PARTIAL'
                                    | 'SEARCHED_NO_RESULTS'
                                    | 'SEARCHED_WITH_RESULTS',
                                  sourceUrls: lines(data.get(`${cell.id}:sources`)),
                                  queries: lines(data.get(`${cell.id}:queries`)),
                                  findingReceiptIds: lines(data.get(`${cell.id}:receipts`)),
                                  note: String(data.get(`${cell.id}:note`)),
                                })),
                              }
                              void execute({
                                label:
                                  'County attempt recorded without an exhaustive-coverage claim',
                                run: () => client.admin.completeCountyResearch.mutate(input),
                              })
                            }}
                          >
                            <label className="block text-sm">
                              Attempt summary
                              <textarea
                                name="summary"
                                required
                                minLength={12}
                                maxLength={2000}
                                className={`${control} mt-1 block w-full`}
                              />
                            </label>
                            {plan.data.map((cell) => (
                              <fieldset key={cell.id} className="mt-4 border border-slate-200 p-3">
                                <legend className="px-1 text-sm font-medium">
                                  {cell.locality} · {cell.category}
                                </legend>
                                <label className="block text-sm">
                                  Actual status
                                  <select
                                    name={`${cell.id}:status`}
                                    className={`${control} mt-1 block max-w-full`}
                                    defaultValue="NOT_ATTEMPTED"
                                  >
                                    <option value="NOT_ATTEMPTED">Not attempted</option>
                                    <option value="PARTIAL">Partly attempted</option>
                                    <option value="SEARCHED_NO_RESULTS">
                                      Searched — no findings
                                    </option>
                                    <option value="SEARCHED_WITH_RESULTS">
                                      Searched — durable findings
                                    </option>
                                  </select>
                                </label>
                                {[
                                  ['sources', 'Source URLs attempted, one per line'],
                                  ['queries', 'Search queries attempted, one per line'],
                                  ['receipts', 'Finding receipt IDs, one per line'],
                                ].map(([key, label]) => (
                                  <label key={key} className="mt-3 block text-sm">
                                    {label}
                                    <textarea
                                      name={`${cell.id}:${key}`}
                                      className={`${control} mt-1 block w-full`}
                                    />
                                  </label>
                                ))}
                                <label className="mt-3 block text-sm">
                                  What was actually attempted
                                  <textarea
                                    name={`${cell.id}:note`}
                                    required
                                    minLength={12}
                                    maxLength={2000}
                                    className={`${control} mt-1 block w-full`}
                                  />
                                </label>
                              </fieldset>
                            ))}
                            <button className={`${control} mt-3`} disabled={disabled}>
                              Save recorded attempt
                            </button>
                          </form>
                        </details>
                      )}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
          <nav className="mt-4 flex flex-wrap items-center gap-3" aria-label="County claim pages">
            <button
              className={control}
              disabled={busy || loading || leasePage <= 1}
              onClick={() => void load(leasePage - 1, casePage)}
            >
              Previous claims
            </button>
            <span className="text-sm">Claim page {leases.page}</span>
            <button
              className={control}
              disabled={busy || loading || !leases.hasMore}
              onClick={() => void load(leasePage + 1, casePage)}
            >
              Next claims
            </button>
          </nav>
          <details className="mt-6 rounded-lg border border-slate-300 p-4">
            <summary className="min-h-11 cursor-pointer font-medium">
              Reserve one county for a bounded research attempt
            </summary>
            <form onSubmit={claim} className="mt-3 grid gap-4 sm:grid-cols-2">
              {[
                ['county', 'Exact five-digit county GEOID', 5, 5],
                ['locality', 'Planned locality or area', 1, 200],
                ['category', 'Planned venue category', 1, 200],
                ['question', 'Specific research question', 12, 1000],
              ].map(([key, label, min, max]) => (
                <label key={String(key)} className="text-sm font-medium">
                  {label}
                  <input
                    name={String(key)}
                    required
                    minLength={Number(min)}
                    maxLength={Number(max)}
                    pattern={key === 'county' ? '[0-9]{5}' : undefined}
                    className={`${control} mt-1 block w-full`}
                  />
                </label>
              ))}
              <p className="text-sm leading-6 text-slate-600 sm:col-span-2">
                This reserves the whole county for 15 minutes while recording one planned work cell.
                It is not a subcounty grant and does not launch research.
              </p>
              <button className={`${control} justify-self-start`} disabled={disabled}>
                Acquire county claim
              </button>
            </form>
          </details>
        </>
      )}
      {cases && (
        <>
          <h3 className="mt-8 text-lg font-semibold">
            New physical-site identity cases ({cases.total})
          </h3>
          {!cases.items.length && (
            <p className="mt-3 text-sm">
              No discovery review matches this filter. No new venues were inferred or created by
              this read.
            </p>
          )}
          <div className="mt-4 space-y-4">
            {cases.items.map((review) => (
              <article
                key={`${review.reviewId}:${review.revision}`}
                className="min-w-0 rounded-lg border border-slate-300 p-4"
              >
                <h4 className="font-semibold">{review.candidate.name}</h4>
                <p className="mt-2 text-sm">
                  {review.status} · county {review.countyGeoid} · {review.observationCount} retained
                  observations · revision {review.revision}
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-600">{review.reason}</p>
                {review.observationsTruncated && (
                  <p role="alert" className="mt-3 text-sm text-amber-900">
                    This case has more than 50 observations. Do not decide from this truncated view;
                    the full evidence must be reviewed through the native owner.
                  </p>
                )}
                <div className="mt-3 space-y-3">
                  {review.observations.map((observation) => (
                    <details key={observation.receiptId} className="border border-slate-200 p-3">
                      <summary className="min-h-11 cursor-pointer break-words text-sm font-medium">
                        {observation.candidate.name} ·{' '}
                        {observation.candidate.physicalEvidence.physicalAddress}
                      </summary>
                      <p className="mt-2 break-words text-xs">
                        Observation receipt: {observation.receiptId}
                        <br />
                        Recorded by {observation.actorId} ({observation.actorType}) ·{' '}
                        {humanDate(observation.at)}
                      </p>
                      {[
                        [
                          'Site identity',
                          observation.candidate.website,
                          observation.candidate.websiteQuote,
                        ],
                        [
                          'Physical location',
                          observation.candidate.physicalEvidence.addressSourceUrl,
                          observation.candidate.physicalEvidence.addressQuote,
                        ],
                        [
                          'County evidence',
                          observation.candidate.physicalEvidence.countySourceUrl,
                          observation.candidate.physicalEvidence.countyQuote,
                        ],
                      ].map(([label, url, quote]) => (
                        <div key={label} className="mt-3">
                          <a
                            className="inline-flex min-h-11 items-center text-sm text-emerald-800 underline"
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {label}
                          </a>
                          <p className="whitespace-pre-wrap break-words text-sm leading-6">
                            {quote}
                          </p>
                        </div>
                      ))}
                      <p className="mt-3 text-xs">
                        Public contact routes remain source observations, not permission or
                        deliverability checks.
                      </p>
                    </details>
                  ))}
                </div>
                <p className="mt-3 text-sm">
                  Current identity candidates: {review.identityMatches.length}. A shared parent
                  domain is not itself a duplicate.
                </p>
                {review.status === 'OPEN' && !review.observationsTruncated && (
                  <form
                    className="mt-4 space-y-4"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (disabled) return
                      const data = new FormData(event.currentTarget),
                        decision = String(data.get('decision')) as
                          | 'REJECT'
                          | 'LINK_EXISTING'
                          | 'CREATE_DISTINCT',
                        existingVenueId = String(data.get('existingVenueId') ?? ''),
                        organizationId = String(data.get('organizationId') ?? '')
                      const input = {
                        idempotencyKey: crypto.randomUUID(),
                        expectedRegistryHash: registryHash,
                        reviewId: review.reviewId,
                        expectedRevision: review.revision,
                        decision,
                        reason: String(data.get('reason')),
                        observationReceiptId: String(data.get('observation')),
                        ...(existingVenueId ? { existingVenueId } : {}),
                        ...(organizationId ? { organizationId } : {}),
                        acknowledgedIdentityMatchIds: data.getAll('identityMatch').map(String),
                      }
                      void execute({
                        label: 'Discovery identity decision saved',
                        run: () => client.admin.decideCountyDiscovery.mutate(input),
                      })
                    }}
                  >
                    <label className="block text-sm">
                      Source observation for this decision
                      <select
                        name="observation"
                        required
                        className={`${control} mt-1 block max-w-full`}
                      >
                        {review.observations.map((o) => (
                          <option key={o.receiptId} value={o.receiptId}>
                            {o.candidate.name} — {o.receiptId}
                          </option>
                        ))}
                      </select>
                    </label>
                    <fieldset className="border border-slate-200 p-3">
                      <legend className="px-1 text-sm">
                        Native identity matches reviewed as distinct when creating a venue
                      </legend>
                      {review.identityMatches.map((match) => (
                        <label
                          key={match.venueId}
                          className="flex min-h-11 items-start gap-3 py-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            name="identityMatch"
                            value={match.venueId}
                            className="mt-1"
                          />
                          <span className="min-w-0 break-words">
                            {match.name} · {match.venueId}
                            <br />
                            Signals: {match.reasons.join(', ')}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                    <label className="block text-sm">
                      Decision
                      <select
                        name="decision"
                        className={`${control} mt-1 block max-w-full`}
                        defaultValue="REJECT"
                      >
                        <option value="REJECT">Reject this finding</option>
                        <option value="LINK_EXISTING">
                          Link evidence to an existing native venue
                        </option>
                        <option value="CREATE_DISTINCT">Admit a distinct physical venue</option>
                      </select>
                    </label>
                    <label className="block text-sm">
                      Existing native venue ID (required only for linking)
                      <input
                        name="existingVenueId"
                        maxLength={191}
                        className={`${control} mt-1 block w-full`}
                      />
                    </label>
                    <label className="block text-sm">
                      Existing parent organization ID (optional when admitting a distinct branch)
                      <input
                        name="organizationId"
                        maxLength={191}
                        className={`${control} mt-1 block w-full`}
                      />
                    </label>
                    <label className="block text-sm">
                      Identity decision reason
                      <textarea
                        name="reason"
                        required
                        minLength={30}
                        maxLength={2000}
                        className={`${control} mt-1 block w-full`}
                      />
                    </label>
                    <label className="flex min-h-11 items-start gap-3 py-2 text-sm">
                      <input required type="checkbox" className="mt-1" />
                      <span>
                        I reviewed the physical site and all retained observations. This is not an
                        automatic merge or permission to contact anyone.
                      </span>
                    </label>
                    <button
                      className={`${control} border-emerald-800 text-emerald-900`}
                      disabled={disabled}
                    >
                      Record human identity decision
                    </button>
                  </form>
                )}
                {review.status === 'RESOLVED' &&
                  review.decision &&
                  typeof review.decision === 'object' &&
                  !Array.isArray(review.decision) && (
                    <p className="mt-3 whitespace-pre-wrap break-words text-sm">
                      Recorded decision:{' '}
                      {String((review.decision as Record<string, unknown>).decision ?? 'Resolved')}
                      <br />
                      {String((review.decision as Record<string, unknown>).reason ?? '')}
                    </p>
                  )}
              </article>
            ))}
          </div>
          <nav
            className="mt-4 flex flex-wrap items-center gap-3"
            aria-label="Discovery review pages"
          >
            <button
              className={control}
              disabled={busy || loading || casePage <= 1}
              onClick={() => void load(leasePage, casePage - 1)}
            >
              Previous reviews
            </button>
            <span className="text-sm">Review page {cases.page}</span>
            <button
              className={control}
              disabled={busy || loading || !cases.hasMore}
              onClick={() => void load(leasePage, casePage + 1)}
            >
              Next reviews
            </button>
          </nav>
        </>
      )}
    </section>
  )
}
