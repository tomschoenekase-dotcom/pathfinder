'use client'

import { type ReactNode, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { SignOutButton, useOrganization, useUser } from '@clerk/nextjs'
import {
  ArrowLeft,
  CircleUserRound,
  CreditCard,
  Home,
  Library,
  LogOut,
  Megaphone,
  Menu,
  MessageCircle,
  Palette,
  ShieldCheck,
  X,
} from 'lucide-react'

import { TorchikoWordmark } from './TorchikoWordmark'
import { ClientTochiWorkspace } from './ClientTochiWorkspace'
import { ClientTochiBoundary } from './ClientTochiBoundary'
import { useRouteChangeFocus } from './useRouteChangeFocus'
import { ADMIN_IMPERSONATION_ERROR, setAdminImpersonation } from '../lib/admin-impersonation'

type DashboardShellProps = {
  children: ReactNode
  impersonatedTenantName?: string
}

type ScopedPath = '/' | '/support' | '/look-and-feel'

// Five destinations. Older client routes stay reachable as deep links and highlight the
// destination that now owns them instead of adding navigation.
const navigationItems: ReadonlyArray<{
  href: string
  label: string
  icon: typeof Home
  scoped?: ScopedPath
  owns: readonly string[]
}> = [
  { href: '/', label: 'Home', icon: Home, scoped: '/', owns: ['/', '/information', '/venues'] },
  {
    href: '/look-and-feel',
    label: 'Look & feel',
    icon: Palette,
    scoped: '/look-and-feel',
    owns: ['/look-and-feel', '/ai-controls', '/chat-design'],
  },
  {
    href: '/operational-updates',
    label: 'Updates',
    icon: Megaphone,
    owns: ['/operational-updates'],
  },
  {
    href: '/support',
    label: 'Help',
    icon: MessageCircle,
    scoped: '/support',
    owns: ['/support', '/help'],
  },
  {
    href: '/settings',
    label: 'Account',
    icon: CircleUserRound,
    owns: ['/settings', '/weekly-reports'],
  },
  { href: '/payment', label: 'Billing', icon: CreditCard, owns: ['/payment'] },
]

const onboardingNavigationItems = [
  { href: '/', label: 'Home', icon: Home },
  { href: '#materials', label: 'Your information', icon: Library },
  { href: '/support', label: 'Help', icon: MessageCircle },
  { href: '/settings', label: 'Account', icon: CircleUserRound },
] as const

function isActivePath(pathname: string, href: string) {
  const path = href.split(/[?#]/u, 1)[0] || '/'
  return path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(path + '/')
}

function ownsPath(pathname: string, owned: readonly string[]) {
  return owned.some((path) =>
    path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(path + '/'),
  )
}

function navLinkClass(active: boolean) {
  return [
    'relative flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-[0.95rem] transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus',
    active
      ? 'bg-tk-ink-wash font-semibold text-tk-ink before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-tk-ink'
      : 'font-medium text-tk-ink/80 hover:bg-tk-ink/[0.04] hover:text-tk-ink',
  ].join(' ')
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

function scopedHref(path: ScopedPath, venueId: string, returnTo?: string) {
  return (
    path +
    '?venue=' +
    encodeURIComponent(venueId) +
    (returnTo ? '&returnTo=' + encodeURIComponent(returnTo) : '')
  )
}

export function DashboardShell({ children, impersonatedTenantName }: DashboardShellProps) {
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
      signOutControl={
        <SignOutButton>
          <button
            type="button"
            className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-tk-soft hover:bg-tk-ink/[0.04] hover:text-tk-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus"
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
  const onboardingItems = onboardingNavigationItems.map((item) =>
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
  const clientItems = navigationItems.map((item) => ({
    ...item,
    href: item.scoped && venueId ? scopedHref(item.scoped, venueId) : item.href,
  }))
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
      <nav className="mt-7 flex-1" aria-label="Client portal navigation">
        <ul className="space-y-1">
          {onboardingPath
            ? onboardingItems.map((item) => {
                const Icon = item.icon
                const active = item.href
                  ? item.href.includes('#')
                    ? item.href.startsWith(`${pathname}#`)
                    : isActivePath(pathname, item.href)
                  : true
                const content = (
                  <>
                    <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                    <span>{item.label}</span>
                  </>
                )
                return (
                  <li key={item.label}>
                    {item.href ? (
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={navLinkClass(active)}
                      >
                        {content}
                      </Link>
                    ) : (
                      <span aria-current="page" className={navLinkClass(true)}>
                        {content}
                      </span>
                    )}
                  </li>
                )
              })
            : clientItems.map((item) => {
                const Icon = item.icon
                const active = ownsPath(pathname, item.owns)
                return (
                  <li key={item.label}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={navLinkClass(active)}
                    >
                      <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                )
              })}
        </ul>
        {isPlatformAdmin ? (
          <Link
            href="/admin"
            className="mt-5 flex min-h-11 items-center gap-3 border-t border-tk-rule px-3 pt-4 text-sm font-medium text-tk-soft hover:text-tk-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Admin console
          </Link>
        ) : null}
      </nav>
      <div className="border-t border-tk-rule pt-4">
        <p className="truncate px-3 text-sm font-semibold text-tk-ink" title={orgName}>
          {orgName}
        </p>
        <div className="mt-1">{signOutControl}</div>
      </div>
    </>
  )

  return (
    <div className="min-h-screen bg-tk-paper text-tk-ink">
      <a
        href="#client-main-content"
        className="sr-only fixed left-4 top-4 z-[60] rounded-lg bg-white px-4 py-3 font-semibold text-tk-ink shadow-xl focus:not-sr-only focus:outline-none focus:ring-2 focus:ring-tk-focus"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-tk-rule bg-tk-paper px-4 text-tk-ink lg:hidden">
        <TorchikoWordmark height={31} />
        <button
          ref={menuButtonRef}
          type="button"
          aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={menuOpen}
          aria-controls="client-portal-navigation"
          onClick={() => setMenuOpen((open) => !open)}
          className="-mr-2 flex h-11 w-11 items-center justify-center rounded-lg hover:bg-tk-ink/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tk-focus"
        >
          {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </header>
      {menuOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-30 bg-tk-ink/35 lg:hidden"
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
          'fixed inset-y-0 left-0 z-40 flex w-[min(84vw,248px)] flex-col border-r border-tk-rule bg-tk-paper px-4 pb-5 pt-6 text-tk-ink shadow-xl transition-transform motion-reduce:transition-none lg:visible lg:w-[232px] lg:translate-x-0 lg:shadow-none',
          menuOpen ? 'visible translate-x-0' : 'invisible -translate-x-full',
        ].join(' ')}
      >
        <div className="px-3">
          <TorchikoWordmark height={38} />
        </div>
        {navigation}
      </div>
      <main
        ref={mainRef}
        id="client-main-content"
        tabIndex={-1}
        className="min-w-0 focus:outline-none lg:pl-[232px]"
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
