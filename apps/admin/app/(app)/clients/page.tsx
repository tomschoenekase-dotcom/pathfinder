import Link from 'next/link'

import { appRouter, createTRPCContext } from '@pathfinder/api'

import { getStatusClasses } from '../../../lib/status'

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://admin.pathfinder.local/clients'),
  })

  return appRouter.createCaller(ctx)
}

export default async function ClientsPage() {
  const caller = await createCaller()
  const clients = await caller.admin.listClients()

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <section className="rounded-[2rem] border border-pf-primary/20 bg-pf-primary/10 px-8 py-10 text-pf-light">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-pf-accent">
          Platform Admin
        </p>
        <div className="mt-4 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight">Clients</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-pf-light/60">
              All venue operator tenants on the PathFinder platform.
            </p>
          </div>
          <div className="rounded-[1.5rem] bg-pf-primary/20 px-5 py-4">
            <p className="text-xs uppercase tracking-[0.2em] text-pf-accent">Total clients</p>
            <p className="mt-2 text-3xl font-semibold">{clients.length}</p>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        {clients.length === 0 ? (
          <div className="rounded-[1.75rem] border border-pf-primary/20 bg-pf-primary/10 p-10 text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-pf-light">No clients yet</h2>
            <p className="mt-3 text-sm leading-6 text-pf-light/60">
              When a venue operator signs up, they will appear here.
            </p>
          </div>
        ) : (
          clients.map((client) => {
            const ownerMembership = client.memberships.find(
              (membership) => membership.role === 'OWNER',
            )

            return (
              <article
                key={client.id}
                className="rounded-3xl border border-pf-primary/20 bg-pf-primary/10 p-6"
              >
                <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <h2 className="text-2xl font-semibold tracking-tight text-pf-light">
                        {client.name}
                      </h2>
                      <span
                        className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${getStatusClasses(client.status)}`}
                      >
                        {client.status}
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-3 text-sm text-pf-light/60">
                      <span className="rounded-full bg-pf-primary/20 px-3 py-1 font-mono text-xs text-pf-light">
                        {client.slug}
                      </span>
                      <span>{client.memberships.length} active members</span>
                      <span>{ownerMembership?.user.email ?? 'No owner'}</span>
                    </div>
                  </div>

                  <Link
                    href={`/clients/${client.id}`}
                    className="inline-flex min-h-11 items-center rounded-full bg-pf-accent px-5 text-sm font-medium text-white transition hover:bg-[#4d8de0]"
                  >
                    Manage
                  </Link>
                </div>
              </article>
            )
          })
        )}
      </section>
    </div>
  )
}
