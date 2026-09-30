import Link from 'next/link'
import type { ReactNode } from 'react'

export const OPERATOR_TABS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'autonomy', label: 'Autonomy' },
  { id: 'connections', label: 'Connections' },
  { id: 'audit', label: 'Audit' },
] as const

export type OperatorTabId = (typeof OPERATOR_TABS)[number]['id']

/** Page frame: heading, section links (plain links; each tab loads its own data) and content. */
export function OperatorAdminView({
  tab,
  inboxCount,
  children,
}: {
  tab: OperatorTabId
  inboxCount: number | null
  children: ReactNode
}) {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-slate-950">Dot operator</h1>
        <p className="mt-1 max-w-prose text-sm text-slate-700">
          What the Dot has proposed, how much it may do on its own, which apps are connected, and a
          record of every call.
        </p>
      </header>
      <nav aria-label="Operator sections" className="border-b border-slate-300">
        <ul className="-mb-px flex gap-1 overflow-x-auto">
          {OPERATOR_TABS.map((item) => {
            const active = item.id === tab
            return (
              <li key={item.id}>
                <Link
                  href={`/admin/operator?tab=${item.id}`}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'inline-flex min-h-11 items-center border-b-2 px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
                    active
                      ? 'border-slate-950 text-slate-950'
                      : 'border-transparent text-slate-700 hover:text-slate-950',
                  ].join(' ')}
                >
                  {item.label}
                  {item.id === 'inbox' && inboxCount ? ` (${inboxCount})` : ''}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
      {children}
    </div>
  )
}
