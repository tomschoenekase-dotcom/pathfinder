'use client'

import { type ReactNode, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { SignOutButton, useOrganization, useUser } from '@clerk/nextjs'
import {
  Headphones,
  Home,
  LogOut,
  Menu,
  Megaphone,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'

import { PathFinderBrand } from '@pathfinder/ui'

type DashboardShellProps = { children: ReactNode; impersonatedTenantName?: string }

const navigationItems = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/operational-updates', label: 'Visitor updates', icon: Megaphone },
  { href: '/ai-controls', label: 'Tone', icon: Sparkles },
  { href: '/support', label: 'Support', icon: Headphones },
  { href: '/settings', label: 'Account', icon: Settings },
] as const

function isActivePath(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)
}

export function DashboardShell({ children, impersonatedTenantName }: DashboardShellProps) {
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
      <nav className="mt-7 flex-1 space-y-1" aria-label="Client portal navigation">
        {navigationItems.map((item) => {
          const Icon = item.icon
          const active = isActivePath(pathname, item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={[
                'flex min-h-11 items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent',
                active
                  ? 'bg-white/12 text-white'
                  : 'text-pf-light/90 hover:bg-white/7 hover:text-white',
              ].join(' ')}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          )
        })}
        {isPlatformAdmin ? (
          <Link
            href="/admin"
            className="mt-4 flex min-h-11 items-center gap-3 border-t border-white/10 px-3.5 pt-5 text-sm font-medium text-pf-light/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Admin
          </Link>
        ) : null}
      </nav>
      <SignOutButton>
        <button
          type="button"
          className="mt-6 flex min-h-11 w-full items-center gap-3 rounded-xl px-3.5 text-sm font-medium text-pf-light/90 hover:bg-white/7 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Sign out
        </button>
      </SignOutButton>
    </>
  )

  return (
    <div className="min-h-screen bg-pf-surface text-pf-deep">
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-pf-light bg-pf-deep px-4 text-white lg:hidden">
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
          className="flex h-11 w-11 items-center justify-center rounded-xl hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
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
        className={[
          'fixed inset-y-0 left-0 z-40 flex w-[min(86vw,280px)] flex-col bg-pf-deep p-5 text-slate-100 shadow-xl transition-transform motion-reduce:transition-none lg:visible lg:translate-x-0 lg:shadow-none',
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
      <main className="min-w-0 lg:pl-[280px]">
        {isPlatformAdmin ? (
          <div className="flex flex-col items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6">
            <p className="text-sm font-medium text-amber-800">
              Viewing the client portal for <span className="font-semibold">{orgName}</span>
            </p>
            <button
              type="button"
              onClick={exitClientView}
              className="min-h-11 shrink-0 rounded-lg px-2 text-sm font-semibold text-amber-700 hover:bg-amber-100 hover:text-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
            >
              Back to Admin
            </button>
          </div>
        ) : null}
        {children}
      </main>
    </div>
  )
}
