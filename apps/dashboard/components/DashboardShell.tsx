'use client'

import { type ReactNode, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { SignOutButton, useOrganization, useUser } from '@clerk/nextjs'
import {
  ArrowLeft,
  Headphones,
  Home,
  Library,
  NotebookText,
  LogOut,
  Menu,
  Megaphone,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'

import { PathFinderBrand } from '@pathfinder/ui'

import { ClientTochiWorkspace } from './ClientTochiWorkspace'
import { ClientTochiBoundary } from './ClientTochiBoundary'

type DashboardShellProps = {
  children: ReactNode
  impersonatedTenantName?: string
  weeklyReportsAvailable?: boolean
}

const navigationItems = [
  { href: '/', label: 'Today', icon: Home },
  { href: '/information', label: 'Information', icon: Library },
  { href: '/operational-updates', label: 'Updates', icon: Megaphone },
  { href: '/weekly-reports', label: 'Reports', icon: NotebookText, reportsOnly: true },
  { href: '/ai-controls', label: 'Visitor experience', icon: Sparkles },
  { href: '/support', label: 'Help & changes', icon: Headphones },
  { href: '/settings', label: 'Account', icon: Settings },
] as const

const onboardingNavigationItems = [
  { href: '/', label: 'Today', icon: Home },
  { href: '#materials', label: 'Your information', icon: Library },
  { href: '/support', label: 'Questions & help', icon: Headphones },
  { href: '/settings', label: 'Account', icon: Settings },
] as const

function isActivePath(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)
}

export function DashboardShell({
  children,
  impersonatedTenantName,
  weeklyReportsAvailable = false,
}: DashboardShellProps) {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const { organization } = useOrganization()
  const { user } = useUser()
  const isPlatformAdmin =
    (user?.publicMetadata as { platform_role?: unknown } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  const orgName =
    impersonatedTenantName ??
    organization?.name ??
    (isPlatformAdmin ? 'Client workspace' : 'Your organization')
  const onboardingPath =
    pathname === '/onboarding/setup' || /^\/venues\/[^/]+\/onboarding(?:\/|$)/u.test(pathname)
  const venueOnboardingPath = /^\/venues\/[^/]+\/onboarding(?:\/|$)/u.test(pathname)
  const visibleNavigationItems = onboardingPath
    ? onboardingNavigationItems.map((item) =>
        item.href === '#materials'
          ? venueOnboardingPath
            ? { ...item, href: `${pathname}#materials` }
            : { ...item, href: null }
          : item,
      )
    : navigationItems.filter((item) => !('reportsOnly' in item) || weeklyReportsAvailable)

  useEffect(() => setMenuOpen(false), [pathname])

  useEffect(() => {
    if (!menuOpen) return
    const previousOverflow = document.body.style.overflow
    const trigger = menuButtonRef.current
    document.body.style.overflow = 'hidden'
    sidebarRef.current?.querySelector<HTMLElement>('a, button')?.focus()
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
      if (event.key !== 'Tab') return
      const focusable = sidebarRef.current?.querySelectorAll<HTMLElement>(
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
  }, [menuOpen])

  async function exitClientView() {
    await fetch('/api/admin/impersonate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: null }),
    })
    window.location.href = '/admin'
  }

  const navigation = (
    <>
      <nav className="mt-6 flex-1" aria-label="Client portal navigation">
        {visibleNavigationItems.map((item) => {
          const Icon = item.icon
          const active = item.href
            ? item.href.includes('#')
              ? item.href.startsWith(`${pathname}#`)
              : isActivePath(pathname, item.href)
            : true
          const className = [
            'relative flex min-h-11 items-center gap-3 border-l-2 px-3.5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-pf-accent',
            active
              ? 'border-[#f2a65a] bg-white/8 text-white'
              : 'border-transparent text-pf-light/80 hover:border-white/20 hover:bg-white/5 hover:text-white',
          ].join(' ')
          const content = (
            <>
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{item.label}</span>
            </>
          )
          return item.href ? (
            <Link
              key={`${item.label}-${item.href}`}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={className}
            >
              {content}
            </Link>
          ) : (
            <span key={item.label} aria-current="page" className={className}>
              {content}
            </span>
          )
        })}
        {isPlatformAdmin ? (
          <Link
            href="/admin"
            className="mt-4 flex min-h-11 items-center gap-3 border-t border-white/10 px-3.5 pt-5 text-sm font-medium text-pf-light/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Admin
          </Link>
        ) : null}
      </nav>
      <SignOutButton>
        <button
          type="button"
          className="mt-6 flex min-h-11 w-full items-center gap-3 border-l-2 border-transparent px-3.5 text-sm font-medium text-pf-light/80 hover:border-white/20 hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Sign out
        </button>
      </SignOutButton>
    </>
  )

  return (
    <div className="min-h-screen bg-pf-surface text-pf-deep">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-white/10 bg-pf-deep px-4 text-white lg:hidden">
        <PathFinderBrand
          gapClassName="gap-2"
          textClassName="text-white"
          textSizeClassName="text-base"
        />
        <button
          ref={menuButtonRef}
          type="button"
          aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={menuOpen}
          aria-controls="client-portal-navigation"
          onClick={() => setMenuOpen((open) => !open)}
          className="flex h-11 w-11 items-center justify-center hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </header>
      {menuOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-30 bg-pf-deep/50 lg:hidden"
        />
      ) : null}
      <aside
        ref={sidebarRef}
        id="client-portal-navigation"
        {...(menuOpen
          ? {
              role: 'dialog' as const,
              'aria-modal': true,
              'aria-label': 'Client portal navigation',
            }
          : {})}
        className={[
          'fixed inset-y-0 left-0 z-40 flex w-[min(86vw,252px)] flex-col bg-pf-deep p-5 text-slate-100 shadow-xl transition-transform motion-reduce:transition-none lg:visible lg:translate-x-0 lg:shadow-none',
          menuOpen ? 'visible translate-x-0' : 'invisible -translate-x-full',
        ].join(' ')}
      >
        <div className="border-b border-white/10 pb-6">
          <div className="hidden lg:block">
            <PathFinderBrand
              gapClassName="gap-2"
              textClassName="text-white"
              textSizeClassName="text-base"
            />
          </div>
          <p className="mt-5 truncate text-base font-semibold text-white">{orgName}</p>
          <p className="mt-1 text-xs text-pf-light/80">Client portal</p>
        </div>
        {navigation}
      </aside>
      <main
        className="min-w-0 lg:pl-[252px]"
        inert={menuOpen ? true : undefined}
        aria-hidden={menuOpen ? true : undefined}
      >
        {isPlatformAdmin ? (
          <div className="flex min-h-10 items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 sm:px-6">
            <p className="min-w-0 truncate text-xs font-medium text-amber-900 sm:text-sm">
              Client view: <span className="font-semibold">{orgName}</span>
            </p>
            <button
              type="button"
              onClick={exitClientView}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 border-l border-amber-300 pl-3 text-xs font-semibold text-amber-800 hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 sm:text-sm"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Admin
            </button>
          </div>
        ) : null}
        {children}
      </main>
      <ClientTochiBoundary>
        <ClientTochiWorkspace />
      </ClientTochiBoundary>
    </div>
  )
}
