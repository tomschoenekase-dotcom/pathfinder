import Link from 'next/link'

import { appRouter, createTRPCContext } from '@pathfinder/api'

import { ClientStatusForm } from '../../../../components/ClientStatusForm'
import { TriggerDigestButton } from '../../../../components/TriggerDigestButton'
import { getStatusClasses } from '../../../../lib/status'

type ClientDetailPageProps = {
  params: Promise<{
    tenantId: string
  }>
}

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://admin.pathfinder.local/clients/detail'),
  })

  return appRouter.createCaller(ctx)
}

export default async function ClientDetailPage({ params }: ClientDetailPageProps) {
  const { tenantId } = await params
  const caller = await createCaller()
  const clients = await caller.admin.listClients()
  const tenant = clients.find((client) => client.id === tenantId)

  if (!tenant) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <Link href="/clients" className="text-sm font-medium text-cyan-700 hover:text-cyan-800">
          ← Back to clients
        </Link>
        <section className="rounded-[2rem] border border-dashed border-slate-300 bg-white p-10 text-center shadow-sm">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Client not found</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            The requested tenant record does not exist.
          </p>
        </section>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <Link href="/clients" className="text-sm font-medium text-cyan-700 hover:text-cyan-800">
        ← Back to clients
      </Link>

      <section className="rounded-[2rem] bg-slate-950 px-8 py-10 text-white shadow-sm">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300">
              Client overview
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight">{tenant.name}</h1>
            <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-slate-300">
              <span className="rounded-full bg-white/10 px-3 py-1 font-mono text-xs text-white">
                {tenant.slug}
              </span>
              <span
                className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${getStatusClasses(tenant.status)}`}
              >
                {tenant.status}
              </span>
              <span>Created {tenant.createdAt.toLocaleDateString()}</span>
            </div>
          </div>
        </div>

        <div className="mt-8 rounded-[1.5rem] border border-white/10 bg-white/5 p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300">Members</p>
          <div className="mt-4 space-y-3">
            {tenant.memberships.map((membership) => (
              <div
                key={membership.id}
                className="flex flex-col gap-1 rounded-2xl border border-white/10 bg-slate-950/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-sm text-white">{membership.user.email}</span>
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-300">
                  {membership.role}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Status management</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Update the client account state for platform operations and support.
        </p>
        <div className="mt-6">
          <ClientStatusForm tenantId={tenant.id} currentStatus={tenant.status} />
        </div>
      </section>

      <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Weekly digest</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Queue the current week’s digest job manually for this client.
        </p>
        <div className="mt-6">
          <TriggerDigestButton tenantId={tenant.id} />
        </div>
      </section>
    </div>
  )
}
