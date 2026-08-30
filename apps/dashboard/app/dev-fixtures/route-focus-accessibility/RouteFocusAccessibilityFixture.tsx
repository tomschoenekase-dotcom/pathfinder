'use client'

import { useState } from 'react'

import { AdminSectionShell } from '../../../components/admin/AdminSectionShell'
import { TRPCProvider } from '../../../lib/trpc'

export function RouteFocusAccessibilityFixture() {
  const [pathname, setPathname] = useState('/admin')
  return (
    <TRPCProvider scopeKey="route-focus-accessibility-fixture">
      <AdminSectionShell routePathname={pathname}>
        {pathname === '/admin' ? (
          <section className="rounded-3xl bg-white p-6 shadow-sm">
            <h1 className="text-3xl font-bold text-slate-950">Command center</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
              Provider-dark route focus fixture using the exact production shell.
            </p>
            <button
              type="button"
              onClick={() => setPathname('/admin/operations')}
              className="mt-6 min-h-11 rounded-xl bg-sky-700 px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              Open control room
            </button>
          </section>
        ) : (
          <section className="rounded-3xl bg-white p-6 shadow-sm">
            <h1 className="text-3xl font-bold text-slate-950">Control room</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
              Route content is ready. Focus should arrive on this heading once.
            </p>
          </section>
        )}
      </AdminSectionShell>
    </TRPCProvider>
  )
}
