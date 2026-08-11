export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { Building2, Plus, Search } from 'lucide-react'

import { createAdminCaller } from '../../../../lib/admin-caller'
import { getStatusClasses } from '../../../../lib/admin-status'

type DirectoryPageProps = {
  searchParams: Promise<{ q?: string; after?: string; afterId?: string }>
}

export default async function AdminDirectoryPage({ searchParams }: DirectoryPageProps) {
  const params = await searchParams
  const query = params.q?.trim().slice(0, 100) ?? ''
  const afterDate = params.after ? new Date(params.after) : null
  const cursor =
    afterDate && !Number.isNaN(afterDate.valueOf()) && params.afterId
      ? { createdAt: afterDate.toISOString(), id: params.afterId }
      : undefined
  const caller = await createAdminCaller()
  const result = await caller.admin.searchClients({ query, limit: 25, cursor })
  const clients = result.items

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
            Directory
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Clients</h1>
          <p className="mt-2 text-sm text-slate-600">
            Browse every customer relationship and enter its internal workspace.
          </p>
        </div>
        <Link
          href="/admin/new"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> New client
        </Link>
      </header>

      <form method="get" className="flex max-w-2xl gap-2" role="search">
        <label htmlFor="client-directory-search" className="sr-only">
          Search clients by name or slug
        </label>
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            id="client-directory-search"
            name="q"
            defaultValue={query}
            placeholder="Search by name or slug"
            className="min-h-11 w-full rounded-xl border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-950 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200"
          />
        </div>
        <button
          type="submit"
          className="min-h-11 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
        >
          Search
        </button>
      </form>

      {clients.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <Building2 className="mx-auto h-8 w-8 text-slate-400" aria-hidden="true" />
          <h2 className="mt-3 font-semibold text-slate-950">No clients yet</h2>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <ul className="divide-y divide-slate-100">
            {clients.map((client) => {
              const owner = client.memberships[0]
              return (
                <li key={client.id}>
                  <Link
                    href={`/admin/clients/${client.id}`}
                    className="flex flex-col gap-3 px-5 py-4 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-slate-950">
                        {client.name}
                      </span>
                      <span className="mt-1 block truncate text-xs text-slate-500">
                        {client.slug} · {owner?.user.email ?? 'No owner assigned'} ·{' '}
                        {client._count.memberships} members
                      </span>
                    </span>
                    <span
                      className={`w-fit shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${getStatusClasses(client.status)}`}
                    >
                      {client.status}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {result.nextCursor ? (
        <div className="flex justify-end">
          <Link
            href={{
              pathname: '/admin/directory',
              query: {
                ...(query ? { q: query } : {}),
                after: result.nextCursor.createdAt,
                afterId: result.nextCursor.id,
              },
            }}
            className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:border-sky-400 hover:text-sky-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            Next clients
          </Link>
        </div>
      ) : null}
    </div>
  )
}
