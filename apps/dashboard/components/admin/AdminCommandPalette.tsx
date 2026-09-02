'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Bot,
  Box,
  BriefcaseBusiness,
  Building2,
  Command,
  FileSearch,
  Headphones,
  MapPin,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

type SearchItem = {
  id: string
  tenantId: string | null
  venueId: string | null
  label: string
  detail: string
  route: string
  createdAt: Date
}
type SearchGroup = {
  name: string
  items: SearchItem[]
  nextCursor: { createdAt: string; id: string } | null
}
const GROUP_META: Record<string, { label: string; icon: LucideIcon }> = {
  clients: { label: 'Clients', icon: Building2 },
  venues: { label: 'Venues', icon: MapPin },
  content: { label: 'Content', icon: FileSearch },
  support: { label: 'Support', icon: Headphones },
  agents: { label: 'Agent runs', icon: Bot },
  jobs: { label: 'Jobs', icon: BriefcaseBusiness },
  packages: { label: 'Venue packages', icon: Box },
  evaluations: { label: 'Evaluation runs', icon: FileSearch },
}
const SEARCH_REQUEST_TIMEOUT_MS = 15_000

export function AdminCommandPalette({ compact = false }: { compact?: boolean }) {
  const router = useRouter()
  const client = useTRPCClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const loadMoreControllerRef = useRef<AbortController | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<SearchGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [loadingGroup, setLoadingGroup] = useState<string | null>(null)
  const matches = useMemo(() => groups.flatMap((group) => group.items), [groups])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (!triggerRef.current || triggerRef.current.getClientRects().length === 0) return
        event.preventDefault()
        setOpen((value) => !value)
      }
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  useEffect(() => {
    if (open) window.requestAnimationFrame(() => inputRef.current?.focus())
    else {
      loadMoreControllerRef.current?.abort()
      loadMoreControllerRef.current = null
      setQuery('')
      setGroups([])
    }
  }, [open])
  useEffect(
    () => () => {
      loadMoreControllerRef.current?.abort()
    },
    [],
  )
  useEffect(() => {
    if (!open) return
    const normalized = query.trim()
    if (!normalized) {
      setGroups([])
      setLoading(false)
      setLoadError(false)
      return
    }
    let current = true
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      setLoading(true)
      setLoadError(false)
      void runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: SEARCH_REQUEST_TIMEOUT_MS,
        request: (signal) =>
          client.admin.searchAdminOs.query({ query: normalized, limitPerGroup: 5 }, { signal }),
      })
        .then((result) => {
          if (current) {
            setGroups(result.groups)
            setActiveIndex(0)
          }
        })
        .catch(() => {
          if (current) setLoadError(true)
        })
        .finally(() => {
          if (current) setLoading(false)
        })
    }, 180)
    return () => {
      current = false
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [client, open, query])
  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    const trigger = triggerRef.current
    document.body.style.overflow = 'hidden'
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    document.addEventListener('keydown', trap)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', trap)
      trigger?.focus()
    }
  }, [open])

  function navigate(item: SearchItem) {
    setOpen(false)
    router.push(item.route)
  }
  async function loadMore(group: SearchGroup) {
    if (!group.nextCursor || loadingGroup) return
    const cursor = group.nextCursor
    loadMoreControllerRef.current?.abort()
    const controller = new AbortController()
    loadMoreControllerRef.current = controller
    setLoadingGroup(group.name)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: SEARCH_REQUEST_TIMEOUT_MS,
        request: (signal) =>
          client.admin.searchAdminOs.query(
            {
              query: query.trim(),
              limitPerGroup: 5,
              group: group.name as
                | 'clients'
                | 'venues'
                | 'content'
                | 'support'
                | 'agents'
                | 'jobs'
                | 'packages'
                | 'evaluations',
              cursor,
            },
            { signal },
          ),
      })
      if (controller.signal.aborted) return
      const next = result.groups[0]
      if (next)
        setGroups((current) =>
          current.map((item) =>
            item.name === group.name
              ? { ...item, items: [...item.items, ...next.items], nextCursor: next.nextCursor }
              : item,
          ),
        )
    } catch {
      if (!controller.signal.aborted) setLoadError(true)
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null
        setLoadingGroup(null)
      }
    }
  }
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className={[
          'inline-flex min-h-11 items-center gap-3 border border-slate-700 bg-slate-900/70 px-3 text-left text-sm text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
          compact ? 'rounded-xl' : 'w-full rounded-xl',
        ].join(' ')}
        aria-label="Search Admin OS"
      >
        <Search className="h-4 w-4" aria-hidden="true" />
        {compact ? null : <span className="min-w-0 flex-1 truncate">Search Admin OS</span>}
        <span className="hidden items-center gap-1 rounded border border-slate-600 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 sm:inline-flex">
          <Command className="h-3 w-3" aria-hidden="true" />K
        </span>
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/60 px-4 pt-[8vh] backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-command-title"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false)
          }}
        >
          <div
            ref={dialogRef}
            className="w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
          >
            <h2 id="admin-command-title" className="sr-only">
              Admin OS command search
            </h2>
            <div className="flex items-center gap-3 border-b border-slate-200 px-4">
              <Search className="h-5 w-5 text-slate-400" aria-hidden="true" />
              <input
                ref={inputRef}
                role="combobox"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls="admin-os-search-results"
                aria-activedescendant={
                  matches[activeIndex] ? `admin-search-${activeIndex}` : undefined
                }
                aria-label="Search clients, venues, operations, and evidence"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setActiveIndex((value) => Math.min(value + 1, Math.max(matches.length - 1, 0)))
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setActiveIndex((value) => Math.max(value - 1, 0))
                  } else if (event.key === 'Enter' && matches[activeIndex]) {
                    event.preventDefault()
                    navigate(matches[activeIndex])
                  }
                }}
                placeholder="Search clients, venues, content, support, agents, jobs…"
                className="min-h-14 min-w-0 flex-1 bg-transparent text-base text-slate-950 outline-none placeholder:text-slate-400"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-2 text-slate-500 focus-visible:ring-2 focus-visible:ring-sky-500"
                aria-label="Close search"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div
              id="admin-os-search-results"
              role="listbox"
              className="max-h-[62vh] overflow-y-auto p-2"
              aria-label="Admin OS search results"
            >
              {loading ? (
                <p className="px-4 py-10 text-center font-medium text-slate-900" role="status">
                  Searching Admin OS…
                </p>
              ) : loadError ? (
                <div className="px-4 py-10 text-center" role="alert">
                  <p className="font-medium text-slate-900">Admin OS search is unavailable</p>
                  <p className="mt-1 text-sm text-slate-500">
                    Your query is preserved. Try again in a moment.
                  </p>
                </div>
              ) : !query.trim() ? (
                <p className="px-4 py-10 text-center text-sm text-slate-500">
                  Type to search operational records across Torchiko.
                </p>
              ) : matches.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-slate-500">
                  No matching operational records.
                </p>
              ) : (
                groups.map((group) => {
                  const meta = GROUP_META[group.name] ?? { label: group.name, icon: Search }
                  const Icon = meta.icon
                  return group.items.length ? (
                    <section
                      key={group.name}
                      aria-labelledby={`group-${group.name}`}
                      className="mb-3"
                    >
                      <h3
                        id={`group-${group.name}`}
                        className="px-3 py-2 text-xs font-bold uppercase tracking-wider text-slate-500"
                      >
                        {meta.label}
                      </h3>
                      <ul>
                        {group.items.map((item) => {
                          const index = matches.findIndex(
                            (match) => match.id === item.id && match.route === item.route,
                          )
                          return (
                            <li key={`${group.name}:${item.id}`}>
                              <button
                                id={`admin-search-${index}`}
                                role="option"
                                aria-selected={index === activeIndex}
                                type="button"
                                onMouseEnter={() => setActiveIndex(index)}
                                onClick={() => navigate(item)}
                                className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${index === activeIndex ? 'bg-sky-50' : 'hover:bg-slate-100'}`}
                              >
                                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                                  <Icon className="h-4 w-4" aria-hidden="true" />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium text-slate-950">
                                    {item.label}
                                  </span>
                                  <span className="block truncate text-xs text-slate-500">
                                    {item.detail}
                                  </span>
                                </span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                      {group.nextCursor ? (
                        <button
                          type="button"
                          disabled={loadingGroup === group.name}
                          onClick={() => void loadMore(group)}
                          className="ml-3 mt-1 rounded-lg px-3 py-2 text-xs font-semibold text-sky-700 disabled:opacity-50"
                        >
                          {loadingGroup === group.name
                            ? 'Loading…'
                            : `More ${meta.label.toLowerCase()}`}
                        </button>
                      ) : null}
                    </section>
                  ) : null
                })
              )}
            </div>
            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
              <span>{matches.length} bounded results</span>
              <Link
                href="/admin/new"
                onClick={() => setOpen(false)}
                className="font-semibold text-sky-700"
              >
                Create client
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
