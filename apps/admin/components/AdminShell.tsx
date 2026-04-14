'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { UserButton } from '@clerk/nextjs'
import { usePathname } from 'next/navigation'

type AdminShellProps = {
  children: ReactNode
}

const navigationItems = [
  { href: '/clients', label: 'Clients' },
  { href: '/platform', label: 'Platform' },
] as const

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AdminShell({ children }: AdminShellProps) {
  const pathname = usePathname()

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-800 bg-slate-950 text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-4 lg:px-10">
          <div className="flex items-center gap-4">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-white">
              PathFinder Admin
            </p>
            <div className="h-5 w-px bg-slate-700" aria-hidden="true" />
            <nav className="flex items-center gap-2" aria-label="Admin navigation">
              {navigationItems.map((item) => {
                const active = isActivePath(pathname, item.href)

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={[
                      'rounded-full px-4 py-2 text-sm font-medium transition',
                      active
                        ? 'bg-cyan-400 text-slate-950'
                        : 'text-slate-300 hover:bg-slate-900 hover:text-white',
                    ].join(' ')}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </nav>
          </div>

          <UserButton />
        </div>
      </header>

      <main className="px-6 py-8 lg:px-10">{children}</main>
    </div>
  )
}
