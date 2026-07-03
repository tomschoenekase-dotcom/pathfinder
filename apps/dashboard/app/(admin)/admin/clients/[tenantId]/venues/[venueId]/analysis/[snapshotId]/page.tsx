export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { createAdminCaller } from '../../../../../../../../../lib/admin-caller'

type AdminAnalysisDetailPageProps = {
  params: Promise<{ tenantId: string; venueId: string; snapshotId: string }>
}

type AnalysisSummary = {
  liked?: string[]
  improve?: string[]
  themes?: string[]
  complaints?: string[]
  mostMentioned?: string[]
  sentimentSummary?: string
  quotes?: string[]
  perQuestion?: Array<{ questionText: string; answerCount: number; summary: string }>
  sampleSizeCaveat?: string | null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function SectionList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold tracking-tight text-pf-deep">{title}</h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-pf-deep/50">No entries.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {items.map((item, index) => (
            <li key={`${item}-${index}`} className="rounded-2xl bg-pf-surface px-4 py-3 text-sm">
              {item}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default async function AdminAnalysisDetailPage({ params }: AdminAnalysisDetailPageProps) {
  const { tenantId, venueId, snapshotId } = await params
  const caller = await createAdminCaller()
  const snapshot = await caller.admin.getAnswerAnalysis({ tenantId, snapshotId })
  const summary = (snapshot.summary ?? {}) as AnalysisSummary

  return (
    <div className="space-y-8">
      <Link
        href={`/admin/clients/${tenantId}/venues/${venueId}/analysis`}
        className="text-sm font-medium text-pf-primary hover:text-pf-accent"
      >
        Back to analysis
      </Link>

      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Analysis summary</h1>
        <p className="mt-2 text-sm text-pf-deep/60">
          {snapshot.rangeStart.toLocaleDateString()} to {snapshot.rangeEnd.toLocaleDateString()} -{' '}
          {snapshot.status}
        </p>
      </header>

      {snapshot.status === 'GENERATING' ? (
        <div className="rounded-3xl border border-pf-light bg-pf-white p-8 text-sm text-pf-deep/60 shadow-sm">
          Still generating. Reload this page in a moment.
        </div>
      ) : snapshot.status === 'FAILED' ? (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-8 text-sm text-rose-700 shadow-sm">
          {snapshot.error ?? 'Analysis failed.'}
        </div>
      ) : (
        <>
          {summary.sampleSizeCaveat ? (
            <p className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
              {summary.sampleSizeCaveat}
            </p>
          ) : null}

          <section className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold tracking-tight text-pf-deep">Sentiment</h2>
            <p className="mt-3 text-sm leading-6 text-pf-deep/70">
              {summary.sentimentSummary ?? 'No sentiment summary.'}
            </p>
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <SectionList title="Liked" items={stringList(summary.liked)} />
            <SectionList title="Improve" items={stringList(summary.improve)} />
            <SectionList title="Themes" items={stringList(summary.themes)} />
            <SectionList title="Complaints" items={stringList(summary.complaints)} />
            <SectionList title="Most mentioned" items={stringList(summary.mostMentioned)} />
            <SectionList title="Quotes" items={stringList(summary.quotes)} />
          </div>

          <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold tracking-tight text-pf-deep">
              Per-question answers
            </h2>
            {(summary.perQuestion ?? []).length === 0 ? (
              <p className="text-sm text-pf-deep/50">No per-question summary.</p>
            ) : (
              summary.perQuestion!.map((item) => (
                <article key={item.questionText} className="rounded-2xl bg-pf-surface p-4">
                  <p className="text-sm font-semibold text-pf-deep">{item.questionText}</p>
                  <p className="mt-2 text-sm leading-6 text-pf-deep/70">{item.summary}</p>
                  <p className="mt-2 text-xs text-pf-deep/50">{item.answerCount} answers</p>
                </article>
              ))
            )}
          </section>
        </>
      )}
    </div>
  )
}
