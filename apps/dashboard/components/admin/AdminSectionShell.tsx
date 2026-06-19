'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

type AdminSectionShellProps = {
  children: ReactNode
}

const navigationItems = [{ href: '/admin', label: 'Overview' }] as const

function isActivePath(pathname: string, href: string) {
  if (href === '/admin') {
    return pathname === '/admin'
  }

  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AdminSectionShell({ children }: AdminSectionShellProps) {
  const pathname = usePathname()

  return (
    <div className="min-h-screen bg-pf-surface text-pf-deep">
      <header className="border-b border-pf-light bg-pf-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
          <div className="flex items-center gap-4">
            <span className="text-lg font-semibold tracking-tight text-pf-deep">
              PathFinder <span className="text-pf-accent">Admin</span>
            </span>
            <div className="h-5 w-px bg-pf-light" aria-hidden="true" />
            <nav className="flex items-center gap-1" aria-label="Admin navigation">
              {navigationItems.map((item) => {
                const active = isActivePath(pathname, item.href)

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={[
                      'rounded-full px-4 py-2 text-sm font-medium transition',
                      active
                        ? 'bg-pf-primary/10 text-pf-primary'
                        : 'text-pf-deep/60 hover:bg-pf-primary/5 hover:text-pf-primary',
                    ].join(' ')}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </nav>
          </div>

          <Link
            href="/"
            className="text-sm font-medium text-pf-deep/50 transition hover:text-pf-primary"
          >
            ← Operator dashboard
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  )
}
