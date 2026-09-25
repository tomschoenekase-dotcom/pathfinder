import { db } from '@pathfinder/db'

/** A source read, not a grant to assert a product or venue claim. */
const currentOutreachSource = {
  accessScope: 'PLATFORM' as const,
  type: { in: ['PRODUCT_RATIONALE' as const, 'POLICY_CONTEXT' as const] },
  promotionStatus: 'PROMOTED' as const,
  authority: 'AUTHORITATIVE_CURRENT' as const,
  archivedAt: null,
  supersededAt: null,
}

function allowsOutreach(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowedUses = (value as { allowedUses?: unknown }).allowedUses
  return Array.isArray(allowedUses) && allowedUses.includes('OUTREACH')
}

export async function listOutreachCompanySources(query: string) {
  const scanned = await db.companyKnowledgeItem.findMany({
    where: {
      ...currentOutreachSource,
      OR: [
        { title: { contains: query, mode: 'insensitive' } },
        { summary: { contains: query, mode: 'insensitive' } },
      ],
    },
    orderBy: [{ lastConfirmedAt: 'desc' }, { id: 'asc' }],
    take: 51,
    select: {
      id: true,
      type: true,
      title: true,
      summary: true,
      currentRevision: true,
      lastConfirmedAt: true,
      revisions: {
        orderBy: { revision: 'desc' },
        take: 1,
        select: { revision: true, sourceDigest: true, structuredData: true },
      },
    },
  })
  return {
    schemaVersion: 'torchiko-outreach-company-sources.v1',
    results: scanned.slice(0, 50).flatMap((item) => {
      const revision = item.revisions[0]
      return revision &&
        revision.revision === item.currentRevision &&
        allowsOutreach(revision.structuredData)
        ? [
            {
              id: item.id,
              version: String(item.currentRevision),
              type: item.type,
              title: item.title,
              summary: item.summary,
              sourceDigest: revision.sourceDigest,
              lastConfirmedAt: item.lastConfirmedAt?.toISOString() ?? null,
            },
          ]
        : []
    }),
    scanned: Math.min(scanned.length, 50),
    partial: scanned.length > 50,
    note: 'Matching current Company Brain records only; absence does not prove complete product-claim coverage.',
  }
}

export async function getOutreachCompanySource(id: string, version: number) {
  const item = await db.companyKnowledgeItem.findFirst({
    where: { ...currentOutreachSource, id, currentRevision: version },
    select: {
      id: true,
      type: true,
      title: true,
      summary: true,
      currentRevision: true,
      lastConfirmedAt: true,
      revisions: {
        where: { revision: version },
        take: 1,
        select: { revision: true, body: true, sourceDigest: true, structuredData: true },
      },
      sources: {
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { sourceType: true, sourceId: true, sourceRef: true, occurredAt: true },
      },
    },
  })
  const revision = item?.revisions[0]
  if (!item || !revision || !allowsOutreach(revision.structuredData)) return null
  if (revision.body.length > 20_000) return null
  return {
    schemaVersion: 'torchiko-outreach-company-source.v1',
    source: {
      id: item.id,
      version: String(item.currentRevision),
      type: item.type,
      title: item.title,
      summary: item.summary,
      body: revision.body,
      authority: 'AUTHORITATIVE_CURRENT' as const,
      promotionStatus: 'PROMOTED' as const,
      allowedUse: 'OUTREACH' as const,
      sourceDigest: revision.sourceDigest,
      lastConfirmedAt: item.lastConfirmedAt?.toISOString() ?? null,
      provenance: item.sources.map((source) => ({
        ...source,
        occurredAt: source.occurredAt?.toISOString() ?? null,
      })),
    },
    note: 'Source text for human-reviewed drafting; product rationale is not proof of a particular external claim.',
  }
}
