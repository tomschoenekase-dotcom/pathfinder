'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Building2,
  ContactRound,
  CreditCard,
  ExternalLink,
  BookOpen,
  BrainCircuit,
  Home,
  Menu,
  Plus,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useState } from 'react'

import { TorchikoBrand } from '@pathfinder/ui'

import { AdminCommandPalette } from './AdminCommandPalette'
import { CopyForCodex } from './CopyForCodex'
import { useRouteChangeFocus } from '../useRouteChangeFocus'

type AdminSectionShellProps = {
  children: ReactNode
  routePathname?: string
}

const navigationItems = [
  { href: '/admin', label: 'Needs you', icon: Home, exact: true },
  { href: '/admin/directory', label: 'Clients', icon: Building2 },
  { href: '/admin/prospects', label: 'Prospects', icon: ContactRound },
  { href: '/admin/company-brain', label: 'Company Brain', icon: BrainCircuit },
  { href: '/admin/operations', label: 'System', icon: ShieldCheck },
] as const

const systemTabs = [
  { href: '/admin/operations', label: 'Operations', icon: ShieldCheck },
  { href: '/admin/ai', label: 'AI', icon: BrainCircuit },
  { href: '/admin/billing', label: 'Billing', icon: CreditCard },
  { href: '/admin/help', label: 'Help', icon: BookOpen },
] as const

function isActivePath(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AdminSectionShell({ children, routePathname }: AdminSectionShellProps) {
  const livePathname = usePathname()
  const pathname = routePathname ?? livePathname
  const inSystem =
    systemTabs.some((tab) => isActivePath(pathname, tab.href)) ||
    pathname === '/admin/character-lab'
  const scopedIds = /^\/admin\/clients\/([^/]+)(?:\/venues\/([^/]+))?/u.exec(pathname)
  const [mobileOpen, setMobileOpen] = useState(false)
  const mobileCloseRef = useRef<HTMLButtonElement>(null)
  const mobileTriggerRef = useRef<HTMLButtonElement>(null)
  const mobilePanelRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)

  useRouteChangeFocus(pathname, mainRef)

  useEffect(() => setMobileOpen(false), [pathname])

  useEffect(() => {
    if (!mobileOpen) return
    const previousOverflow = document.body.style.overflow
    const trigger = mobileTriggerRef.current
    document.body.style.overflow = 'hidden'
    mobileCloseRef.current?.focus()
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileOpen(false)
      if (event.key !== 'Tab') return
      const focusable = mobilePanelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', closeOnEscape)
      trigger?.focus()
    }
  }, [mobileOpen])

  const sidebar = (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <div className="border-b border-slate-800 px-5 py-5">
        <TorchikoBrand textClassName="text-white" textSizeClassName="text-base" />
        <div className="mt-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-sky-300">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Torchiko OS
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3" aria-label="Torchiko OS navigation">
        {navigationItems.map((item) => {
          const active =
            item.href === '/admin/operations'
              ? inSystem
              : item.href === '/admin/directory'
                ? isActivePath(pathname, item.href) ||
                  pathname.startsWith('/admin/clients/') ||
                  pathname === '/admin/new'
                : isActivePath(pathname, item.href, 'exact' in item ? item.exact : false)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              aria-current={active ? 'page' : undefined}
              className={[
                'flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                active
                  ? 'bg-sky-400/15 text-sky-100'
                  : 'text-slate-400 hover:bg-slate-900 hover:text-white',
              ].join(' ')}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="space-y-2 border-t border-slate-800 p-4">
        <Link
          href="/admin/new"
          className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-sky-700 px-3 text-sm font-semibold text-white transition hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New client
        </Link>
        <Link
          href="/"
          className="flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium text-slate-400 transition hover:bg-slate-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Open client portal
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <a
        href="#admin-main-content"
        className="sr-only fixed left-4 top-4 z-[60] rounded-lg bg-white px-4 py-3 font-semibold text-slate-950 shadow-xl focus:not-sr-only focus:outline-none focus:ring-2 focus:ring-sky-500"
      >
        Skip to main content
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 lg:block">{sidebar}</aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/60"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          />
          <aside
            ref={mobilePanelRef}
            id="admin-mobile-navigation"
            className="relative h-full w-[min(88vw,18rem)] shadow-2xl"
          >
            <button
              ref={mobileCloseRef}
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-3 z-10 rounded-lg p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
              aria-label="Close navigation"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
            {sidebar}
          </aside>
        </div>
      ) : null}

      <div className="min-w-0 w-full lg:pl-72">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex min-h-16 items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-3">
              <button
                ref={mobileTriggerRef}
                type="button"
                onClick={() => setMobileOpen(true)}
                aria-expanded={mobileOpen}
                aria-controls="admin-mobile-navigation"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 lg:hidden"
                aria-label="Open navigation"
              >
                <Menu className="h-5 w-5" aria-hidden="true" />
              </button>
              <div className="hidden sm:block">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
                  Founder operations
                </p>
                <p className="text-sm font-semibold text-slate-900">Platform scope</p>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <AdminCommandPalette light />
              <CopyForCodex
                route={pathname}
                tenant={scopedIds?.[1] ? { id: scopedIds[1], name: '' } : null}
                venue={scopedIds?.[2] ? { id: scopedIds[2], name: '' } : null}
              />
            </div>
          </div>
          {inSystem ? (
            <nav
              aria-label="System sections"
              className="flex gap-1 overflow-x-auto border-t border-slate-100 px-4 sm:px-6 lg:px-8"
            >
              {systemTabs.map((tab) => {
                const Icon = tab.icon
                const active =
                  isActivePath(pathname, tab.href) ||
                  (tab.href === '/admin/ai' && pathname === '/admin/character-lab')
                return (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    aria-current={active ? 'page' : undefined}
                    className={`inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${active ? 'border-sky-700 text-sky-900' : 'border-transparent text-slate-600 hover:text-slate-950'}`}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {tab.label}
                  </Link>
                )
              })}
            </nav>
          ) : null}
        </header>

        <main
          ref={mainRef}
          id="admin-main-content"
          tabIndex={-1}
          className="mx-auto w-full min-w-0 max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
        >
          {children}
        </main>
      </div>
    </div>
  )
}
