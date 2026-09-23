'use client'

import { type ReactNode, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { SignOutButton, useOrganization, useUser } from '@clerk/nextjs'
import {
  ArrowLeft,
  ChevronDown,
  CreditCard,
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

import { TorchikoBrand } from '@pathfinder/ui'

import { ClientTochiWorkspace } from './ClientTochiWorkspace'
import { ClientTochiBoundary } from './ClientTochiBoundary'
import { useRouteChangeFocus } from './useRouteChangeFocus'
import { ADMIN_IMPERSONATION_ERROR, setAdminImpersonation } from '../lib/admin-impersonation'

type DashboardShellProps = {
  children: ReactNode
  impersonatedTenantName?: string
  weeklyReportsAvailable?: boolean
  paymentAvailable?: boolean
}

const navigationItems = [
  { href: '/', label: 'Today', icon: Home },
  { href: '/information', label: 'Information', icon: Library },
  { href: '/operational-updates', label: 'Updates', icon: Megaphone },
  { href: '/weekly-reports', label: 'Reports', icon: NotebookText, reportsOnly: true },
  { href: '/ai-controls', label: 'Visitor experience', icon: Sparkles },
  { href: '/support', label: 'Help & changes', icon: Headphones },
  { href: '/payment', label: 'Payment', icon: CreditCard, paymentOnly: true },
  { href: '/settings', label: 'Account', icon: Settings },
] as const

const onboardingNavigationItems = [
  { href: '/', label: 'Today', icon: Home },
  { href: '#materials', label: 'Your information', icon: Library },
  { href: '/support', label: 'Questions & help', icon: Headphones },
  { href: '/settings', label: 'Account', icon: Settings },
] as const

const clientNavigationGroups = [
  { label: 'Your guide', routes: ['Information', 'Updates', 'Visitor experience'] },
  { label: 'Activity', routes: ['Reports'] },
  { label: 'Account', routes: ['Payment', 'Account'] },
] as const

function isActivePath(pathname: string, href: string) {
  const path = href.split(/[?#]/u, 1)[0] || '/'
  return path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(path + '/')
}

function venueIdFromPath(pathname: string): string | null {
  if (pathname === '/venues/new' || pathname === '/venues/new/') return null
  const match = /^\/venues\/([^/]+)(?:\/|$)/u.exec(pathname)
  if (!match) return null
  try {
    const venueId = decodeURIComponent(match[1]!)
    return venueId.trim() && venueId.length <= 191 ? venueId : null
  } catch {
    return null
  }
}

function venueIdFromQuery(value: string | null): string | null {
  return value?.trim() && value.length <= 191 ? value : null
}

function scopedHref(path: '/' | '/support', venueId: string, returnTo?: string) {
  return (
    path +
    '?venue=' +
    encodeURIComponent(venueId) +
    (returnTo ? '&returnTo=' + encodeURIComponent(returnTo) : '')
  )
}

export function DashboardShell({
  children,
  impersonatedTenantName,
  weeklyReportsAvailable = false,
  paymentAvailable = false,
}: DashboardShellProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { organization } = useOrganization()
  const { user } = useUser()
  const isPlatformAdmin =
    (user?.publicMetadata as { platform_role?: unknown } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  const orgName =
    impersonatedTenantName ??
    organization?.name ??
    (isPlatformAdmin ? 'Client workspace' : 'Your organization')
  return (
    <DashboardShellView
      pathname={pathname}
      selectedVenueId={searchParams.get('venue')}
      routeKey={pathname + '?' + searchParams.toString()}
      orgName={orgName}
      isPlatformAdmin={isPlatformAdmin}
      weeklyReportsAvailable={weeklyReportsAvailable}
      paymentAvailable={paymentAvailable}
      signOutControl={
        <SignOutButton>
          <button
            type="button"
            className="mt-6 flex min-h-11 w-full items-center gap-3 border-l-2 border-transparent px-3.5 text-sm font-medium text-pf-light/80 hover:border-white/20 hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Sign out
          </button>
        </SignOutButton>
      }
      assistantControl={
        <ClientTochiBoundary>
          <ClientTochiWorkspace />
        </ClientTochiBoundary>
      }
    >
      {children}
    </DashboardShellView>
  )
}

type DashboardShellViewProps = {
  children: ReactNode
  pathname: string
  selectedVenueId: string | null
  routeKey?: string
  orgName: string
  isPlatformAdmin: boolean
  weeklyReportsAvailable?: boolean
  paymentAvailable?: boolean
  signOutControl?: ReactNode
  assistantControl?: ReactNode
}

// The authenticated wrapper supplies identity and controls. This shared view lets
// local fixtures exercise navigation without substituting application auth.
export function DashboardShellView({
  children,
  pathname,
  selectedVenueId,
  routeKey = pathname + '?venue=' + encodeURIComponent(selectedVenueId ?? ''),
  orgName,
  isPlatformAdmin,
  weeklyReportsAvailable = false,
  paymentAvailable = false,
  signOutControl,
  assistantControl,
}: DashboardShellViewProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [adminViewPending, setAdminViewPending] = useState(false)
  const [adminViewError, setAdminViewError] = useState<string | null>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const pathVenueId = venueIdFromPath(pathname)
  const onboardingVenueId = /\/onboarding(?:\/|$)/u.test(pathname) ? pathVenueId : null
  const onboardingPath = pathname === '/onboarding/setup' || onboardingVenueId !== null
  const venueId =
    pathVenueId ?? (pathname === '/onboarding/setup' ? null : venueIdFromQuery(selectedVenueId))
  const visibleNavigationItems = onboardingPath
    ? onboardingNavigationItems.map((item) =>
        item.href === '#materials'
          ? onboardingVenueId
            ? { ...item, href: pathname + '#materials' }
            : { ...item, href: null }
          : item.href === '/'
            ? { ...item, href: venueId ? scopedHref('/', venueId) : item.href }
            : item.href === '/support'
              ? {
                  ...item,
                  href: venueId
                    ? scopedHref('/support', venueId, onboardingVenueId ? pathname : undefined)
                    : item.href,
                }
              : item,
      )
    : navigationItems
        .filter(
          (item) =>
            (!('reportsOnly' in item) || weeklyReportsAvailable) &&
            (!('paymentOnly' in item) || paymentAvailable),
        )
        .map((item) =>
          item.href === '/' && venueId
            ? { ...item, href: scopedHref('/', venueId) }
            : item.href === '/support' && venueId
              ? { ...item, href: scopedHref('/support', venueId) }
              : item,
        )
  // Wait until the mobile drawer releases inert content before moving focus.
  useRouteChangeFocus(routeKey, mainRef, !menuOpen)

  useEffect(() => setMenuOpen(false), [routeKey])

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
    if (adminViewPending) return
    setAdminViewPending(true)
    setAdminViewError(null)
    try {
      await setAdminImpersonation(null)
      window.location.href = '/admin'
    } catch {
      setAdminViewError(ADMIN_IMPERSONATION_ERROR)
      setAdminViewPending(false)
    }
  }

  const navigation = (
    <>
      <nav className="mt-6 flex-1" aria-label="Client portal navigation">
        {onboardingPath ? (
          visibleNavigationItems.map((item) => {
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
          })
        ) : (
          <>
            {visibleNavigationItems
              .filter((item) => item.label === 'Today' || item.label === 'Help & changes')
              .map((item) => {
                const Icon = item.icon
                const active = isActivePath(pathname, item.href ?? '/')
                return (
                  <Link
                    key={item.label}
                    href={item.href ?? '/'}
                    aria-current={active ? 'page' : undefined}
                    className={`relative flex min-h-11 items-center gap-3 border-l-2 px-3.5 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-pf-accent ${active ? 'border-[#f2a65a] bg-white/8 text-white' : 'border-transparent text-pf-light/80 hover:border-white/20 hover:bg-white/5 hover:text-white'}`}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    <span>{item.label === 'Today' ? 'Home' : item.label}</span>
                  </Link>
                )
              })}
            {clientNavigationGroups.map((group) => {
              const groupItems = visibleNavigationItems.filter((item) =>
                (group.routes as readonly string[]).includes(item.label),
              )
              if (groupItems.length === 0) return null
              const containsCurrentRoute = groupItems.some((item) =>
                item.href ? isActivePath(pathname, item.href) : false,
              )
              return (
                <details
                  key={group.label}
                  open={containsCurrentRoute}
                  className="mt-1 border-t border-white/10 pt-1"
                >
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-pf-light/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-pf-accent [&::-webkit-details-marker]:hidden">
                    {group.label}
                    <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
                  </summary>
                  <div className="ml-3 border-l border-white/15 pl-2">
                    {groupItems.map((item) => {
                      const Icon = item.icon
                      const active = item.href ? isActivePath(pathname, item.href) : false
                      const className = [
                        'relative flex min-h-11 items-center gap-3 border-l-2 px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-pf-accent',
                        active
                          ? 'border-[#f2a65a] bg-white/8 text-white'
                          : 'border-transparent text-pf-light/80 hover:border-white/20 hover:bg-white/5 hover:text-white',
                      ].join(' ')
                      return item.href ? (
                        <Link
                          key={`${item.label}-${item.href}`}
                          href={item.href}
                          aria-current={active ? 'page' : undefined}
                          className={className}
                        >
                          <Icon className="h-4 w-4" aria-hidden="true" />
                          <span>{item.label}</span>
                        </Link>
                      ) : (
                        <span key={item.label} aria-current="page" className={className}>
                          <Icon className="h-4 w-4" aria-hidden="true" />
                          <span>{item.label}</span>
                        </span>
                      )
                    })}
                  </div>
                </details>
              )
            })}
          </>
        )}
        {isPlatformAdmin ? (
          <Link
            href="/admin"
            className="mt-4 flex min-h-11 items-center gap-3 border-t border-white/10 px-3.5 pt-5 text-sm font-medium text-pf-light/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Admin console
          </Link>
        ) : null}
      </nav>
      {signOutControl}
    </>
  )

  return (
    <div className="min-h-screen bg-pf-surface text-pf-deep">
      <a
        href="#client-main-content"
        className="sr-only fixed left-4 top-4 z-[60] rounded-lg bg-white px-4 py-3 font-semibold text-pf-deep shadow-xl focus:not-sr-only focus:outline-none focus:ring-2 focus:ring-pf-accent"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-white/10 bg-pf-deep px-4 text-white lg:hidden">
        <TorchikoBrand
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
      <div
        ref={sidebarRef}
        id="client-portal-navigation"
        role={menuOpen ? 'dialog' : 'complementary'}
        {...(menuOpen
          ? {
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
            <TorchikoBrand
              gapClassName="gap-2"
              textClassName="text-white"
              textSizeClassName="text-base"
            />
          </div>
          <p className="mt-5 truncate text-base font-semibold text-white">{orgName}</p>
          <p className="mt-1 text-xs text-pf-light/80">Client portal</p>
        </div>
        {navigation}
      </div>
      <main
        ref={mainRef}
        id="client-main-content"
        tabIndex={-1}
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
              aria-label="Open admin console"
              onClick={exitClientView}
              disabled={adminViewPending}
              aria-busy={adminViewPending}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 border-l border-amber-300 pl-3 text-xs font-semibold text-amber-800 hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 sm:text-sm"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Admin
            </button>
            {adminViewError ? (
              <p role="alert" className="text-xs font-medium text-red-800">
                {adminViewError}
              </p>
            ) : null}
          </div>
        ) : null}
        {children}
      </main>
      {assistantControl}
    </div>
  )
}
