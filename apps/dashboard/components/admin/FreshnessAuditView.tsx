import Link from 'next/link'
import type { ReactNode } from 'react'

type Cursor = { sortAt: string; id: string } | null
export type FreshnessContentItem = {
  id: string
  entityType: 'PLACE' | 'KNOWLEDGE_ENTRY'
  label: string
  category: string | null
  sourceType: string
  sourceName: string | null
  sourceUrl: string | null
  importedAt: Date | null
  humanConfirmedAt: Date | null
  lastReviewedAt: Date | null
  updatedAt: Date
}
export type FreshnessUpdateItem = {
  id: string
  title: string
  updateType: string
  severity: string
  priority: string
  startsAt: Date
  expiresAt: Date
  publishedAt: Date | null
  updatedAt: Date
  place: { id: string; name: string } | null
}
type Page<T> = { items: T[]; nextCursor: Cursor }
type Props = {
  tenantId: string
  venueId: string
  thresholdDays: number
  horizonDays: number
  observedAt: Date
  stalePlaces: Page<FreshnessContentItem>
  staleKnowledge: Page<FreshnessContentItem>
  gapPlaces: Page<FreshnessContentItem>
  gapKnowledge: Page<FreshnessContentItem>
  dateSensitive: Page<FreshnessUpdateItem>
}

function href(base: string, prefix: string, cursor: Exclude<Cursor, null>, thresholdDays: number) {
  return `${base}?thresholdDays=${thresholdDays}&${prefix}SortAt=${encodeURIComponent(cursor.sortAt)}&${prefix}Id=${encodeURIComponent(cursor.id)}`
}
function ageDays(then: Date, now: Date) {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000))
}

export function FreshnessAuditView(props: Props) {
  const base = `/admin/clients/${props.tenantId}/venues/${props.venueId}/freshness`
  const stale = [...props.stalePlaces.items, ...props.staleKnowledge.items].sort(
    (a, b) => (a.lastReviewedAt?.getTime() ?? 0) - (b.lastReviewedAt?.getTime() ?? 0),
  )
  const gaps = [...props.gapPlaces.items, ...props.gapKnowledge.items].sort(
    (a, b) => a.updatedAt.getTime() - b.updatedAt.getTime(),
  )
  return (
    <div className="space-y-8">
      <header className="border-b border-pf-light pb-6">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Freshness audit
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-pf-deep">Evidence review queue</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/65">
          Read-only signals from existing review, confirmation, provenance, and operational-window
          metadata.
        </p>
        <form className="mt-4 flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm font-semibold text-pf-deep">
            Stale after days
            <input
              name="thresholdDays"
              type="number"
              min="1"
              max="365"
              defaultValue={props.thresholdDays}
              className="min-h-11 w-36 rounded-xl border border-pf-light bg-white px-3"
            />
          </label>
          <button
            type="submit"
            className="min-h-11 rounded-xl border border-pf-light bg-white px-4 text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          >
            Apply review window
          </button>
        </form>
      </header>
      <aside className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
        <strong>Evidence limitation:</strong> this audit does not compare independent sources or
        prove that content is current. A provenance gap is a missing review signal, not a factual
        contradiction. Nothing here is auto-patched or published.
      </aside>

      <Queue
        title="Stale trusted sources"
        description={`Human-confirmed active content last reviewed at least ${props.thresholdDays} days ago.`}
        empty="No human-confirmed content with an overdue recorded review was found."
      >
        {stale.map((item) => (
          <ContentRow
            key={`${item.entityType}:${item.id}`}
            item={item}
            detail={
              item.lastReviewedAt
                ? `Last reviewed ${ageDays(item.lastReviewedAt, props.observedAt)} days ago · ${item.lastReviewedAt.toLocaleDateString()}`
                : 'No review recorded'
            }
          />
        ))}
      </Queue>
      <Paging
        links={[
          [props.stalePlaces.nextCursor, 'stalePlace', 'Older stale places'],
          [props.staleKnowledge.nextCursor, 'staleKnowledge', 'Older stale knowledge'],
        ]}
        base={base}
        threshold={props.thresholdDays}
      />

      <Queue
        title="Provenance discrepancies requiring review"
        description="Active records missing a known source type, source name, or recorded review date."
        empty="No provenance gaps were found in the current page of active content."
      >
        {gaps.map((item) => {
          const missing = [
            item.sourceType === 'UNKNOWN' ? 'source type' : null,
            !item.sourceName ? 'source name' : null,
            !item.lastReviewedAt ? 'review date' : null,
          ]
            .filter(Boolean)
            .join(', ')
          return (
            <ContentRow
              key={`${item.entityType}:${item.id}`}
              item={item}
              detail={`Missing: ${missing}`}
            />
          )
        })}
      </Queue>
      <Paging
        links={[
          [props.gapPlaces.nextCursor, 'gapPlace', 'Older place gaps'],
          [props.gapKnowledge.nextCursor, 'gapKnowledge', 'Older knowledge gaps'],
        ]}
        base={base}
        threshold={props.thresholdDays}
      />

      <Queue
        title="Date-sensitive records"
        description={`Active published updates expired or expiring within ${props.horizonDays} days.`}
        empty="No active published updates are within the review horizon."
      >
        {props.dateSensitive.items.map((item) => {
          const expired = item.expiresAt <= props.observedAt
          return (
            <article key={item.id} className="rounded-2xl border border-pf-light bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-bold ${expired ? 'bg-rose-100 text-rose-900' : 'bg-amber-100 text-amber-950'}`}
                >
                  {expired ? 'Expired but active' : 'Expires soon'}
                </span>
                <span className="text-xs font-semibold text-pf-deep/60">
                  {item.updateType.replace(/_/g, ' ')} · {item.priority}
                </span>
              </div>
              <h4 className="mt-2 font-semibold text-pf-deep">{item.title}</h4>
              <p className="mt-1 text-sm text-pf-deep/65">
                {item.place?.name ? `${item.place.name} · ` : ''}
                {item.startsAt.toLocaleString()} to {item.expiresAt.toLocaleString()}
              </p>
            </article>
          )
        })}
      </Queue>
      <Paging
        links={[[props.dateSensitive.nextCursor, 'dateSensitive', 'Later expiry records']]}
        base={base}
        threshold={props.thresholdDays}
      />
    </div>
  )
}

function Queue({
  title,
  description,
  empty,
  children,
}: {
  title: string
  description: string
  empty: string
  children: ReactNode[]
}) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-xl font-semibold text-pf-deep">{title}</h3>
        <p className="mt-1 text-sm text-pf-deep/60">{description}</p>
      </div>
      {children.length ? (
        <div className="space-y-3">{children}</div>
      ) : (
        <div className="rounded-3xl border border-dashed border-pf-light bg-white p-8 text-center text-sm text-pf-deep/65">
          {empty}
        </div>
      )}
    </section>
  )
}
function ContentRow({ item, detail }: { item: FreshnessContentItem; detail: string }) {
  return (
    <article className="rounded-2xl border border-pf-light bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-800">
          {item.entityType.replace(/_/g, ' ')}
        </span>
        <span className="text-xs text-pf-deep/55">{item.sourceType}</span>
      </div>
      <h4 className="mt-2 font-semibold text-pf-deep">{item.label}</h4>
      <p className="mt-1 text-sm text-pf-deep/65">
        {item.sourceName ?? 'No source name'} · {detail}
      </p>
      {item.sourceUrl ? <p className="mt-2 text-xs text-pf-deep/55">Source URL recorded</p> : null}
    </article>
  )
}
function Paging({
  links,
  base,
  threshold,
}: {
  links: [Cursor, string, string][]
  base: string
  threshold: number
}) {
  const available = links.filter(
    (entry): entry is [Exclude<Cursor, null>, string, string] => entry[0] !== null,
  )
  return available.length ? (
    <div className="flex flex-wrap justify-end gap-2">
      {available.map(([cursor, prefix, label]) => (
        <Link
          key={prefix}
          href={href(base, prefix, cursor, threshold)}
          className="inline-flex min-h-11 items-center rounded-xl border border-pf-light bg-white px-4 text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          {label}
        </Link>
      ))}
    </div>
  ) : null
}
