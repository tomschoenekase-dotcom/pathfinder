export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { createAdminCaller } from '../../../../lib/admin-caller'

function one(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export default async function CompanyBrainPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const query = await searchParams
  const search = one(query.q)?.trim() || undefined
  const requestedStatus = one(query.status)
  const status = ['CURRENT', 'CANDIDATE', 'SUPERSEDED', 'ALL'].includes(requestedStatus ?? '')
    ? (requestedStatus as 'CURRENT' | 'CANDIDATE' | 'SUPERSEDED' | 'ALL')
    : 'CURRENT'
  const caller = await createAdminCaller()
  const data = await caller.admin.listCompanyBrain({
    ...(search ? { query: search } : {}),
    status,
    limit: 75,
  })

  return (
    <div className="space-y-6">
      <header className="border-b border-slate-200 pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
          Company Brain
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          Institutional memory and current decisions
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Browse governed company knowledge, provenance, decisions, and priorities. Operational
          account facts remain in CRM; this view is the deeper context layer.
        </p>
      </header>

      <form className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-[1fr_auto_auto]">
        <label className="grid gap-1 text-sm font-medium text-slate-800">
          Search title or summary
          <input
            name="q"
            defaultValue={search}
            className="rounded-lg border border-slate-300 px-3 py-2 font-normal"
            placeholder="pricing, onboarding, customer pattern…"
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-slate-800">
          State
          <select
            name="status"
            defaultValue={status}
            className="rounded-lg border border-slate-300 px-3 py-2 font-normal"
          >
            <option value="CURRENT">Current</option>
            <option value="CANDIDATE">Review candidates</option>
            <option value="SUPERSEDED">Superseded</option>
            <option value="ALL">All</option>
          </select>
        </label>
        <button className="self-end rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
          Apply
        </button>
      </form>

      <section aria-label="Company knowledge results" className="space-y-3">
        {data.items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-sm text-slate-600">
            No knowledge matches this view. The empty state is valid; no demo records are shown.
          </div>
        ) : (
          data.items.map((item) => (
            <article key={item.id} className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">
                    {item.type.replaceAll('_', ' ')} · {item.authority.replaceAll('_', ' ')}
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-slate-950">{item.title}</h2>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                  {item.promotionStatus.toLowerCase()}
                </span>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-700">{item.summary}</p>
              {item.decision ? (
                <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
                  <p className="font-semibold">Current decision · {item.decision.status}</p>
                  <p className="mt-1">{item.decision.decision}</p>
                  <p className="mt-2 text-emerald-900/75">Why: {item.decision.rationale}</p>
                </div>
              ) : null}
              {item.priority ? (
                <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-950">
                  <p className="font-semibold">
                    Priority {item.priority.rank} · {item.priority.status}
                  </p>
                  <p className="mt-1">{item.priority.rationale}</p>
                </div>
              ) : null}
              <dl className="mt-4 grid gap-2 text-xs text-slate-500 sm:grid-cols-3">
                <div>
                  <dt className="font-semibold text-slate-700">Scope</dt>
                  <dd>{item.accessScope.toLowerCase()}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-700">Provenance</dt>
                  <dd>
                    {item.createdByType.toLowerCase()} ·{' '}
                    {item.sources[0]?.sourceType ?? 'no source'}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-700">Last confirmed</dt>
                  <dd>{item.lastConfirmedAt?.toLocaleDateString() ?? 'not confirmed'}</dd>
                </div>
              </dl>
              {item.organizationId ? (
                <Link
                  className="mt-4 inline-block text-sm font-semibold text-sky-700 underline"
                  href={`/admin/prospects/${item.organizationId}`}
                >
                  Open related account
                </Link>
              ) : null}
              {item.supersededById ? (
                <p className="mt-3 text-xs font-medium text-amber-800">
                  Superseded by {item.supersededById}
                </p>
              ) : null}
            </article>
          ))
        )}
        {data.truncated ? (
          <p className="text-xs text-slate-500">Showing the first 75 bounded results.</p>
        ) : null}
      </section>
    </div>
  )
}
