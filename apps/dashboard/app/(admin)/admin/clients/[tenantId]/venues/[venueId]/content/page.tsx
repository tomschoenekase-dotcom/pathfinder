export const dynamic = 'force-dynamic'

import { randomUUID } from 'node:crypto'

import Link from 'next/link'

import { GeneralizedContentWorkbench } from '../../../../../../../../components/admin/GeneralizedContentWorkbench'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type ContentPageProps = {
  params: Promise<{ tenantId: string; venueId: string }>
  searchParams: Promise<{ kind?: string; cursorAt?: string; cursorId?: string }>
}

const kinds = ['ITEM', 'SERVICE', 'POLICY', 'EVENT', 'OPERATIONAL_FACT', 'RELATIONSHIP'] as const
type Kind = (typeof kinds)[number]

function label(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ')
}

function effectiveStatus(from: Date | null, until: Date | null): string {
  const now = Date.now()
  if (from && from.getTime() > now) return 'Scheduled'
  if (until && until.getTime() <= now) return 'Expired'
  return 'Effective'
}

export default async function UniversalContentPage({ params, searchParams }: ContentPageProps) {
  const [{ tenantId, venueId }, query] = await Promise.all([params, searchParams])
  const kind = kinds.includes(query.kind as Kind) ? (query.kind as Kind) : undefined
  const cursor =
    query.cursorAt && query.cursorId ? { createdAt: query.cursorAt, id: query.cursorId } : undefined
  const caller = await createAdminCaller()
  let result
  try {
    result = await caller.admin.listUniversalContent({ tenantId, venueId, kind, cursor, limit: 50 })
  } catch {
    return (
      <section className="rounded-2xl border border-rose-200 bg-rose-50 p-6" role="alert">
        <h2 className="text-lg font-semibold text-rose-950">Normalized content is unavailable</h2>
        <p className="mt-2 text-sm text-rose-900">
          The scoped content records could not be loaded. No data was changed.
        </p>
      </section>
    )
  }

  const base = `/admin/clients/${tenantId}/venues/${venueId}/content`
  const grouped = new Map<Kind, typeof result.items>()
  for (const contentRecord of result.items) {
    const group = grouped.get(contentRecord.kind) ?? []
    group.push(contentRecord)
    grouped.set(contentRecord.kind, group)
  }
  const editableModules = result.items.flatMap((contentRecord) => {
    const revision = contentRecord.revisions[0]
    if (!revision) return []
    let payload: Record<string, unknown> | null = null
    if (revision.item) payload = { kind: 'ITEM', ...revision.item }
    if (revision.service) payload = { kind: 'SERVICE', ...revision.service }
    if (revision.policy) payload = { kind: 'POLICY', ...revision.policy }
    if (revision.event) {
      payload = {
        kind: 'EVENT',
        ...revision.event,
        startsAt: revision.event.startsAt.toISOString(),
        endsAt: revision.event.endsAt?.toISOString() ?? null,
      }
    }
    if (revision.operationalFact) {
      payload = {
        kind: 'OPERATIONAL_FACT',
        ...revision.operationalFact,
        expiresAt: revision.operationalFact.expiresAt?.toISOString() ?? null,
      }
    }
    if (revision.relationship) payload = { kind: 'RELATIONSHIP', ...revision.relationship }
    if (!payload) return []
    return [
      {
        id: contentRecord.id,
        revisionId: revision.id,
        kind: contentRecord.kind,
        version: revision.version,
        audience: revision.audience,
        effectiveFrom: revision.effectiveFrom?.toISOString() ?? null,
        effectiveUntil: revision.effectiveUntil?.toISOString() ?? null,
        payload,
        publishedRevisionId:
          contentRecord.publications[0]?.action === 'PUBLISH'
            ? contentRecord.publications[0].revisionId
            : null,
      },
    ]
  })

  return (
    <div className="space-y-7">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Universal content
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
          Normalized module explorer
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Inspect typed revisions and provenance, validate drafts, and append human-authored
          revisions. Existing Places and Knowledge remain compatibility systems and are never
          rewritten here.
        </p>
      </header>

      <GeneralizedContentWorkbench
        tenantId={tenantId}
        venueId={venueId}
        authoringEnabled={result.authoringEnabled}
        initialCreationKey={randomUUID()}
        modules={editableModules}
      />

      <section
        aria-labelledby="item-boundary-title"
        className="rounded-xl border border-pf-light bg-pf-surface px-4 py-3 text-sm text-pf-deep/75"
      >
        <h3 id="item-boundary-title" className="font-semibold text-pf-deep">
          Generalized ITEM boundary
        </h3>
        <p className="mt-1">
          Generalized ITEM itemType is separate from legacy compatibility Place.itemType. Guest use
          is {label(result.itemDisposition.guestPublication)} and requires an exact PUBLIC revision
          to be explicitly published while the generalized-content capability is enabled. Published
          ITEM modules must be withdrawn before creating a NATIVE_CORE_V1 release because native
          materialization is {label(result.itemDisposition.nativeCoreV1Materialization)}.
        </p>
      </section>

      <nav aria-label="Filter content type" className="flex flex-wrap gap-2">
        <Link
          href={base}
          aria-current={!kind ? 'page' : undefined}
          className="rounded-full border border-pf-light px-4 py-2 text-sm font-semibold text-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          All types
        </Link>
        {kinds.map((value) => (
          <Link
            key={value}
            href={`${base}?kind=${value}`}
            aria-current={kind === value ? 'page' : undefined}
            className="rounded-full border border-pf-light px-4 py-2 text-sm font-semibold text-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          >
            {label(value)}
          </Link>
        ))}
      </nav>

      {result.items.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-pf-light p-8 text-center">
          <h3 className="font-semibold text-pf-deep">No normalized modules found</h3>
          <p className="mt-1 text-sm text-pf-deep/75">
            This is an honest empty state; compatibility Place and Knowledge records may still
            exist.
          </p>
        </section>
      ) : (
        kinds
          .filter((value) => grouped.has(value))
          .map((groupKind) => (
            <section key={groupKind} aria-labelledby={`group-${groupKind}`} className="space-y-3">
              <h3 id={`group-${groupKind}`} className="text-lg font-semibold text-pf-deep">
                {label(groupKind)}
              </h3>
              <div className="grid gap-3 xl:grid-cols-2">
                {grouped.get(groupKind)!.map((contentRecord) => {
                  const revision = contentRecord.revisions[0]
                  const payload =
                    revision?.item ??
                    revision?.service ??
                    revision?.policy ??
                    revision?.event ??
                    revision?.operationalFact ??
                    revision?.relationship
                  const title =
                    revision?.item?.name ??
                    revision?.service?.name ??
                    revision?.policy?.title ??
                    revision?.event?.name ??
                    revision?.operationalFact?.label ??
                    revision?.relationship?.relationshipType ??
                    contentRecord.id
                  return (
                    <article
                      key={contentRecord.id}
                      className="min-w-0 rounded-2xl border border-pf-light bg-white p-5"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <h4 className="font-semibold text-pf-deep">{title}</h4>
                        {revision ? (
                          <span className="rounded-full bg-pf-surface px-2.5 py-1 text-xs font-semibold text-pf-deep">
                            {revision.audience} ·{' '}
                            {effectiveStatus(revision.effectiveFrom, revision.effectiveUntil)}
                          </span>
                        ) : null}
                      </div>
                      {!revision ? (
                        <p className="mt-3 text-sm text-amber-800">
                          Identity exists without a revision.
                        </p>
                      ) : (
                        <>
                          <p className="mt-2 text-xs text-pf-deep/75">
                            Version {revision.version} · recorded{' '}
                            {revision.createdAt.toLocaleDateString()}
                          </p>
                          <p className="mt-3 break-words text-sm leading-6 text-pf-deep/75">
                            {revision.item?.description ??
                              revision.item?.itemType ??
                              revision.service?.description ??
                              revision.service?.availability ??
                              revision.policy?.rule ??
                              revision.event?.description ??
                              revision.operationalFact?.value ??
                              revision.relationship?.description ??
                              'No descriptive text recorded.'}
                          </p>
                          <div className="mt-4 border-t border-pf-light pt-3">
                            <p className="text-xs font-semibold uppercase tracking-wider text-pf-deep">
                              Sources ({revision._count.evidence})
                            </p>
                            {revision.evidence.length ? (
                              <ul className="mt-2 space-y-1 text-xs text-pf-deep/75">
                                {revision.evidence.map((evidence) => (
                                  <li key={evidence.id} className="break-all">
                                    {evidence.sourceId} · captured{' '}
                                    {evidence.capturedAt.toLocaleDateString()}
                                    {evidence.locator ? ` · ${evidence.locator}` : ''}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="mt-1 text-xs text-pf-deep/75">
                                No provenance evidence recorded.
                              </p>
                            )}
                          </div>
                        </>
                      )}
                      <p className="sr-only">Typed payload present: {payload ? 'yes' : 'no'}</p>
                    </article>
                  )
                })}
              </div>
            </section>
          ))
      )}

      {result.nextCursor ? (
        <Link
          href={`${base}?${new URLSearchParams({ ...(kind ? { kind } : {}), cursorAt: result.nextCursor.createdAt, cursorId: result.nextCursor.id })}`}
          className="inline-flex min-h-11 items-center rounded-xl border border-pf-light px-5 py-2 text-sm font-semibold text-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          Next page
        </Link>
      ) : null}
    </div>
  )
}
