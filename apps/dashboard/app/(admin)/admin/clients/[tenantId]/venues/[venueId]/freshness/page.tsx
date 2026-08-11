export const dynamic = 'force-dynamic'

import {
  FreshnessAuditView,
  type FreshnessContentItem,
} from '../../../../../../../../components/admin/FreshnessAuditView'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type Props = {
  params: Promise<{ tenantId: string; venueId: string }>
  searchParams: Promise<Record<string, string | undefined>>
}
function cursor(query: Record<string, string | undefined>, prefix: string) {
  const sortAt = query[`${prefix}SortAt`]
  const id = query[`${prefix}Id`]
  return sortAt && id ? { sortAt, id } : undefined
}
function threshold(raw: string | undefined) {
  const parsed = Number(raw ?? 60)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : 60
}

export default async function FreshnessAuditPage({ params, searchParams }: Props) {
  const { tenantId, venueId } = await params
  const query = await searchParams
  const thresholdDays = threshold(query.thresholdDays)
  const caller = await createAdminCaller()
  const request = (
    queue: 'STALE_TRUSTED' | 'PROVENANCE_GAP',
    entityType: 'PLACE' | 'KNOWLEDGE_ENTRY',
    prefix: string,
  ) =>
    caller.admin.listFreshnessAudit({
      tenantId,
      venueId,
      queue,
      entityType,
      thresholdDays,
      limit: 10,
      ...(cursor(query, prefix) ? { cursor: cursor(query, prefix) } : {}),
    })
  try {
    const [stalePlaces, staleKnowledge, gapPlaces, gapKnowledge, dateSensitive] = await Promise.all(
      [
        request('STALE_TRUSTED', 'PLACE', 'stalePlace'),
        request('STALE_TRUSTED', 'KNOWLEDGE_ENTRY', 'staleKnowledge'),
        request('PROVENANCE_GAP', 'PLACE', 'gapPlace'),
        request('PROVENANCE_GAP', 'KNOWLEDGE_ENTRY', 'gapKnowledge'),
        caller.admin.listFreshnessAudit({
          tenantId,
          venueId,
          queue: 'DATE_SENSITIVE',
          thresholdDays,
          horizonDays: 14,
          limit: 10,
          ...(cursor(query, 'dateSensitive') ? { cursor: cursor(query, 'dateSensitive') } : {}),
        }),
      ],
    )
    if (
      stalePlaces.entityType !== 'PLACE' ||
      gapPlaces.entityType !== 'PLACE' ||
      staleKnowledge.entityType !== 'KNOWLEDGE_ENTRY' ||
      gapKnowledge.entityType !== 'KNOWLEDGE_ENTRY' ||
      dateSensitive.entityType !== 'OPERATIONAL_UPDATE'
    )
      throw new Error('Unexpected freshness queue shape')
    const places = (page: typeof stalePlaces | typeof gapPlaces) => ({
      ...page,
      items: page.items.map(
        (item): FreshnessContentItem => ({
          ...item,
          entityType: 'PLACE',
          label: item.name,
          category: null,
        }),
      ),
    })
    const knowledge = (page: typeof staleKnowledge | typeof gapKnowledge) => ({
      ...page,
      items: page.items.map(
        (item): FreshnessContentItem => ({
          ...item,
          entityType: 'KNOWLEDGE_ENTRY',
          label: item.title,
          category: item.category,
        }),
      ),
    })
    return (
      <FreshnessAuditView
        tenantId={tenantId}
        venueId={venueId}
        thresholdDays={thresholdDays}
        horizonDays={dateSensitive.horizonDays}
        observedAt={dateSensitive.observedAt}
        stalePlaces={places(stalePlaces)}
        staleKnowledge={knowledge(staleKnowledge)}
        gapPlaces={places(gapPlaces)}
        gapKnowledge={knowledge(gapKnowledge)}
        dateSensitive={dateSensitive}
      />
    )
  } catch {
    return (
      <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-rose-700">
          Freshness audit
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-pf-deep">
          Freshness evidence could not be loaded
        </h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/65">
          Refresh the page or return later. No content was patched, reviewed, or published.
        </p>
      </section>
    )
  }
}
