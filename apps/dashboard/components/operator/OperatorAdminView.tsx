'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'

import { OPERATOR_TABS, type OperatorTabId } from './operator-tabs'

export type { OperatorTabId }

/** Page frame: heading, section links (plain links; each tab loads its own data) and content. */
export function OperatorAdminView({
  tab,
  inboxCount,
  children,
  hrefBase = '/admin/operator',
}: {
  tab: OperatorTabId | null
  inboxCount: number | null
  children: ReactNode
  hrefBase?: string
}) {
  const searchParams = useSearchParams()
  const requestedTab = OPERATOR_TABS.find((item) => item.id === searchParams.get('tab'))?.id
  const [pendingTab, setPendingTab] = useState<OperatorTabId | null>(null)
  const [historyTab, setHistoryTab] = useState<OperatorTabId | null>(null)
  const pendingOrigin = useRef<OperatorTabId | null>(null)
  const pendingSawDestination = useRef(false)
  const activeTab = pendingTab ?? historyTab ?? requestedTab ?? tab
  const pending = pendingTab !== null && pendingTab !== tab

  useEffect(() => {
    if (!pendingTab) return
    const routeTab = requestedTab ?? tab
    if (routeTab === pendingTab) pendingSawDestination.current = true
    if (
      tab === pendingTab ||
      (pendingSawDestination.current && routeTab === pendingOrigin.current)
    ) {
      pendingOrigin.current = null
      pendingSawDestination.current = false
      setPendingTab(null)
    }
  }, [pendingTab, requestedTab, tab])

  useEffect(() => {
    if (!historyTab || tab !== historyTab) return
    setHistoryTab(null)
  }, [historyTab, tab])

  useEffect(() => {
    if (!pendingTab) return
    function cancelPendingOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        pendingOrigin.current = null
        pendingSawDestination.current = false
        setPendingTab(null)
      }
    }
    function restoreTabOnHistoryNavigation() {
      const next = new URLSearchParams(window.location.search).get('tab')
      const nextTab = OPERATOR_TABS.find((item) => item.id === next)?.id ?? null
      setHistoryTab(nextTab)
      pendingOrigin.current = null
      pendingSawDestination.current = false
      setPendingTab(null)
    }
    window.addEventListener('keydown', cancelPendingOnEscape)
    window.addEventListener('popstate', restoreTabOnHistoryNavigation)
    return () => {
      window.removeEventListener('keydown', cancelPendingOnEscape)
      window.removeEventListener('popstate', restoreTabOnHistoryNavigation)
    }
  }, [pendingTab])

  function selectTab(event: MouseEvent<HTMLAnchorElement>, nextTab: OperatorTabId) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.currentTarget.target === '_blank'
    )
      return
    if (pendingTab === null) {
      pendingOrigin.current = requestedTab ?? tab
      pendingSawDestination.current = false
    }
    setHistoryTab(null)
    setPendingTab(nextTab)
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-slate-950">Dot operator</h1>
        <p className="mt-1 max-w-prose text-sm text-slate-700">
          What the Dot has proposed, how much it may do on its own, which apps are connected, and a
          record of every call.
        </p>
      </header>
      <nav aria-label="Operator sections" className="border-b border-slate-300">
        <ul className="-mb-px flex gap-1 overflow-x-auto">
          {OPERATOR_TABS.map((item) => {
            const active = item.id === activeTab
            return (
              <li key={item.id}>
                <Link
                  href={`${hrefBase}?tab=${item.id}`}
                  onClick={(event) => selectTab(event, item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'inline-flex min-h-11 items-center border-b-2 px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
                    active
                      ? 'border-slate-950 text-slate-950'
                      : 'border-transparent text-slate-700 hover:text-slate-950',
                  ].join(' ')}
                >
                  {item.label}
                  {item.id === 'inbox' && inboxCount ? ` (${inboxCount})` : ''}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
      {pending ? (
        <div
          role="status"
          aria-busy="true"
          className="min-h-48 border-t border-slate-200 py-8 text-sm text-slate-700"
        >
          Loading operator information…
        </div>
      ) : (
        children
      )}
    </div>
  )
}
