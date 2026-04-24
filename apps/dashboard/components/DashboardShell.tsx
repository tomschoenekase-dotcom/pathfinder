'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { SignOutButton, useOrganization } from '@clerk/nextjs'
import { Bot, Building2, ChartColumn, Home, LogOut, Megaphone } from 'lucide-react'

type DashboardShellProps = {
  children: ReactNode
}

const navigationItems = [
  { href: '/', label: 'Overview', icon: Home },
  { href: '/venues', label: 'Venues', icon: Building2 },
  { href: '/analytics', label: 'Analytics', icon: ChartColumn },
  { href: '/ai-controls', label: 'AI Controls', icon: Bot },
  { href: '/operational-updates', label: 'Operational Updates', icon: Megaphone },
] as const

function isActivePath(pathname: string, href: string) {
  if (href === '/') {
    return pathname === '/'
  }

  return pathname === href || pathname.startsWith(`${href}/`)
}

export function DashboardShell({ children }: DashboardShellProps) {
  const pathname = usePathname()
  const { organization } = useOrganization()
  const orgName = organization?.name ?? 'Your organization'

  return (
    <div className="min-h-screen bg-pf-surface text-pf-deep">
      <div className="grid min-h-screen grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-r border-pf-primary/30 bg-pf-deep text-slate-100">
          <div className="flex h-full flex-col p-6">
            <div className="space-y-3 border-b border-pf-primary/20 pb-6">
              <img src="/pathfinder-logo.svg" alt="PathFinder" className="h-7 w-auto" />
              <div>
                <h1 className="text-lg font-semibold text-pf-white">{orgName}</h1>
                <p className="mt-1 text-sm text-pf-light/50">Tenant dashboard</p>
              </div>
            </div>

            <nav className="mt-6 flex-1 space-y-2" aria-label="Dashboard navigation">
              {navigationItems.map((item) => {
                const Icon = item.icon
                const active = isActivePath(pathname, item.href)

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={[
                      'flex min-h-11 items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition',
                      active
                        ? 'border-l-2 border-pf-accent bg-pf-primary/20 text-white'
                        : 'text-pf-light/70 hover:bg-pf-primary/10 hover:text-white',
                    ].join(' ')}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                )
              })}
            </nav>

            <div className="pt-6">
              <SignOutButton>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-pf-primary/30 px-4 py-3 text-sm font-medium text-pf-light/70 transition hover:border-pf-primary hover:bg-pf-primary/10 hover:text-white"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  <span>Sign out</span>
                </button>
              </SignOutButton>
            </div>
          </div>
        </aside>

        <main className="min-w-0 bg-pf-surface">{children}</main>
      </div>
    </div>
  )
}
