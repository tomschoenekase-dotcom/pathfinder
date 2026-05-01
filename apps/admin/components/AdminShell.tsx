'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { UserButton } from '@clerk/nextjs'
import { usePathname } from 'next/navigation'

import { PathFinderBrand } from './PathFinderBrand'

type AdminShellProps = {
  children: ReactNode
}

const navigationItems = [{ href: '/clients', label: 'Clients' }] as const

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AdminShell({ children }: AdminShellProps) {
  const pathname = usePathname()

  return (
    <div className="min-h-screen bg-pf-deep text-pf-light">
      <header className="border-b border-pf-primary/20 bg-[#07192C] text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-4 lg:px-10">
          <div className="flex items-center gap-4">
            <div className="flex flex-col gap-2">
              <PathFinderBrand textClassName="text-white" />
              <span className="w-fit rounded-full bg-pf-accent/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-pf-accent">
                Admin
              </span>
            </div>
            <div className="h-5 w-px bg-pf-primary/30" aria-hidden="true" />
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
                        ? 'border-l-2 border-pf-accent bg-pf-primary/30 text-white'
                        : 'text-pf-light/60 hover:bg-pf-primary/20 hover:text-white',
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

      <main className="bg-pf-deep px-6 py-8 lg:px-10">{children}</main>
    </div>
  )
}
