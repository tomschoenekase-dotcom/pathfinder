'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Building2,
  CalendarClock,
  CheckSquare2,
  CircleAlert,
  FileSearch,
  Filter,
  Layers3,
  Plus,
  Search,
  Star,
} from 'lucide-react'

import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import {
  isDirectoryPreferenceEvent,
  readDirectoryNavigation,
  readDirectoryPreference,
  recordDirectoryNavigation,
  saveDirectoryPreference,
} from '../../lib/prospect-directory-state'
import { ProspectPreparationWorkspace } from './ProspectPreparationWorkspace'
import type { PreparationWorkspaceTransport } from '../../lib/prospect-preparation-workspace'
import { ChicagoVenueDirectory } from './ChicagoVenueDirectory'

const PROSPECT_READ_TIMEOUT_MS = 15_000

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
type OutreachState = 'NO_RECORDED_SEND' | 'DRAFTED' | 'SENT' | 'REPLIED' | 'FAILED'
type ContactState = 'RECORDED' | 'MISSING' | 'REVIEW_NEEDED' | 'SUPPRESSED'
type Provenance = 'IMPORTED' | 'SOURCE_URL_RECORDED' | 'WEB_EVIDENCE' | 'NO_EVIDENCE'
type Completeness = 'CORE_PRESENT' | 'NEEDS_RESEARCH'
type WebsiteState = 'RECORDED' | 'MISSING'
type DirectorySort = 'UPDATED' | 'NAME_ASC' | 'NAME_DESC'
type DirectoryResult = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['listProspects']['query']>
>
type DirectoryQuery = Parameters<
  ReturnType<typeof useTRPCClient>['admin']['listProspects']['query']
>[0]
type SavedView = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['listProspectSavedViews']['query']>
>[number]
type SalesReadiness = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['getProspectSalesReadiness']['query']>
>

function label(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

type ProspectDirectoryProps = {
  fixture?: { result: DirectoryResult; savedViews?: SavedView[] }
  outreachAvailable?: boolean
  loadPage?: (input: DirectoryQuery, signal?: AbortSignal) => Promise<DirectoryResult>
  directoryHref?: string
  readOnly?: boolean
  territories?: { id: string; name: string }[]
  defaultScope?: 'all' | 'chicago'
}

export function ProspectDirectory(props: ProspectDirectoryProps = {}) {
  const params = useSearchParams()
  const scope = params.get('scope') ?? props.defaultScope ?? 'all'
  const territoryHref = props.directoryHref?.startsWith('/dev-fixtures/')
    ? '/dev-fixtures/prospect-research/territories'
    : '/admin/prospects/territories'
  return (
    <>
      {!props.fixture && (
        <nav aria-label="Prospect research geography" className="mb-4 flex justify-end">
          <Link
            href={territoryHref}
            className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-emerald-800 underline underline-offset-4"
          >
            Research territories &amp; county checks
          </Link>
        </nav>
      )}
      {scope === 'chicago' && !props.fixture && !props.loadPage ? (
        <ChicagoVenueDirectory
          directoryHref={props.directoryHref}
          readOnly={props.readOnly}
          territoryId={
            props.territories?.find((territory) => territory.name === 'Chicago Metro')?.id
          }
        />
      ) : (
        <GeneralProspectDirectory {...props} />
      )}
    </>
  )
}

function GeneralProspectDirectory({
  defaultScope,
  fixture,
  outreachAvailable = false,
  loadPage,
  directoryHref = '/admin/prospects',
  readOnly = false,
  territories = [],
}: ProspectDirectoryProps = {}) {
  const client = useTRPCClient()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [search, setSearch] = useState(() => searchParams.get('search') ?? '')
  const [stage, setStage] = useState<Stage | ''>(() => {
    const value = searchParams.get('stage')
    return STAGES.includes(value as Stage) ? (value as Stage) : ''
  })
  const [priority, setPriority] = useState<Priority | ''>(() => {
    const value = searchParams.get('priority')
    return ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(value ?? '') ? (value as Priority) : ''
  })
  const [tier, setTier] = useState<Tier | ''>(() => {
    const value = searchParams.get('tier')
    return ['STANDARD', 'HIGH_VALUE', 'STRATEGIC'].includes(value ?? '') ? (value as Tier) : ''
  })
  const [emailReadiness, setEmailReadiness] = useState<EmailReadiness | ''>(() => {
    const value = searchParams.get('emailReadiness')
    return ['READY', 'MISSING', 'SUPPRESSED'].includes(value ?? '') ? (value as EmailReadiness) : ''
  })
  const [outreachState, setOutreachState] = useState<OutreachState | ''>(() => {
    const value = searchParams.get('outreachState')
    return ['NO_RECORDED_SEND', 'DRAFTED', 'SENT', 'REPLIED', 'FAILED'].includes(value ?? '')
      ? (value as OutreachState)
      : ''
  })
  const [territoryId, setTerritoryId] = useState(() => searchParams.get('territoryId') ?? '')
  const [category, setCategory] = useState(() => searchParams.get('category') ?? '')
  const [contactState, setContactState] = useState<ContactState | ''>(() => {
    const value = searchParams.get('contactState')
    return ['RECORDED', 'MISSING', 'REVIEW_NEEDED', 'SUPPRESSED'].includes(value ?? '')
      ? (value as ContactState)
      : ''
  })
  const [provenance, setProvenance] = useState<Provenance | ''>(() => {
    const value = searchParams.get('provenance')
    return ['IMPORTED', 'SOURCE_URL_RECORDED', 'WEB_EVIDENCE', 'NO_EVIDENCE'].includes(value ?? '')
      ? (value as Provenance)
      : ''
  })
  const [completeness, setCompleteness] = useState<Completeness | ''>(() => {
    const value = searchParams.get('completeness')
    return ['CORE_PRESENT', 'NEEDS_RESEARCH'].includes(value ?? '') ? (value as Completeness) : ''
  })
  const [websiteState, setWebsiteState] = useState<WebsiteState | ''>(() => {
    const value = searchParams.get('websiteState')
    return ['RECORDED', 'MISSING'].includes(value ?? '') ? (value as WebsiteState) : ''
  })
  const [sort, setSort] = useState<DirectorySort>(() => {
    const value = searchParams.get('sort')
    return ['NAME_ASC', 'NAME_DESC'].includes(value ?? '') ? (value as DirectorySort) : 'UPDATED'
  })
  const [nextAction, setNextAction] = useState<'OVERDUE' | 'UPCOMING' | 'NONE' | ''>(() => {
    const value = searchParams.get('nextAction')
    return ['OVERDUE', 'UPCOMING', 'NONE'].includes(value ?? '')
      ? (value as 'OVERDUE' | 'UPCOMING' | 'NONE')
      : ''
  })
  const [result, setResult] = useState<DirectoryResult | null>(fixture?.result ?? null)
  const [savedViews, setSavedViews] = useState<SavedView[]>(fixture?.savedViews ?? [])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(!fixture)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [campaignOpen, setCampaignOpen] = useState(false)
  const [preparationOpen, setPreparationOpen] = useState(false)
  const [reopenPreparationSession, setReopenPreparationSession] = useState(false)
  const [salesReadiness, setSalesReadiness] = useState<SalesReadiness | null>(null)
  const [campaignName, setCampaignName] = useState('')
  const [notice, setNotice] = useState('')
  const [savedPreference, setSavedPreference] =
    useState<ReturnType<typeof readDirectoryPreference>>(null)
  const [preferenceChangedElsewhere, setPreferenceChangedElsewhere] = useState(false)
  const restoredScroll = useRef(false)
  const campaignDialogRef = useRef<HTMLDivElement>(null)
  const campaignNameRef = useRef<HTMLInputElement>(null)
  const campaignTriggerRef = useRef<HTMLButtonElement>(null)
  const savedViewsReadAbort = useRef<AbortController | null>(null)
  const directoryReadAbort = useRef<AbortController | null>(null)
  const loadMoreReadAbort = useRef<AbortController | null>(null)
  const loadMoreReadInFlight = useRef(false)
  const navigatingToRecord = useRef(false)

  const preparationTransport = useMemo<PreparationWorkspaceTransport>(
    () => ({
      readOrganization: (organizationId) =>
        runBoundedClientRequest({
          parentSignal: new AbortController().signal,
          timeoutMs: PROSPECT_READ_TIMEOUT_MS,
          request: (signal) => client.admin.getProspect.query({ organizationId }, { signal }),
        }),
      load: (venueId) =>
        runBoundedClientRequest({
          parentSignal: new AbortController().signal,
          timeoutMs: PROSPECT_READ_TIMEOUT_MS,
          request: (signal) => client.admin.getProspectSalesWorkflow.query({ venueId }, { signal }),
        }),
      act: (action) => client.admin.prepareReviewProspectSales.mutate(action),
    }),
    [client],
  )

  function fetchPage(input: DirectoryQuery, parentSignal: AbortSignal) {
    return runBoundedClientRequest({
      parentSignal,
      timeoutMs: PROSPECT_READ_TIMEOUT_MS,
      request: (signal) =>
        loadPage ? loadPage(input, signal) : client.admin.listProspects.query(input, { signal }),
    })
  }

  const filters = useMemo(
    () => ({
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(stage ? { stage } : {}),
      ...(priority ? { priority } : {}),
      ...(tier ? { relationshipTier: tier } : {}),
      ...(emailReadiness ? { emailReadiness } : {}),
      ...(outreachState ? { outreachState } : {}),
      ...(nextAction ? { nextAction } : {}),
      ...(territoryId ? { territoryId } : {}),
      ...(category.trim() ? { category: category.trim() } : {}),
      ...(contactState ? { contactState } : {}),
      ...(provenance ? { provenance } : {}),
      ...(completeness ? { completeness } : {}),
      ...(websiteState ? { websiteState } : {}),
      sort,
    }),
    [
      category,
      completeness,
      contactState,
      emailReadiness,
      outreachState,
      nextAction,
      priority,
      provenance,
      search,
      sort,
      stage,
      territoryId,
      tier,
      websiteState,
    ],
  )
  const directoryQuery = useMemo(
    () =>
      new URLSearchParams(
        Object.entries({ ...filters, ...(defaultScope === 'chicago' ? { scope: 'all' } : {}) }).map(
          ([key, value]) => [key === 'relationshipTier' ? 'tier' : key, String(value)],
        ),
      ).toString(),
    [filters, defaultScope],
  )

  useEffect(() => {
    if (navigatingToRecord.current || pathname !== directoryHref) return
    const next = new URLSearchParams(searchParams.toString())
    const values = {
      search: search.trim(),
      stage,
      priority,
      tier,
      emailReadiness,
      outreachState,
      nextAction,
      territoryId,
      category: category.trim(),
      contactState,
      provenance,
      completeness,
      websiteState,
      sort,
    }
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    const query = next.toString()
    if (query !== searchParams.toString()) {
      // Filters already have their own cancellable data reader. A router
      // navigation here can finish after a record click and replace its detail.
      // Next's patched History API keeps useSearchParams synchronized without
      // starting a competing server navigation or scrolling the directory.
      window.history.replaceState(null, '', query ? `${pathname}?${query}` : pathname)
    }
  }, [
    category,
    completeness,
    contactState,
    directoryHref,
    emailReadiness,
    outreachState,
    nextAction,
    pathname,
    priority,
    provenance,
    search,
    searchParams,
    sort,
    stage,
    territoryId,
    tier,
    websiteState,
  ])

  useEffect(() => {
    try {
      setSavedPreference(readDirectoryPreference(window.localStorage))
    } catch {
      // Browser storage may be disabled; URL filters still work.
    }
    const onStorage = (event: StorageEvent) => {
      if (!isDirectoryPreferenceEvent(event)) return
      setPreferenceChangedElsewhere(true)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    if (loading || restoredScroll.current || !result?.items.length) return
    try {
      const saved = readDirectoryNavigation(window.sessionStorage, directoryHref, directoryQuery)
      if (saved) {
        restoredScroll.current = true
        window.requestAnimationFrame(() => window.scrollTo(0, saved.scrollY))
      }
    } catch {
      // Navigation remains functional when session storage is unavailable.
    }
  }, [directoryHref, directoryQuery, loading, result])

  useEffect(() => {
    if (fixture || readOnly) return
    savedViewsReadAbort.current?.abort()
    const controller = new AbortController()
    savedViewsReadAbort.current = controller
    void runBoundedClientRequest({
      parentSignal: controller.signal,
      timeoutMs: PROSPECT_READ_TIMEOUT_MS,
      request: (signal) => client.admin.listProspectSavedViews.query(undefined, { signal }),
    })
      .then(setSavedViews)
      .catch(() => undefined)
      .finally(() => {
        if (savedViewsReadAbort.current === controller) savedViewsReadAbort.current = null
      })
    return () => {
      savedViewsReadAbort.current?.abort()
    }
  }, [client, fixture, readOnly])
  useEffect(() => {
    if (fixture) return
    directoryReadAbort.current?.abort()
    loadMoreReadAbort.current?.abort()
    loadMoreReadAbort.current = null
    loadMoreReadInFlight.current = false
    setLoadingMore(false)
    let current = true
    const controller = new AbortController()
    directoryReadAbort.current = controller
    const timeout = window.setTimeout(
      () => {
        setLoading(true)
        setFailed(false)
        void fetchPage({ ...filters, limit: 100 }, controller.signal)
          .then(async (firstPage) => {
            let value = firstPage
            try {
              const saved = readDirectoryNavigation(
                window.sessionStorage,
                directoryHref,
                directoryQuery,
              )
              const target = saved?.ids.length ?? 0
              while (
                value.nextCursor &&
                value.items.length < target &&
                !controller.signal.aborted
              ) {
                const page = await fetchPage(
                  { ...filters, limit: 100, cursor: value.nextCursor },
                  controller.signal,
                )
                value = { ...page, items: [...value.items, ...page.items] }
              }
            } catch {
              // Retain pages already loaded if a later restore page fails.
            }
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
            if (directoryReadAbort.current === controller) directoryReadAbort.current = null
          })
      },
      search ? 180 : 0,
    )
    return () => {
      current = false
      window.clearTimeout(timeout)
      controller.abort()
      loadMoreReadAbort.current?.abort()
      loadMoreReadAbort.current = null
      loadMoreReadInFlight.current = false
    }
  }, [client, directoryHref, directoryQuery, filters, fixture, loadPage, search, retry])

  useEffect(() => {
    if (!campaignOpen) return
    const previousOverflow = document.body.style.overflow
    const trigger = campaignTriggerRef.current
    document.body.style.overflow = 'hidden'
    campaignNameRef.current?.focus()
    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setCampaignOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = campaignDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', handleDialogKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleDialogKeyDown)
      trigger?.focus()
    }
  }, [campaignOpen])

  useEffect(() => {
    if (!preparationOpen) return
    let active = true
    void runBoundedClientRequest({
      parentSignal: new AbortController().signal,
      timeoutMs: PROSPECT_READ_TIMEOUT_MS,
      request: (signal) => client.admin.getProspectSalesReadiness.query(undefined, { signal }),
    })
      .then((value) => {
        if (active) setSalesReadiness(value)
      })
      .catch(() => {
        if (active) setSalesReadiness(null)
      })
    return () => {
      active = false
    }
  }, [client, preparationOpen])

  async function loadMore() {
    if (!result?.nextCursor || loadMoreReadInFlight.current) return
    loadMoreReadInFlight.current = true
    const controller = new AbortController()
    loadMoreReadAbort.current = controller
    setLoadingMore(true)
    try {
      const page = await fetchPage(
        { ...filters, limit: 100, cursor: result.nextCursor! },
        controller.signal,
      )
      if (!controller.signal.aborted) {
        setResult({ ...page, items: [...result.items, ...page.items] })
      }
    } catch {
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      if (loadMoreReadAbort.current === controller) {
        loadMoreReadAbort.current = null
        loadMoreReadInFlight.current = false
        setLoadingMore(false)
      }
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
    setOutreachState(
      ['NO_RECORDED_SEND', 'DRAFTED', 'SENT', 'REPLIED', 'FAILED'].includes(
        String(value.outreachState),
      )
        ? (value.outreachState as OutreachState)
        : '',
    )
    setNextAction(
      ['OVERDUE', 'UPCOMING', 'NONE'].includes(String(value.nextAction))
        ? (value.nextAction as typeof nextAction)
        : '',
    )
    setTerritoryId(typeof value.territoryId === 'string' ? value.territoryId : '')
    setCategory(typeof value.category === 'string' ? value.category : '')
    setContactState(
      ['RECORDED', 'MISSING', 'REVIEW_NEEDED', 'SUPPRESSED'].includes(String(value.contactState))
        ? (value.contactState as ContactState)
        : '',
    )
    setProvenance(
      ['IMPORTED', 'SOURCE_URL_RECORDED', 'WEB_EVIDENCE', 'NO_EVIDENCE'].includes(
        String(value.provenance),
      )
        ? (value.provenance as Provenance)
        : '',
    )
    setCompleteness(
      ['CORE_PRESENT', 'NEEDS_RESEARCH'].includes(String(value.completeness))
        ? (value.completeness as Completeness)
        : '',
    )
    setWebsiteState(
      ['RECORDED', 'MISSING'].includes(String(value.websiteState))
        ? (value.websiteState as WebsiteState)
        : '',
    )
    setSort(
      ['NAME_ASC', 'NAME_DESC'].includes(String(value.sort))
        ? (value.sort as DirectorySort)
        : 'UPDATED',
    )
  }

  function clearFilters() {
    setSearch('')
    setStage('')
    setPriority('')
    setTier('')
    setEmailReadiness('')
    setOutreachState('')
    setNextAction('')
    setTerritoryId('')
    setCategory('')
    setContactState('')
    setProvenance('')
    setCompleteness('')
    setWebsiteState('')
    setSort('UPDATED')
  }

  async function saveView() {
    if (readOnly) return
    const name = window.prompt('Name this view')?.trim()
    if (!name) return
    await client.admin.saveProspectView.mutate({
      name,
      filters,
      columns: ['organization', 'venue', 'stage', 'tier', 'next-action'],
      sort: {},
    })
    savedViewsReadAbort.current?.abort()
    const controller = new AbortController()
    savedViewsReadAbort.current = controller
    try {
      setSavedViews(
        await runBoundedClientRequest({
          parentSignal: controller.signal,
          timeoutMs: PROSPECT_READ_TIMEOUT_MS,
          request: (signal) => client.admin.listProspectSavedViews.query(undefined, { signal }),
        }),
      )
      setNotice(`Saved “${name}”`)
    } catch {
      if (!controller.signal.aborted)
        setNotice('The view may be saved, but its list did not refresh. Refresh before retrying.')
    } finally {
      if (savedViewsReadAbort.current === controller) savedViewsReadAbort.current = null
    }
  }

  async function rememberFilters() {
    try {
      const saved = await saveDirectoryPreference(
        window.localStorage,
        directoryQuery,
        savedPreference?.revision ?? null,
        crypto.randomUUID(),
      )
      if (saved.status === 'conflict') {
        setSavedPreference(saved.preference)
        setPreferenceChangedElsewhere(true)
        setNotice('A different tab changed the remembered filters. Load them before saving again.')
        return
      }
      if (saved.status === 'serialization-unavailable') {
        setNotice(
          'This browser cannot safely remember filters across tabs. The filter link still works.',
        )
        return
      }
      setSavedPreference(saved.preference)
      setPreferenceChangedElsewhere(false)
      setNotice('Filters remembered on this device.')
    } catch {
      setNotice('Browser storage is unavailable. The filter link still works.')
    }
  }

  function loadRememberedFilters() {
    try {
      const latest = readDirectoryPreference(window.localStorage)
      setSavedPreference(latest)
      setPreferenceChangedElsewhere(false)
      if (!latest) return
      const value = new URLSearchParams(latest.query)
      setSearch(value.get('search') ?? '')
      setStage(STAGES.includes(value.get('stage') as Stage) ? (value.get('stage') as Stage) : '')
      setPriority(
        ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(value.get('priority') ?? '')
          ? (value.get('priority') as Priority)
          : '',
      )
      setTier(
        ['STANDARD', 'HIGH_VALUE', 'STRATEGIC'].includes(value.get('tier') ?? '')
          ? (value.get('tier') as Tier)
          : '',
      )
      setEmailReadiness(
        ['READY', 'MISSING', 'SUPPRESSED'].includes(value.get('emailReadiness') ?? '')
          ? (value.get('emailReadiness') as EmailReadiness)
          : '',
      )
      setOutreachState(
        ['NO_RECORDED_SEND', 'DRAFTED', 'SENT', 'REPLIED', 'FAILED'].includes(
          value.get('outreachState') ?? '',
        )
          ? (value.get('outreachState') as OutreachState)
          : '',
      )
      setNextAction(
        ['OVERDUE', 'UPCOMING', 'NONE'].includes(value.get('nextAction') ?? '')
          ? (value.get('nextAction') as typeof nextAction)
          : '',
      )
      setTerritoryId(value.get('territoryId') ?? '')
      setCategory(value.get('category') ?? '')
      setContactState(
        ['RECORDED', 'MISSING', 'REVIEW_NEEDED', 'SUPPRESSED'].includes(
          value.get('contactState') ?? '',
        )
          ? (value.get('contactState') as ContactState)
          : '',
      )
      setProvenance(
        ['IMPORTED', 'SOURCE_URL_RECORDED', 'WEB_EVIDENCE', 'NO_EVIDENCE'].includes(
          value.get('provenance') ?? '',
        )
          ? (value.get('provenance') as Provenance)
          : '',
      )
      setCompleteness(
        ['CORE_PRESENT', 'NEEDS_RESEARCH'].includes(value.get('completeness') ?? '')
          ? (value.get('completeness') as Completeness)
          : '',
      )
      setWebsiteState(
        ['RECORDED', 'MISSING'].includes(value.get('websiteState') ?? '')
          ? (value.get('websiteState') as WebsiteState)
          : '',
      )
      setSort(
        ['NAME_ASC', 'NAME_DESC'].includes(value.get('sort') ?? '')
          ? (value.get('sort') as DirectorySort)
          : 'UPDATED',
      )
      setNotice('Remembered filters loaded.')
    } catch {
      setNotice('Browser storage is unavailable. The filter link still works.')
    }
  }

  async function createCampaign() {
    if (readOnly || !outreachAvailable) return
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
    <div className="min-w-0 space-y-6">
      <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
            Prospect directory
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Find a venue, inspect its original sources, and see what is still unknown.
          </p>
        </div>
        {!readOnly ? (
          <div className="flex flex-wrap gap-2">
            {defaultScope === 'chicago' && (
              <Link
                href={`${directoryHref}?scope=chicago`}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800"
              >
                Chicago venue intelligence
              </Link>
            )}
            <Link
              href="/admin/prospects/inbound"
              className="rounded-xl border border-sky-300 bg-sky-50 px-4 py-2.5 text-sm font-semibold text-sky-800 shadow-sm"
            >
              Inbound interest
            </Link>
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
            {outreachAvailable ? (
              <Link
                href="/admin/prospects/outreach"
                className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white shadow-sm"
              >
                Outreach center
              </Link>
            ) : null}
            <Link
              href="/admin/prospects/imports"
              className="rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm"
            >
              Import spreadsheet
            </Link>
          </div>
        ) : null}
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
        className="border-y border-slate-200 bg-white px-4 py-5 shadow-sm sm:px-5"
        aria-label="Prospect filters"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-950">Find the next useful record</h2>
            <p className="mt-1 text-xs text-slate-500">
              Filters describe what is recorded; they do not infer fit or readiness.
            </p>
          </div>
          <button
            onClick={clearFilters}
            className="min-h-10 text-xs font-semibold text-sky-800 hover:underline"
          >
            Clear filters
          </button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <label className="relative block xl:col-span-2">
            <span className="sr-only">Search prospects</span>
            <Search
              className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400"
              aria-hidden="true"
            />
            <input
              maxLength={200}
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
          <FilterSelect
            labelText="Outreach record"
            value={outreachState}
            onChange={(value) => setOutreachState(value as OutreachState | '')}
            options={['NO_RECORDED_SEND', 'DRAFTED', 'SENT', 'REPLIED', 'FAILED']}
            empty="Any outreach state"
          />
        </div>
        <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 md:grid-cols-2 xl:grid-cols-6">
          <label className="relative block">
            <span className="sr-only">Territory</span>
            <select
              aria-label="Territory"
              value={territoryId}
              onChange={(event) => setTerritoryId(event.target.value)}
              className="min-h-11 min-w-0 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
            >
              <option value="">All territories</option>
              {territoryId && !territories.some((item) => item.id === territoryId) ? (
                <option value={territoryId}>Selected territory unavailable</option>
              ) : null}
              {territories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="relative block">
            <span className="sr-only">Organization type</span>
            <input
              value={category}
              maxLength={200}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="Organization type"
              className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-sm"
            />
          </label>
          <FilterSelect
            labelText="Contact record"
            value={contactState}
            onChange={(value) => setContactState(value as ContactState | '')}
            options={['RECORDED', 'MISSING', 'REVIEW_NEEDED', 'SUPPRESSED']}
            empty="Any contact state"
          />
          <FilterSelect
            labelText="Evidence source"
            value={provenance}
            onChange={(value) => setProvenance(value as Provenance | '')}
            options={['IMPORTED', 'SOURCE_URL_RECORDED', 'WEB_EVIDENCE', 'NO_EVIDENCE']}
            empty="Any evidence state"
          />
          <FilterSelect
            labelText="Record completeness"
            value={completeness}
            onChange={(value) => setCompleteness(value as Completeness | '')}
            options={['CORE_PRESENT', 'NEEDS_RESEARCH']}
            empty="Any completeness"
          />
          <FilterSelect
            labelText="Website record"
            value={websiteState}
            onChange={(value) => setWebsiteState(value as WebsiteState | '')}
            options={['RECORDED', 'MISSING']}
            empty="Any website state"
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
          <FilterSelect
            labelText="Sort"
            value={sort}
            onChange={(value) => setSort(value as DirectorySort)}
            options={['UPDATED', 'NAME_ASC', 'NAME_DESC']}
            empty="Recently updated"
            compact
          />
          {!readOnly ? (
            <button
              onClick={() => void saveView()}
              className="min-h-10 rounded-xl border border-slate-300 px-3 text-xs font-semibold text-slate-700"
            >
              Save current view
            </button>
          ) : null}
          {!readOnly ? (
            <>
              <button
                type="button"
                onClick={() => void rememberFilters()}
                className="min-h-10 rounded-xl border border-slate-300 px-3 text-xs font-semibold text-slate-700"
              >
                Remember filters
              </button>
              {savedPreference || preferenceChangedElsewhere ? (
                <button
                  type="button"
                  onClick={loadRememberedFilters}
                  className="min-h-10 text-xs font-semibold text-sky-800 hover:underline"
                >
                  {preferenceChangedElsewhere
                    ? 'Load filters changed in another tab'
                    : 'Load remembered filters'}
                </button>
              ) : null}
            </>
          ) : null}
          {notice ? (
            <span role="status" className="text-xs font-medium text-emerald-700">
              {notice}
            </span>
          ) : null}
        </div>
      </section>

      {selected.size && !readOnly ? (
        <section className="flex flex-col justify-between gap-3 border-y border-slate-300 bg-slate-50 px-4 py-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <CheckSquare2 className="h-5 w-5 text-slate-700" />
            <div>
              <p className="text-sm font-bold text-slate-950">
                {selected.size} selected organization{selected.size === 1 ? '' : 's'}
              </p>
              <p className="text-xs text-slate-600">
                Preparation resolves each organization to a native venue before it can do anything
                else.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={selected.size > 10}
            onClick={() => {
              setReopenPreparationSession(false)
              setPreparationOpen(true)
            }}
            className="min-h-11 rounded-md border border-slate-900 bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {selected.size > 10 ? 'Select 10 or fewer to prepare' : 'Open preparation workspace'}
          </button>
        </section>
      ) : null}

      {preparationOpen && (selected.size || reopenPreparationSession) ? (
        <ProspectPreparationWorkspace
          organizationIds={reopenPreparationSession ? [] : [...selected]}
          transport={preparationTransport}
          directoryHref={directoryHref}
          reopenSession={reopenPreparationSession}
          savedWritingGuide={
            salesReadiness?.writingGuide
              ? {
                  id: 'torchiko-v0.2',
                  label: 'Saved Torchiko writing guide v0.2',
                  sourceRef: salesReadiness.writingGuide.sourceRef,
                  state: salesReadiness.writingGuide.state,
                  sha256: salesReadiness.writingGuide.sha256,
                }
              : null
          }
        />
      ) : null}

      {!selected.size && !readOnly && !preparationOpen ? (
        <button
          type="button"
          onClick={() => {
            setReopenPreparationSession(true)
            setPreparationOpen(true)
          }}
          className="min-h-10 text-left text-xs font-semibold text-sky-800 hover:underline"
        >
          Reopen a recoverable selected-record workspace
        </button>
      ) : null}

      {selected.size && outreachAvailable && !readOnly ? (
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
            ref={campaignTriggerRef}
            type="button"
            onClick={() => setCampaignOpen(true)}
            className="rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white"
          >
            Create outreach campaign
          </button>
        </section>
      ) : null}

      <section
        aria-label="Prospect results"
        aria-busy={loading || loadingMore}
        className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
      >
        <div className="flex flex-col items-start gap-2 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
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
          <span role="status" aria-live="polite" className="text-xs font-medium text-slate-500">
            {result?.totalCount !== undefined ? `${result.totalCount} matched · ` : ''}
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
              Your filters are preserved. Retry the read; no records will be changed.
            </p>
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
              className="mt-3 min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-800"
            >
              Retry directory
            </button>
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
                    href={`${directoryHref}/${item.id}?directoryQuery=${encodeURIComponent(directoryQuery)}`}
                    onClick={(event) => {
                      if (
                        event.button === 0 &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.shiftKey &&
                        !event.altKey
                      )
                        navigatingToRecord.current = true
                      try {
                        recordDirectoryNavigation(window.sessionStorage, {
                          base: directoryHref,
                          query: directoryQuery,
                          ids: result.items.map((record) => record.id),
                          scrollY: window.scrollY,
                        })
                      } catch {
                        // The detail link remains usable without browser storage.
                      }
                    }}
                    className="grid min-w-0 w-full gap-3 overflow-hidden px-2 py-4 pr-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 xl:grid-cols-[minmax(0,1.4fr)_minmax(10rem,.8fr)_minmax(10rem,.8fr)]"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-950">{item.canonicalName}</p>
                      <p className="mt-1 truncate text-xs text-slate-500">
                        {item.venues[0]?.name ?? 'Organization prospect'} ·{' '}
                        {item.territory?.name ?? 'Territory not recorded'}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-medium text-slate-500">
                        <span>{item.organizationType ?? 'Type not recorded'}</span>
                        <span>{item.website ? 'Website recorded' : 'Website not recorded'}</span>
                        <span>
                          {item._count.sources
                            ? `${item._count.sources} source record${item._count.sources === 1 ? '' : 's'}`
                            : 'Source not recorded'}
                        </span>
                        <span>
                          {item._count.contacts
                            ? `${item._count.contacts} contact record${item._count.contacts === 1 ? '' : 's'}`
                            : 'No contact record'}
                        </span>
                        {item._count.outreachDrafts ? (
                          <span>
                            {item._count.outreachDrafts} saved draft revision
                            {item._count.outreachDrafts === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
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
                    <div className="min-w-0 space-y-2 text-sm text-slate-600">
                      <div className="flex min-w-0 items-center gap-2">
                        <CalendarClock className="h-4 w-4 shrink-0 text-slate-400" />
                        <span className="min-w-0 truncate">
                          {item.opportunity?.nextAction
                            ? `${item.opportunity.nextAction}${item.opportunity.nextActionAt ? ` · ${new Date(item.opportunity.nextActionAt).toLocaleDateString()}` : ''}`
                            : 'No next action recorded'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        {(item.contacts ?? []).some(
                          (contact) =>
                            contact.doNotContact ||
                            contact.permissionState === 'OPTED_OUT' ||
                            contact.permissionState === 'PROHIBITED',
                        ) ? (
                          <>
                            <CircleAlert className="h-3.5 w-3.5 text-rose-600" aria-hidden="true" />
                            <span>Suppression recorded</span>
                          </>
                        ) : item._count.contacts ? (
                          <>
                            <FileSearch
                              className="h-3.5 w-3.5 shrink-0 text-slate-500"
                              aria-hidden="true"
                            />
                            <span>
                              {(item.contacts ?? []).some(
                                (contact) => contact.permissionState === 'UNKNOWN',
                              )
                                ? 'Contact recorded · permission unknown'
                                : item._count.contacts > (item.contacts ?? []).length
                                  ? `Review all ${item._count.contacts} contacts before outreach`
                                  : 'Contact recorded · review before outreach'}
                            </span>
                          </>
                        ) : (
                          <>
                            <FileSearch className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                            <span>Contact details unknown</span>
                          </>
                        )}
                      </div>
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
          aria-describedby="campaign-description"
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-4"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setCampaignOpen(false)
          }}
        >
          <div
            ref={campaignDialogRef}
            className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-4 shadow-2xl sm:p-6"
          >
            <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-center">
              <span className="shrink-0 rounded-xl bg-sky-100 p-2 text-sky-700">
                <Layers3 className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 id="campaign-title" className="break-words text-lg font-bold text-slate-950">
                  Create outreach campaign
                </h2>
                <p id="campaign-description" className="text-sm text-slate-500">
                  Freeze {selected.size} selected prospect{selected.size === 1 ? '' : 's'} into a
                  review queue.
                </p>
              </div>
            </div>
            <label className="mt-5 block text-sm font-semibold text-slate-700">
              Campaign name
              <input
                ref={campaignNameRef}
                value={campaignName}
                onChange={(event) => setCampaignName(event.target.value)}
                className="mt-2 min-h-11 min-w-0 w-full rounded-xl border border-slate-300 px-3 font-normal"
                placeholder="Chicago museums · August"
              />
            </label>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setCampaignOpen(false)}
                className="min-h-11 w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold sm:w-auto"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!campaignName.trim()}
                onClick={() => void createCampaign()}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-center text-sm font-semibold text-white disabled:opacity-50 sm:w-auto"
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
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
    <label className={compact ? 'w-full sm:w-auto sm:min-w-48' : ''}>
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
