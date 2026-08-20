'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  Building2,
  CalendarClock,
  CheckSquare2,
  Filter,
  Layers3,
  Plus,
  Search,
  Star,
} from 'lucide-react'

import { useTRPCClient } from '../../lib/trpc'

const STAGES = [
  'DISCOVERED',
  'RESEARCHED',
  'NEEDS_REVIEW',
  'READY_FOR_OUTREACH',
  'CONTACTED',
  'FOLLOW_UP_DUE',
  'REPLIED',
  'CONVERSATION',
  'QUALIFIED',
  'PROPOSAL_DECISION',
  'WON',
  'LOST',
  'PARKED',
  'DO_NOT_CONTACT',
] as const
type Stage = (typeof STAGES)[number]
type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
type Tier = 'STANDARD' | 'HIGH_VALUE' | 'STRATEGIC'
type EmailReadiness = 'READY' | 'MISSING' | 'SUPPRESSED'
type DirectoryResult = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['listProspects']['query']>
>
type SavedView = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['listProspectSavedViews']['query']>
>[number]

function label(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

export function ProspectDirectory({
  fixture,
}: { fixture?: { result: DirectoryResult; savedViews?: SavedView[] } } = {}) {
  const client = useTRPCClient()
  const [search, setSearch] = useState('')
  const [stage, setStage] = useState<Stage | ''>('')
  const [priority, setPriority] = useState<Priority | ''>('')
  const [tier, setTier] = useState<Tier | ''>('')
  const [emailReadiness, setEmailReadiness] = useState<EmailReadiness | ''>('')
  const [nextAction, setNextAction] = useState<'OVERDUE' | 'UPCOMING' | 'NONE' | ''>('')
  const [result, setResult] = useState<DirectoryResult | null>(fixture?.result ?? null)
  const [savedViews, setSavedViews] = useState<SavedView[]>(fixture?.savedViews ?? [])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(!fixture)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [campaignOpen, setCampaignOpen] = useState(false)
  const [campaignName, setCampaignName] = useState('')
  const [notice, setNotice] = useState('')

  const filters = useMemo(
    () => ({
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(stage ? { stage } : {}),
      ...(priority ? { priority } : {}),
      ...(tier ? { relationshipTier: tier } : {}),
      ...(emailReadiness ? { emailReadiness } : {}),
      ...(nextAction ? { nextAction } : {}),
    }),
    [emailReadiness, nextAction, priority, search, stage, tier],
  )

  useEffect(() => {
    if (!fixture)
      void client.admin.listProspectSavedViews
        .query()
        .then(setSavedViews)
        .catch(() => undefined)
  }, [client, fixture])
  useEffect(() => {
    if (fixture) return
    let current = true
    const timeout = window.setTimeout(
      () => {
        setLoading(true)
        setFailed(false)
        void client.admin.listProspects
          .query({ ...filters, limit: 100 })
          .then((value) => {
            if (current) {
              setResult(value)
              setSelected(new Set())
            }
          })
          .catch(() => {
            if (current) setFailed(true)
          })
          .finally(() => {
            if (current) setLoading(false)
          })
      },
      search ? 180 : 0,
    )
    return () => {
      current = false
      window.clearTimeout(timeout)
    }
  }, [client, filters, fixture, search])

  async function loadMore() {
    if (!result?.nextCursor) return
    setLoadingMore(true)
    try {
      const page = await client.admin.listProspects.query({
        ...filters,
        limit: 100,
        cursor: result.nextCursor,
      })
      setResult({ items: [...result.items, ...page.items], nextCursor: page.nextCursor })
    } finally {
      setLoadingMore(false)
    }
  }

  function applyView(view: SavedView) {
    const value = view.filters as Record<string, unknown>
    setSearch(typeof value.search === 'string' ? value.search : '')
    setStage(STAGES.includes(value.stage as Stage) ? (value.stage as Stage) : '')
    setPriority(
      ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(String(value.priority))
        ? (value.priority as Priority)
        : '',
    )
    setTier(
      ['STANDARD', 'HIGH_VALUE', 'STRATEGIC'].includes(String(value.relationshipTier))
        ? (value.relationshipTier as Tier)
        : '',
    )
    setEmailReadiness(
      ['READY', 'MISSING', 'SUPPRESSED'].includes(String(value.emailReadiness))
        ? (value.emailReadiness as EmailReadiness)
        : '',
    )
    setNextAction(
      ['OVERDUE', 'UPCOMING', 'NONE'].includes(String(value.nextAction))
        ? (value.nextAction as typeof nextAction)
        : '',
    )
  }

  async function saveView() {
    const name = window.prompt('Name this view')?.trim()
    if (!name) return
    await client.admin.saveProspectView.mutate({
      name,
      filters,
      columns: ['organization', 'venue', 'stage', 'tier', 'next-action'],
      sort: {},
    })
    setSavedViews(await client.admin.listProspectSavedViews.query())
    setNotice(`Saved “${name}”`)
  }

  async function createCampaign() {
    if (!campaignName.trim() || !selected.size) return
    const campaign = await client.admin.createProspectCampaign.mutate({
      name: campaignName.trim(),
      organizationIds: [...selected],
      cohortSnapshot: {
        filters,
        explicitOrganizationIds: [...selected],
        capturedAt: new Date().toISOString(),
      },
    })
    window.location.assign(`/admin/prospects/outreach/${campaign.id}`)
  }

  const allShownSelected =
    Boolean(result?.items.length) && result!.items.every((item) => selected.has(item.id))

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-700">
            Venue intelligence CRM
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
            Prospect directory
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Search and segment the whole venue universe, then turn an exact reviewed cohort into
            outreach.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin/prospects/new"
            className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-sm"
          >
            Add prospect
          </Link>
          <Link
            href="/admin/prospects/pipeline"
            className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-sm"
          >
            Pipeline
          </Link>
          <Link
            href="/admin/prospects/outreach"
            className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white shadow-sm"
          >
            Outreach center
          </Link>
          <Link
            href="/admin/prospects/imports"
            className="rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm"
          >
            Import spreadsheet
          </Link>
        </div>
      </div>

      {savedViews.length ? (
        <nav aria-label="Saved prospect views" className="flex flex-wrap items-center gap-2">
          <Star className="h-4 w-4 text-amber-500" aria-hidden="true" />
          {savedViews.map((view) => (
            <button
              key={view.id}
              onClick={() => applyView(view)}
              className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-sky-300"
            >
              {view.name}
            </button>
          ))}
        </nav>
      ) : null}

      <section
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
        aria-label="Prospect filters"
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <label className="relative block xl:col-span-2">
            <span className="sr-only">Search prospects</span>
            <Search
              className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400"
              aria-hidden="true"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search organization, venue, domain…"
              className="min-h-11 w-full rounded-xl border border-slate-300 pl-9 pr-3 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
            />
          </label>
          <FilterSelect
            labelText="Stage"
            value={stage}
            onChange={(value) => setStage(value as Stage | '')}
            options={STAGES}
            empty="All stages"
          />
          <FilterSelect
            labelText="Priority"
            value={priority}
            onChange={(value) => setPriority(value as Priority | '')}
            options={['URGENT', 'HIGH', 'NORMAL', 'LOW']}
            empty="All priorities"
          />
          <FilterSelect
            labelText="Relationship tier"
            value={tier}
            onChange={(value) => setTier(value as Tier | '')}
            options={['STRATEGIC', 'HIGH_VALUE', 'STANDARD']}
            empty="All tiers"
          />
          <FilterSelect
            labelText="Email readiness"
            value={emailReadiness}
            onChange={(value) => setEmailReadiness(value as EmailReadiness | '')}
            options={['READY', 'MISSING', 'SUPPRESSED']}
            empty="Any email state"
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <FilterSelect
            labelText="Next action state"
            value={nextAction}
            onChange={(value) => setNextAction(value as typeof nextAction)}
            options={['OVERDUE', 'UPCOMING', 'NONE']}
            empty="Any next action"
            compact
          />
          <button
            onClick={() => void saveView()}
            className="min-h-10 rounded-xl border border-slate-300 px-3 text-xs font-semibold text-slate-700"
          >
            Save current view
          </button>
          {notice ? (
            <span role="status" className="text-xs font-medium text-emerald-700">
              {notice}
            </span>
          ) : null}
        </div>
      </section>

      {selected.size ? (
        <section className="flex flex-col justify-between gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <CheckSquare2 className="h-5 w-5 text-sky-700" />
            <div>
              <p className="text-sm font-bold text-slate-950">
                {selected.size} prospect{selected.size === 1 ? '' : 's'} selected
              </p>
              <p className="text-xs text-slate-600">
                The exact IDs and current filters will be frozen into the campaign.
              </p>
            </div>
          </div>
          <button
            onClick={() => setCampaignOpen(true)}
            className="rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white"
          >
            Create outreach campaign
          </button>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-3">
            <input
              aria-label="Select all shown prospects"
              type="checkbox"
              checked={allShownSelected}
              onChange={(event) =>
                setSelected(
                  event.target.checked ? new Set(result?.items.map((item) => item.id)) : new Set(),
                )
              }
              className="h-4 w-4 rounded border-slate-300 text-sky-600"
            />
            <Filter className="h-4 w-4 text-sky-700" aria-hidden="true" />
            <h2 className="font-semibold text-slate-950">Operational queue</h2>
          </div>
          <span className="text-xs font-medium text-slate-500">
            {result?.items.length ?? 0} loaded{result?.nextCursor ? ' · more available' : ''}
          </span>
        </div>
        {loading && !result ? (
          <p className="p-10 text-center text-sm text-slate-500" role="status">
            Loading prospects…
          </p>
        ) : failed ? (
          <div className="p-10 text-center" role="alert">
            <p className="font-semibold text-slate-900">Prospect directory is unavailable</p>
            <p className="mt-1 text-sm text-slate-500">
              Your filters are preserved. Try again in a moment.
            </p>
          </div>
        ) : !result?.items.length ? (
          <div className="p-12 text-center">
            <Building2 className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-3 font-semibold text-slate-900">No prospects match this view</p>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-slate-100">
              {result.items.map((item) => (
                <li
                  key={item.id}
                  className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-stretch hover:bg-sky-50/40"
                >
                  <label className="flex items-center justify-center">
                    <span className="sr-only">Select {item.canonicalName}</span>
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={(event) =>
                        setSelected((current) => {
                          const next = new Set(current)
                          if (event.target.checked) next.add(item.id)
                          else next.delete(item.id)
                          return next
                        })
                      }
                      className="h-4 w-4 rounded border-slate-300 text-sky-600"
                    />
                  </label>
                  <Link
                    href={`/admin/prospects/${item.id}`}
                    className="grid gap-3 px-2 py-4 pr-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 md:grid-cols-[minmax(0,1.4fr)_minmax(12rem,.8fr)_minmax(12rem,.8fr)]"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-950">{item.canonicalName}</p>
                      <p className="mt-1 truncate text-xs text-slate-500">
                        {item.venues[0]?.name ?? 'Organization prospect'} ·{' '}
                        {item.territory?.name ?? 'Unassigned territory'}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full bg-sky-100 px-2.5 py-1 font-semibold text-sky-800">
                        {label(item.opportunity?.stage ?? 'DISCOVERED')}
                      </span>
                      <span
                        className={`rounded-full px-2.5 py-1 font-semibold ${item.relationshipTier === 'STRATEGIC' ? 'bg-violet-100 text-violet-800' : item.relationshipTier === 'HIGH_VALUE' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}
                      >
                        {label(item.relationshipTier)}
                      </span>
                      <span className="font-semibold text-slate-500">
                        {item.opportunity?.priority ?? item.priority}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-slate-600">
                      <CalendarClock className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="truncate">
                        {item.opportunity?.nextAction
                          ? `${item.opportunity.nextAction}${item.opportunity.nextActionAt ? ` · ${new Date(item.opportunity.nextActionAt).toLocaleDateString()}` : ''}`
                          : 'No next action set'}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            {result.nextCursor ? (
              <div className="border-t border-slate-100 p-4 text-center">
                <button
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Load 100 more'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>

      {campaignOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="campaign-title"
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-4"
        >
          <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl">
            <div className="flex items-center gap-3">
              <span className="rounded-xl bg-sky-100 p-2 text-sky-700">
                <Layers3 className="h-5 w-5" />
              </span>
              <div>
                <h2 id="campaign-title" className="text-lg font-bold text-slate-950">
                  Create outreach campaign
                </h2>
                <p className="text-sm text-slate-500">
                  Freeze {selected.size} selected prospect{selected.size === 1 ? '' : 's'} into a
                  review queue.
                </p>
              </div>
            </div>
            <label className="mt-5 block text-sm font-semibold text-slate-700">
              Campaign name
              <input
                autoFocus
                value={campaignName}
                onChange={(event) => setCampaignName(event.target.value)}
                className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-3 font-normal"
                placeholder="Chicago museums · August"
              />
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setCampaignOpen(false)}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                disabled={!campaignName.trim()}
                onClick={() => void createCampaign()}
                className="inline-flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Create campaign
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function FilterSelect({
  labelText,
  value,
  onChange,
  options,
  empty,
  compact = false,
}: {
  labelText: string
  value: string
  onChange: (value: string) => void
  options: readonly string[]
  empty: string
  compact?: boolean
}) {
  return (
    <label className={compact ? 'min-w-48' : ''}>
      <span className="sr-only">{labelText}</span>
      <select
        aria-label={labelText}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${compact ? 'min-h-10' : 'min-h-11'} w-full rounded-xl border border-slate-300 bg-white px-3 text-sm`}
      >
        <option value="">{empty}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {label(option)}
          </option>
        ))}
      </select>
    </label>
  )
}
