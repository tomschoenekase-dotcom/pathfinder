'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Building2, Command, Search, X } from 'lucide-react'

import { useTRPCClient } from '../../lib/trpc'

export type AdminSearchClient = {
  id: string
  name: string
  slug: string
  status: string
}

type AdminCommandPaletteProps = { compact?: boolean }

export function AdminCommandPalette({ compact = false }: AdminCommandPaletteProps) {
  const router = useRouter()
  const client = useTRPCClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [clients, setClients] = useState<AdminSearchClient[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        // The admin shell renders separate responsive navigation trees. Only
        // the currently visible palette should answer the global shortcut.
        if (!triggerRef.current || triggerRef.current.getClientRects().length === 0) return
        event.preventDefault()
        setOpen((current) => !current)
      }
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (open) {
      window.requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      setQuery('')
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let current = true
    const timeout = window.setTimeout(() => {
      setLoading(true)
      setLoadError(false)
      void client.admin.searchClients
        .query({ query: query.trim(), limit: 12 })
        .then((result) => {
          if (!current) return
          setClients(
            result.items.map((item) => ({
              id: item.id,
              name: item.name,
              slug: item.slug,
              status: item.status,
            })),
          )
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
      window.clearTimeout(timeout)
    }
  }, [client, open, query])

  useEffect(() => {
    if (!open) return

    const previousOverflow = document.body.style.overflow
    const trigger = triggerRef.current
    document.body.style.overflow = 'hidden'

    function keepFocusInDialog(event: KeyboardEvent) {
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

    document.addEventListener('keydown', keepFocusInDialog)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', keepFocusInDialog)
      trigger?.focus()
    }
  }, [open])

  const matches = clients

  function openClient(clientId: string) {
    setOpen(false)
    router.push(`/admin/clients/${clientId}`)
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
        aria-label="Search PathFinder clients"
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        {compact ? null : <span className="min-w-0 flex-1 truncate">Find a client</span>}
        <span className="hidden items-center gap-1 rounded border border-slate-600 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 sm:inline-flex">
          <Command className="h-3 w-3" aria-hidden="true" />K
        </span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/60 px-4 pt-[12vh] backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="PathFinder command search"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false)
          }}
        >
          <div
            ref={dialogRef}
            className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
          >
            <div className="flex items-center gap-3 border-b border-slate-200 px-4">
              <Search className="h-5 w-5 text-slate-400" aria-hidden="true" />
              <input
                ref={inputRef}
                aria-label="Search clients by name or slug"
                aria-controls="admin-client-search-results"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && matches[0]) openClient(matches[0].id)
                }}
                placeholder="Search clients by name or slug"
                className="min-h-14 min-w-0 flex-1 bg-transparent text-base text-slate-950 outline-none placeholder:text-slate-400"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                aria-label="Close search"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="max-h-[55vh] overflow-y-auto p-2">
              {loading ? (
                <div className="px-4 py-10 text-center" role="status">
                  <p className="font-medium text-slate-900">Loading client index…</p>
                </div>
              ) : loadError ? (
                <div className="px-4 py-10 text-center" role="alert">
                  <p className="font-medium text-slate-900">Client search is unavailable</p>
                  <button
                    type="button"
                    onClick={() => {
                      setClients([])
                      setLoadError(false)
                      setOpen(false)
                      window.requestAnimationFrame(() => setOpen(true))
                    }}
                    className="mt-2 text-sm font-semibold text-sky-700 hover:text-sky-900"
                  >
                    Try again
                  </button>
                </div>
              ) : matches.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <p className="font-medium text-slate-900">No matching clients</p>
                  <p className="mt-1 text-sm text-slate-500">Try a client name or account slug.</p>
                </div>
              ) : (
                <ul
                  id="admin-client-search-results"
                  className="space-y-1"
                  aria-label="Client search results"
                >
                  {matches.map((client, index) => (
                    <li key={client.id}>
                      <button
                        type="button"
                        onClick={() => openClient(client.id)}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                      >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                          <Building2 className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-slate-950">
                            {client.name}
                          </span>
                          <span className="block truncate text-xs text-slate-500">
                            {client.slug} · {client.status.toLocaleLowerCase()}
                          </span>
                        </span>
                        {index === 0 ? (
                          <span className="text-xs font-medium text-slate-400">Enter</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
              <span>{clients.length} clients indexed</span>
              <Link
                href="/admin/new"
                onClick={() => setOpen(false)}
                className="font-semibold text-sky-700 hover:text-sky-900"
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
