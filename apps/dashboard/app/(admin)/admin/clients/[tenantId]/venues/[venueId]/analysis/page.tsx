export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { AdminGenerateAnalysisButton } from '../../../../../../../../components/admin/AdminGenerateAnalysisButton'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type AdminAnalysisPageProps = {
  params: Promise<{ tenantId: string; venueId: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}

function startIso(value?: string) {
  const date = value ? new Date(`${value}T00:00:00.000Z`) : new Date(Date.now() - 30 * 86_400_000)
  return date.toISOString()
}

function endIso(value?: string) {
  const date = value ? new Date(`${value}T23:59:59.999Z`) : new Date()
  return date.toISOString()
}

export default async function AdminAnalysisPage({ params, searchParams }: AdminAnalysisPageProps) {
  const { tenantId, venueId } = await params
  const query = await searchParams
  const caller = await createAdminCaller()
  const analyses = await caller.admin.listAnswerAnalyses({ tenantId, venueId })
  const rangeStart = startIso(query.from)
  const rangeEnd = endIso(query.to)

  return (
    <div className="space-y-8">
      <Link
        href={`/admin/clients/${tenantId}/venues/${venueId}`}
        className="text-sm font-medium text-pf-primary hover:text-pf-accent"
      >
        Back to venue
      </Link>

      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Answer analysis</h1>
        <p className="mt-2 text-sm text-pf-deep/60">
          Generate AI summaries from captured engagement answers.
        </p>
      </header>

      <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <form className="flex flex-wrap items-end gap-3">
          <label className="grid gap-2 text-sm font-medium text-pf-deep">
            From
            <input
              type="date"
              name="from"
              defaultValue={query.from}
              className="rounded-2xl border border-pf-light bg-pf-surface px-4 py-2"
            />
          </label>
          <label className="grid gap-2 text-sm font-medium text-pf-deep">
            To
            <input
              type="date"
              name="to"
              defaultValue={query.to}
              className="rounded-2xl border border-pf-light bg-pf-surface px-4 py-2"
            />
          </label>
          <button
            type="submit"
            className="inline-flex min-h-10 items-center rounded-full border border-pf-light bg-pf-white px-5 text-sm font-semibold text-pf-primary"
          >
            Set range
          </button>
        </form>
        <AdminGenerateAnalysisButton
          tenantId={tenantId}
          venueId={venueId}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
        />
      </section>

      <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Recent summaries</h2>
        {analyses.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-pf-light bg-pf-surface px-4 py-4 text-sm text-pf-deep/60">
            No analysis snapshots yet.
          </p>
        ) : (
          <div className="space-y-3">
            {analyses.map((analysis) => (
              <Link
                key={analysis.id}
                href={`/admin/clients/${tenantId}/venues/${venueId}/analysis/${analysis.id}`}
                className="flex flex-col gap-2 rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 transition hover:border-pf-accent sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-sm font-medium text-pf-deep">
                  {analysis.rangeStart.toLocaleDateString()} to{' '}
                  {analysis.rangeEnd.toLocaleDateString()}
                </span>
                <span className="text-xs font-semibold uppercase tracking-wider text-pf-deep/50">
                  {analysis.status} - {analysis.answerCount} answers
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
