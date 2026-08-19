import Link from 'next/link'

import { AdminCreateClientForm } from '../../../../components/admin/AdminCreateClientForm'

export default function AdminNewClientPage() {
  return (
    <div className="mx-auto max-w-xl space-y-8">
      <header className="space-y-2">
        <Link
          href="/admin"
          className="inline-flex min-h-11 items-center text-sm font-medium text-pf-deep/50 hover:text-pf-primary"
        >
          ← Clients
        </Link>
        <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
          Platform admin
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">New client</h1>
        <p className="text-sm leading-6 text-pf-deep/60">
          Create a client and its first venue directly, without them signing up.
        </p>
      </header>

      <AdminCreateClientForm />
    </div>
  )
}
