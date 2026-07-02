'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function AdminTab({ href, label }: { href: string; label: string }) {
  const pathname = usePathname()
  const isActive = pathname === href

  return (
    <Link
      href={href}
      className={[
        'border-b-2 px-4 py-2.5 text-sm font-medium transition -mb-px',
        isActive
          ? 'border-pf-accent text-pf-accent'
          : 'border-transparent text-pf-deep/50 hover:text-pf-deep',
      ].join(' ')}
    >
      {label}
    </Link>
  )
}
