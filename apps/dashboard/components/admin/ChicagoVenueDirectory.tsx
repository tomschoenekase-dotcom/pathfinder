'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  chicagoDirectoryInput,
  type ChicagoDirectoryInput,
  type ChicagoDirectoryResult,
  type ChicagoHealth,
  type ChicagoVenueDetail as VenueDetail,
} from '@pathfinder/api/chicago-intelligence-contract'
import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import {
  CHICAGO_SORT_FIELDS,
  chicagoDirectoryParams,
  chicagoLabel,
  readChicagoDirectoryState,
  type ChicagoDirectoryState,
} from '../../lib/chicago-directory-state'
import { ChicagoEvidenceValue, ChicagoVenueDetail, chicagoControl } from './ChicagoVenueDetail'
import { ChicagoVenueActions, type ChicagoMutationTransport } from './ChicagoVenueActions'

type SavedView = { name: string; query: string }
const SAVED_KEY = 'torchiko.chicago-venue-views.v1'
const selectClass = `${chicagoControl} w-full min-w-0`
const rankingStates = [
  'evidence-backed',
  'provisional-heuristic',
  'needs-research',
  'excluded',
  'intentionally-unranked',
]

function toInput(state: ChicagoDirectoryState): ChicagoDirectoryInput {
  return chicagoDirectoryInput.parse({
    geography: state.geography,
    lifecycle: state.lifecycle,
    page: state.page,
    pageSize: state.pageSize,
    sorts: state.sorts,
    ...(state.query.trim() ? { query: state.query.trim().slice(0, 200) } : {}),
    ...(state.category ? { category: state.category } : {}),
    ...(state.city ? { city: state.city } : {}),
    ...(['IL', 'IN', 'WI'].includes(state.state) ? { state: state.state } : {}),
    ...(rankingStates.includes(state.rankingState) ? { rankingState: state.rankingState } : {}),
    ...(['verified', 'source-only', 'missing', 'suppressed'].includes(state.contactability)
      ? { contactability: state.contactability }
      : {}),
    ...(state.stale === undefined ? {} : { stale: state.stale }),
  })
}

export function ChicagoVenueDirectory({
  loadPage,
  loadDetail,
  loadHealth,
  act,
  territoryId,
  directoryHref = '/admin/prospects',
  readOnly = false,
}: {
  loadPage?:
    | ((input: ChicagoDirectoryInput, signal: AbortSignal) => Promise<ChicagoDirectoryResult>)
    | undefined
  loadDetail?: ((venueId: string, signal: AbortSignal) => Promise<VenueDetail>) | undefined
  loadHealth?: ((signal: AbortSignal) => Promise<ChicagoHealth>) | undefined
  act?: ChicagoMutationTransport | undefined
  territoryId?: string | undefined
  directoryHref?: string | undefined
  readOnly?: boolean | undefined
} = {}) {
  const client = useTRPCClient()
  const pathname = usePathname()
  const params = useSearchParams()
  const [state, setState] = useState(() =>
    readChicagoDirectoryState(new URLSearchParams(params.toString())),
  )
  const [search, setSearch] = useState(state.query)
  const [venueId, setVenueId] = useState<string | null>(params.get('venue'))
  const [result, setResult] = useState<ChicagoDirectoryResult | null>(null)
  const [health, setHealth] = useState<ChicagoHealth | null>(null)
  const [healthError, setHealthError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [healthOpen, setHealthOpen] = useState(false)
  const [savedViews, setSavedViews] = useState<SavedView[]>([])
  const [viewName, setViewName] = useState('')
  const [notice, setNotice] = useState('')
  const [neighborLoading, setNeighborLoading] = useState(false)
  const scroll = useRef(0)
  const neighborAbort = useRef<AbortController | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const queryKey = useMemo(() => JSON.stringify(toInput(state)), [state])

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]')
      if (Array.isArray(saved))
        setSavedViews(
          saved
            .filter(
              (item): item is SavedView =>
                typeof item?.name === 'string' && typeof item?.query === 'string',
            )
            .slice(0, 20),
        )
    } catch {
      /* Optional browser preferences never block the directory. */
    }
    const restore = () => {
      neighborAbort.current?.abort()
      setNeighborLoading(false)
      const current = new URLSearchParams(window.location.search)
      const next = readChicagoDirectoryState(current)
      setState(next)
      setSearch(next.query)
      setVenueId(current.get('venue'))
    }
    window.addEventListener('popstate', restore)
    return () => {
      window.removeEventListener('popstate', restore)
      neighborAbort.current?.abort()
    }
  }, [])
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setState((current) =>
          current.query === search ? current : { ...current, query: search, page: 1 },
        ),
      250,
    )
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    window.history.replaceState(
      window.history.state,
      '',
      `${pathname}?${chicagoDirectoryParams(state, venueId)}`,
    )
  }, [state, venueId, pathname])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    const input = JSON.parse(queryKey) as ChicagoDirectoryInput
    void runBoundedClientRequest({
      parentSignal: controller.signal,
      timeoutMs: 15_000,
      request: (signal) =>
        loadPage
          ? loadPage(input, signal)
          : client.admin.listChicagoVenues.query(input, { signal }),
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setResult(value)
          if (value.total > 0 && value.items.length === 0 && (input.page ?? 1) > 1)
            setState((current) => ({
              ...current,
              page: Math.max(1, Math.ceil(value.total / current.pageSize)),
            }))
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [client, queryKey, retry, loadPage])
  useEffect(() => {
    const controller = new AbortController()
    setHealthError(false)
    void runBoundedClientRequest({
      parentSignal: controller.signal,
      timeoutMs: 15_000,
      request: (signal) =>
        loadHealth ? loadHealth(signal) : client.admin.getChicagoHealth.query({}, { signal }),
    })
      .then((value) => {
        if (!controller.signal.aborted) setHealth(value)
      })
      .catch(() => {
        if (!controller.signal.aborted) setHealthError(true)
      })
    return () => controller.abort()
  }, [client, retry, loadHealth])
  function change<K extends keyof ChicagoDirectoryState>(key: K, value: ChicagoDirectoryState[K]) {
    setState((current) => ({ ...current, [key]: value, page: 1 }))
  }
  function openVenue(id: string) {
    if (!venueId) scroll.current = window.scrollY
    setVenueId(id)
    window.history.pushState(
      window.history.state,
      '',
      `${pathname}?${chicagoDirectoryParams(state, id)}`,
    )
    window.scrollTo({ top: 0, behavior: 'instant' })
  }
  function closeVenue() {
    neighborAbort.current?.abort()
    setNeighborLoading(false)
    setVenueId(null)
    window.history.replaceState(
      window.history.state,
      '',
      `${pathname}?${chicagoDirectoryParams(state)}`,
    )
    requestAnimationFrame(() => {
      window.scrollTo({ top: scroll.current, behavior: 'instant' })
      document.getElementById(`chicago-venue-${venueId}`)?.focus({ preventScroll: true })
    })
  }
  async function navigateNeighbor(id: string) {
    if (!id.startsWith('page:')) return openVenue(id)
    if (neighborLoading) return
    setNeighborLoading(true)
    const nextState = { ...state, page: state.page + (id === 'page:next' ? 1 : -1) }
    const controller = new AbortController()
    neighborAbort.current = controller
    try {
      const input = toInput(nextState)
      const next = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: 15_000,
        request: (signal) =>
          loadPage
            ? loadPage(input, signal)
            : client.admin.listChicagoVenues.query(input, { signal }),
      })
      const target = id === 'page:next' ? next.items[0] : next.items[next.items.length - 1]
      if (target && !controller.signal.aborted) {
        setState(nextState)
        setResult(next)
        openVenue(target.venueId)
      }
    } catch {
      if (!controller.signal.aborted)
        setNotice(
          'Adjacent results could not be loaded. Your current venue and filters are retained; try again.',
        )
    } finally {
      if (neighborAbort.current === controller) {
        neighborAbort.current = null
        setNeighborLoading(false)
      }
    }
  }
  function saveView() {
    if (!viewName.trim()) {
      setNotice('Name this view before saving it.')
      return
    }
    const next = [
      ...savedViews.filter((view) => view.name !== viewName.trim()),
      { name: viewName.trim(), query: chicagoDirectoryParams({ ...state, page: 1 }).toString() },
    ].slice(-20)
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(next))
      setSavedViews(next)
      setViewName('')
      setNotice('View saved in this browser.')
    } catch {
      setNotice(
        'Browser storage is unavailable. The current view remains in the URL; bookmark it to keep the filters.',
      )
    }
  }
  const index = result?.items.findIndex((item) => item.venueId === venueId) ?? -1
  const previousId =
    index < 0
      ? undefined
      : index > 0
        ? result?.items[index - 1]?.venueId
        : state.page > 1
          ? 'page:previous'
          : undefined
  const nextId =
    index < 0
      ? undefined
      : index < (result?.items.length ?? 0) - 1
        ? result?.items[index + 1]?.venueId
        : result && state.page * state.pageSize < result.total
          ? 'page:next'
          : undefined
  const coverage = result?.coverage ?? health?.coverage
  return (
    <div className="min-w-0 text-slate-900 selection:bg-sky-100 [overflow-wrap:anywhere]">
      {venueId ? (
        <>
          <ChicagoVenueDetail
            key={venueId}
            venueId={venueId}
            onBack={closeVenue}
            previousId={neighborLoading ? undefined : previousId}
            nextId={neighborLoading ? undefined : nextId}
            onNavigate={(id) => {
              void navigateNeighbor(id)
            }}
            loadDetail={loadDetail}
            onMutation={() => setRetry((value) => value + 1)}
            act={act}
            organizationHref={directoryHref}
            readOnly={readOnly}
          />
          {neighborLoading && (
            <p role="status" className="py-4 text-sm">
              Loading adjacent results…
            </p>
          )}
        </>
      ) : (
        <>
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-300 pb-5">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Chicago venues</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                The complete operating region, with evidence and unknowns in view. Chicago proper is
                a slice of the established IL / IN / WI territory.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link className={chicagoControl} href={`${directoryHref}?scope=all`}>
                All CRM organizations →
              </Link>
              <button
                className={chicagoControl}
                aria-expanded={healthOpen}
                onClick={() => setHealthOpen((value) => !value)}
              >
                Data health & imports
              </button>
            </div>
          </header>
          {coverage && (
            <dl className="flex flex-wrap gap-x-7 gap-y-3 border-b border-slate-200 py-4 text-sm tabular-nums">
              {[
                ['Operating set', coverage.total],
                ['Chicago proper', coverage.proper],
                ['Outside city', coverage.metro],
                ['Ranked', coverage.ranked],
                ['Needs research', coverage.needsResearch],
                ['Stale / undated', coverage.stale],
                ['Conflicted', coverage.conflicted],
                ['Quarantine', coverage.quarantined],
              ].map(([title, value]) => (
                <div key={title} className="flex gap-2">
                  <dt className="text-slate-600">{title}</dt>
                  <dd className="font-semibold">
                    {typeof value === 'number' ? value.toLocaleString() : value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {healthOpen && (
            <section className="border-b border-slate-300 py-6" aria-label="Chicago data health">
              {healthError ? (
                <div role="alert">
                  <p className="text-sm">Data health could not be loaded.</p>
                  <button
                    className={`${chicagoControl} mt-3`}
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    Retry data health
                  </button>
                </div>
              ) : health ? (
                <ChicagoDataHealth
                  health={health}
                  onGap={(city, category) => {
                    setState((current) => ({ ...current, city, category, page: 1 }))
                    setHealthOpen(false)
                  }}
                />
              ) : (
                <p role="status">Loading data health…</p>
              )}
            </section>
          )}
          {!readOnly && (
            <ChicagoVenueActions
              territoryId={territoryId}
              act={act}
              onSuccess={() => setRetry((value) => value + 1)}
            />
          )}
          <section className="space-y-4 py-6" aria-label="Chicago directory filters">
            <label className="block text-sm font-medium">
              Search all Chicago venues
              <input
                ref={searchInput}
                className={`${selectClass} mt-2`}
                type="search"
                maxLength={200}
                placeholder="Venue, operator, or location"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <FilterSelect
                label="Record lifecycle"
                value={state.lifecycle}
                onChange={(value) =>
                  change('lifecycle', value as ChicagoDirectoryState['lifecycle'])
                }
                options={[
                  ['active', 'Active venues'],
                  ['archived', 'Archived venues'],
                  ['all', 'Active and archived'],
                ]}
              />
              <FilterSelect
                label="Geography"
                value={state.geography}
                onChange={(value) =>
                  change('geography', value as ChicagoDirectoryState['geography'])
                }
                options={[
                  ['all', 'Full operating region'],
                  ['chicago-proper', 'Chicago proper'],
                  ['metro', 'Outside Chicago proper'],
                ]}
              />
              <FilterSelect
                label="Category"
                value={state.category}
                onChange={(value) => change('category', value)}
                options={[
                  ['', 'All categories'],
                  ...(result?.facets.categories ?? []).map(
                    (value) => [value, value] as [string, string],
                  ),
                ]}
              />
              <FilterSelect
                label="City"
                value={state.city}
                onChange={(value) => change('city', value)}
                options={[
                  ['', 'All cities'],
                  ...(result?.facets.cities ?? []).map(
                    (value) => [value, value] as [string, string],
                  ),
                ]}
              />
              <FilterSelect
                label="State"
                value={state.state}
                onChange={(value) => change('state', value)}
                options={[
                  ['', 'All states'],
                  ['IL', 'Illinois'],
                  ['IN', 'Indiana'],
                  ['WI', 'Wisconsin'],
                ]}
              />
              <FilterSelect
                label="Ranking evidence"
                value={state.rankingState}
                onChange={(value) => change('rankingState', value)}
                options={[
                  ['', 'All ranking states'],
                  ...rankingStates.map((value) => [value, chicagoLabel(value)] as [string, string]),
                ]}
              />
              <FilterSelect
                label="Contactability"
                value={state.contactability}
                onChange={(value) => change('contactability', value)}
                options={[
                  ['', 'All routing states'],
                  ...['verified', 'source-only', 'missing', 'suppressed'].map(
                    (value) => [value, chicagoLabel(value)] as [string, string],
                  ),
                ]}
              />
              <FilterSelect
                label="Freshness"
                value={state.stale === undefined ? '' : String(state.stale)}
                onChange={(value) => change('stale', value === '' ? undefined : value === 'true')}
                options={[
                  ['', 'All freshness states'],
                  ['true', 'Stale or undated'],
                  ['false', 'Current evidence'],
                ]}
              />
              <div className="flex items-end">
                <button
                  className={`${chicagoControl} w-full`}
                  onClick={() => {
                    setState(readChicagoDirectoryState(new URLSearchParams()))
                    setSearch('')
                    searchInput.current?.focus()
                  }}
                >
                  Reset filters
                </button>
              </div>
            </div>
            <details className="border-y border-slate-200">
              <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
                Sort & saved views{' '}
                <span className="font-normal text-slate-600">
                  ·{' '}
                  {state.sorts
                    .map(
                      (sort) =>
                        `${chicagoLabel(sort.field)} ${sort.direction === 'desc' ? '↓' : '↑'}`,
                    )
                    .join(', ')}
                </span>
              </summary>
              <div className="space-y-4 pb-4">
                {state.sorts.map((sort, index) => (
                  <div key={index} className="flex flex-wrap items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <FilterSelect
                        label={`Sort ${index + 1}`}
                        value={sort.field}
                        options={CHICAGO_SORT_FIELDS.map((field) => [field, chicagoLabel(field)])}
                        onChange={(value) =>
                          change(
                            'sorts',
                            state.sorts
                              .map((item, offset) =>
                                offset === index
                                  ? { ...item, field: value as typeof sort.field }
                                  : item,
                              )
                              .filter(
                                (item, offset, all) =>
                                  all.findIndex((candidate) => candidate.field === item.field) ===
                                  offset,
                              ),
                          )
                        }
                      />
                    </div>
                    <div>
                      <FilterSelect
                        label={`Direction ${index + 1}`}
                        value={sort.direction}
                        options={[
                          ['desc', 'High → low'],
                          ['asc', 'Low → high'],
                        ]}
                        onChange={(value) =>
                          change(
                            'sorts',
                            state.sorts.map((item, offset) =>
                              offset === index
                                ? { ...item, direction: value as 'asc' | 'desc' }
                                : item,
                            ),
                          )
                        }
                      />
                    </div>
                    {state.sorts.length > 1 && (
                      <button
                        className={chicagoControl}
                        aria-label={`Remove sort ${index + 1}`}
                        onClick={() =>
                          change(
                            'sorts',
                            state.sorts.filter((_, offset) => offset !== index),
                          )
                        }
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    className={chicagoControl}
                    disabled={state.sorts.length >= 3}
                    onClick={() => {
                      const field = CHICAGO_SORT_FIELDS.find(
                        (field) => !state.sorts.some((sort) => sort.field === field),
                      )
                      if (field) change('sorts', [...state.sorts, { field, direction: 'desc' }])
                    }}
                  >
                    Add sort
                  </button>
                  <p className="text-xs text-slate-600">
                    Sorts apply across all results. Unknowns stay last in either direction; venue ID
                    resolves ties.
                  </p>
                </div>
                <div className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-2">
                  <label className="text-sm font-medium">
                    View name
                    <input
                      className={`${selectClass} mt-1`}
                      maxLength={80}
                      value={viewName}
                      onChange={(event) => setViewName(event.target.value)}
                      placeholder="e.g. Chicago museums to research"
                    />
                  </label>
                  <div className="flex items-end">
                    <button className={chicagoControl} onClick={saveView}>
                      Save current view in this browser
                    </button>
                  </div>
                </div>
                {savedViews.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {savedViews.map((view) => (
                      <button
                        key={view.name}
                        className={chicagoControl}
                        onClick={() => {
                          const restored = readChicagoDirectoryState(
                            new URLSearchParams(view.query),
                          )
                          setState(restored)
                          setSearch(restored.query)
                          setNotice(`Loaded ${view.name}.`)
                        }}
                      >
                        {view.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </section>
          {failed ? (
            <div role="alert" className="border border-rose-300 bg-rose-50 p-5">
              <h2 className="font-semibold">Chicago venues could not be loaded</h2>
              <p className="mt-2 text-sm">
                Filters are retained. Retry to recover the current result set.
              </p>
              <button
                className={`${chicagoControl} mt-3`}
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry directory
              </button>
            </div>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p role="status" className="text-sm text-slate-600">
                  {loading
                    ? 'Loading Chicago venues…'
                    : `${result?.total.toLocaleString() ?? 0} venues match this view`}
                </p>
                <p className="text-xs text-slate-600">
                  Scores / 100 · Unknown ≠ 0 · open a venue for evidence
                </p>
              </div>
              <div
                className="max-w-full overflow-x-auto border-y border-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700"
                role="region"
                aria-label="Chicago venue table; scroll horizontally for all dimensions"
                tabIndex={0}
                aria-busy={loading}
              >
                <table className="w-full min-w-[1280px] table-fixed border-collapse text-left text-sm">
                  <caption className="sr-only">
                    Chicago operating market: venue identity, separate ranking dimensions,
                    relationship and evidence.
                  </caption>
                  <thead className="bg-slate-100 text-xs text-slate-700">
                    <tr>
                      {[
                        ['name', 'Venue / geography'],
                        ['category', 'Category'],
                        ['productFit', 'Product fit'],
                        ['attainability', 'Attainability'],
                        ['contactability', 'Contactability'],
                        ['evidenceQuality', 'Evidence'],
                        ['completeness', 'Complete'],
                        ['researchPriority', 'Research priority'],
                        ['', 'Relationship / freshness'],
                      ].map(([field, title]) => {
                        const sort = state.sorts.find((item) => item.field === field)
                        return (
                          <th
                            key={title}
                            scope="col"
                            className={`px-3 py-2 ${field === 'name' ? 'z-10 w-[260px] bg-slate-100 sm:sticky sm:left-0' : field === 'category' ? 'w-[160px]' : field ? 'w-[110px]' : 'w-[200px]'}`}
                            aria-sort={
                              state.sorts[0]?.field === field
                                ? sort?.direction === 'asc'
                                  ? 'ascending'
                                  : 'descending'
                                : undefined
                            }
                          >
                            {field ? (
                              <button
                                className="min-h-11 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700"
                                onClick={() =>
                                  change(
                                    'sorts',
                                    [
                                      {
                                        field: field as (typeof state.sorts)[number]['field'],
                                        direction:
                                          sort?.direction === 'desc'
                                            ? ('asc' as const)
                                            : ('desc' as const),
                                      },
                                      ...state.sorts.filter((item) => item.field !== field),
                                    ].slice(0, 3),
                                  )
                                }
                              >
                                {title}
                                {sort
                                  ? ` ${sort.direction === 'desc' ? '↓' : '↑'}${state.sorts.findIndex((item) => item.field === field) + 1}`
                                  : ''}
                              </button>
                            ) : (
                              title
                            )}
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {!loading &&
                      result?.items.map((item) => (
                        <tr key={item.venueId} className="group align-top hover:bg-slate-50">
                          <th
                            scope="row"
                            className="z-10 max-w-[300px] bg-white px-3 py-3 font-normal group-hover:bg-slate-50 sm:sticky sm:left-0"
                          >
                            <button
                              id={`chicago-venue-${item.venueId}`}
                              onClick={() => openVenue(item.venueId)}
                              className="min-h-11 text-left font-semibold text-sky-800 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700"
                            >
                              {item.name}
                            </button>
                            <p className="mt-1 text-xs text-slate-600">
                              {[item.city, item.state].filter(Boolean).join(', ') ||
                                'Location unknown'}
                            </p>
                            {item.organizationName !== item.name && (
                              <p className="mt-1 text-xs text-slate-600">{item.organizationName}</p>
                            )}
                            <p className="mt-1 text-xs text-slate-600">
                              {chicagoLabel(item.ranking.state)}
                            </p>
                          </th>
                          <td className="max-w-[150px] px-3 py-4 text-xs leading-5">
                            {item.category ?? 'Unknown'}
                          </td>
                          {(
                            [
                              'productFit',
                              'attainability',
                              'contactability',
                              'evidenceQuality',
                              'completeness',
                              'researchPriority',
                            ] as const
                          ).map((key) => (
                            <td key={key} className="px-3 py-4 tabular-nums">
                              <span
                                className={
                                  item.ranking[key].value === null
                                    ? 'text-xs text-slate-600'
                                    : 'font-medium'
                                }
                              >
                                {item.ranking[key].value ?? 'Unknown'}
                              </span>
                              <p className="mt-1 text-[11px] leading-5 text-slate-600">
                                {key === 'contactability'
                                  ? chicagoLabel(item.contactability)
                                  : `${Math.round(item.ranking[key].coverage * 100)}% known`}
                              </p>
                            </td>
                          ))}
                          <td className="px-3 py-4 text-xs leading-5">
                            {chicagoLabel(item.relationshipState)}
                            <p className="text-slate-600">
                              {item.stale ? 'Stale / undated' : 'Current evidence'}
                            </p>
                            <p className="text-slate-600">
                              {chicagoLabel(item.confidence)} confidence
                            </p>
                            {item.reviewCount > 0 && (
                              <p className="font-medium text-amber-800">
                                {item.reviewCount} review items
                              </p>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {loading && (
                  <div className="px-4 py-14 text-sm text-slate-600">
                    Reading the full-market result set…
                  </div>
                )}
              </div>
              {!loading && result?.total === 0 && (
                <div className="border-b border-slate-300 py-10">
                  <h2 className="font-semibold">No venues match these filters</h2>
                  <p className="mt-2 text-sm text-slate-600">
                    Try a broader geography, category, or search. Unknown contacts and scores remain
                    available in the full market view.
                  </p>
                  <button
                    className={`${chicagoControl} mt-4`}
                    onClick={() => {
                      setState(readChicagoDirectoryState(new URLSearchParams()))
                      setSearch('')
                    }}
                  >
                    Show full Chicago operating set
                  </button>
                </div>
              )}
              <nav
                aria-label="Chicago pagination"
                className="flex flex-wrap items-center justify-between gap-4 py-5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className={chicagoControl}
                    disabled={loading || state.page <= 1}
                    onClick={() => setState((value) => ({ ...value, page: value.page - 1 }))}
                  >
                    ← Previous page
                  </button>
                  <span className="px-2 text-sm tabular-nums">
                    Page {state.page} of{' '}
                    {Math.max(1, Math.ceil((result?.total ?? 0) / state.pageSize))}
                  </span>
                  <button
                    className={chicagoControl}
                    disabled={loading || !result || state.page * state.pageSize >= result.total}
                    onClick={() => setState((value) => ({ ...value, page: value.page + 1 }))}
                  >
                    Next page →
                  </button>
                </div>
                <FilterSelect
                  label="Rows per page"
                  value={String(state.pageSize)}
                  options={['25', '50', '100'].map((value) => [value, value])}
                  onChange={(value) => change('pageSize', Number(value))}
                />
              </nav>
            </>
          )}
        </>
      )}
      {notice && (
        <p role="status" className="my-4 border-y border-slate-200 py-3 text-sm">
          {notice}
        </p>
      )}
    </div>
  )
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: [string, string][]
  onChange: (value: string) => void
}) {
  const available = options.some(([key]) => key === value)
    ? options
    : [[value, value] as [string, string], ...options]
  return (
    <label className="block min-w-0 text-xs font-medium text-slate-700">
      {label}
      <select
        className={`${selectClass} mt-1`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {available.map(([key, title]) => (
          <option key={key} value={key}>
            {title}
          </option>
        ))}
      </select>
    </label>
  )
}

function ChicagoDataHealth({
  health,
  onGap,
}: {
  health: ChicagoHealth
  onGap: (city: string, category: string) => void
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Data health & import history</h2>
        <p className="mt-2 break-all text-sm text-slate-600">
          Active ranking rules: {health.rankingVersion}
        </p>
      </div>
      <section>
        <h3 className="font-semibold">Source versions</h3>
        {health.imports.length ? (
          <ul className="mt-3 divide-y divide-slate-200">
            {health.imports.map((item) => (
              <li key={item.id} className="py-4 text-sm">
                <p className="font-medium">
                  {chicagoLabel(item.status)} · {item.createdAt}
                </p>
                <p className="mt-1">
                  {item.totalRows.toLocaleString()} source rows ·{' '}
                  {item.importedRows.toLocaleString()} imported / matched ·{' '}
                  {item.failedRows.toLocaleString()} failed / quarantined
                </p>
                <p className="mt-2 break-all text-xs text-slate-600">
                  Workbook SHA-256: {item.sourceWorkbookHash ?? 'Not recorded'}
                </p>
                <details>
                  <summary className="min-h-11 cursor-pointer py-3">
                    Reconciliation & changes · {item.id}
                  </summary>
                  <ChicagoEvidenceValue value={item.reconciliation} />
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">No Chicago import has been recorded.</p>
        )}
      </section>
      <section>
        <h3 className="font-semibold">Geography × category gaps</h3>
        <p className="mt-2 text-xs text-slate-600">
          Select a row to inspect the venues behind a gap. Counts describe recorded evidence, not
          proof that a public route does not exist.
        </p>
        <div
          className="mt-3 max-h-80 overflow-auto"
          role="region"
          aria-label="Coverage matrix"
          tabIndex={0}
        >
          <table className="w-full min-w-[880px] table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[160px]" />
              <col className="w-[280px]" />
              <col className="w-[100px]" />
              <col className="w-[110px]" />
              <col className="w-[110px]" />
              <col className="w-[120px]" />
            </colgroup>
            <thead className="sticky top-0 bg-slate-100 text-xs">
              <tr>
                {[
                  'City / state',
                  'Category',
                  'Venues',
                  'Missing website',
                  'Missing contact',
                  'Needs research',
                ].map((title) => (
                  <th scope="col" className="p-3" key={title}>
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {health.matrix.map((row) => (
                <tr key={`${row.city}-${row.state}-${row.category}`}>
                  <th scope="row" className="p-3 font-normal">
                    <button
                      className="min-h-11 text-left text-sky-800 underline underline-offset-4"
                      onClick={() => onGap(row.city, row.category)}
                    >
                      {row.city}, {row.state}
                    </button>
                  </th>
                  <td className="p-3">{row.category}</td>
                  {[row.total, row.missingWebsite, row.missingContacts, row.needsResearch].map(
                    (value, index) => (
                      <td key={index} className="p-3 tabular-nums">
                        {value}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h3 className="font-semibold">Review queue ({health.reviews.length})</h3>
        <ul className="mt-3 max-h-80 divide-y divide-slate-200 overflow-y-auto">
          {health.reviews.map((review) => (
            <li key={review.id} className="py-3 text-sm">
              <strong>{chicagoLabel(review.kind)}</strong> · {chicagoLabel(review.status)}
              <p className="mt-1">{review.reason}</p>
              <details>
                <summary className="min-h-11 cursor-pointer py-3 text-xs text-slate-600">
                  Original evidence · {review.id}
                </summary>
                <ChicagoEvidenceValue value={review.original} />
              </details>
            </li>
          ))}
        </ul>
        {!health.reviews.length && (
          <p className="mt-2 text-sm text-slate-600">No review items reported.</p>
        )}
      </section>
      <section>
        <h3 className="font-semibold">Research leases & recovery</h3>
        <ul className="mt-3 divide-y divide-slate-200">
          {health.jobs.map((job) => (
            <li key={job.id} className="py-3 text-sm">
              <p className="font-medium">
                {chicagoLabel(job.status)}
                {job.stuck ? ' · lease needs recovery' : ''}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                {job.id} · owner {job.claimOwnerId ?? 'unclaimed'} · lease expires{' '}
                {job.claimExpiresAt ?? 'not leased'}
              </p>
            </li>
          ))}
        </ul>
        {!health.jobs.length && (
          <p className="mt-2 text-sm text-slate-600">No research jobs recorded.</p>
        )}
      </section>
    </div>
  )
}
