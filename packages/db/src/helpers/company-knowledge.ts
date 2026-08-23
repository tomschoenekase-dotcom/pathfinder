import {
  CompanyKnowledgeGetRequest,
  CompanyKnowledgeSearchRequest,
  KNOWLEDGE_SEARCH_TARGET_BYTES,
} from '@pathfinder/contracts/company-brain'
import type { Prisma } from '@prisma/client'

import { db } from '../client'
import { searchCompanyKnowledgeByEmbedding } from './semantic-search'

export type KnowledgeAccessContext =
  | { kind: 'PLATFORM'; roles: string[] }
  | { kind: 'CLIENT'; clientId: string; roles: string[] }

export type CompanyKnowledgeClient = Pick<typeof db, 'companyKnowledgeItem' | 'venue'>

export class CompanyKnowledgeError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'PAYLOAD_TOO_LARGE',
    message: string,
  ) {
    super(message)
    this.name = 'CompanyKnowledgeError'
  }
}

function accessWhere(
  access: KnowledgeAccessContext,
  requestedClientId?: string,
): Prisma.CompanyKnowledgeItemWhereInput {
  if (access.kind === 'PLATFORM') {
    return {
      OR: [
        { accessScope: { not: 'RESTRICTED' } },
        ...(access.roles.length > 0
          ? [{ accessScope: 'RESTRICTED' as const, allowedRoles: { hasSome: access.roles } }]
          : []),
      ],
    }
  }
  if (requestedClientId && requestedClientId !== access.clientId) {
    return { id: '__forbidden_client_scope__' }
  }
  return {
    OR: [
      { accessScope: 'TENANT', tenantId: access.clientId },
      { accessScope: 'VENUE', tenantId: access.clientId },
      {
        accessScope: 'ORGANIZATION',
        organization: {
          customerRelationships: { some: { tenantId: access.clientId, status: 'ACTIVE' } },
        },
      },
    ],
  }
}

const appliesToVenueWhere = (venueId: string): Prisma.CompanyKnowledgeItemWhereInput => ({
  OR: [
    { venueId },
    {
      venueId: null,
      entityLinks: { none: { entityType: 'VENUE', relationship: 'APPLIES_TO' } },
    },
    {
      entityLinks: {
        some: { entityType: 'VENUE', entityId: venueId, relationship: 'APPLIES_TO' },
      },
    },
  ],
})

function venueContextWhere(
  access: KnowledgeAccessContext,
  venueId: string,
  requestedClientId?: string,
  organizationId?: string,
): Prisma.CompanyKnowledgeItemWhereInput {
  const clientId = access.kind === 'CLIENT' ? access.clientId : requestedClientId
  if (!clientId) return { venueId }
  return {
    OR: [
      { accessScope: 'VENUE', tenantId: clientId, venueId },
      {
        accessScope: 'TENANT',
        tenantId: clientId,
        AND: [appliesToVenueWhere(venueId)],
      },
      {
        accessScope: 'ORGANIZATION',
        ...(organizationId ? { organizationId } : {}),
        organization: {
          customerRelationships: { some: { tenantId: clientId, status: 'ACTIVE' } },
        },
        AND: [appliesToVenueWhere(venueId)],
      },
    ],
  }
}

async function verifyRequestedVenue(
  access: KnowledgeAccessContext,
  venueId: string | undefined,
  requestedClientId: string | undefined,
  client: CompanyKnowledgeClient,
) {
  if (!venueId) return
  const clientId = access.kind === 'CLIENT' ? access.clientId : requestedClientId
  if (!clientId) return
  const venue = await client.venue.findFirst({
    where: { id: venueId, tenantId: clientId },
    select: { id: true },
  })
  if (!venue) throw new CompanyKnowledgeError('NOT_FOUND', 'Venue not found in verified scope')
}

function lexicalTerms(query: string) {
  return Array.from(
    new Set(
      query
        .toLocaleLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter((term) => term.length > 1),
    ),
  ).slice(0, 12)
}

function lexicalScore(query: string, title: string, summary: string, body: string | null) {
  const terms = lexicalTerms(query)
  const normalizedTitle = title.toLocaleLowerCase()
  const normalizedSummary = summary.toLocaleLowerCase()
  const normalizedBody = body?.toLocaleLowerCase() ?? ''
  return terms.reduce(
    (score, term) =>
      score +
      (normalizedTitle.includes(term) ? 5 : 0) +
      (normalizedSummary.includes(term) ? 3 : 0) +
      (normalizedBody.includes(term) ? 1 : 0),
    0,
  )
}

const detailSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  organizationId: true,
  type: true,
  title: true,
  summary: true,
  accessScope: true,
  authority: true,
  promotionStatus: true,
  currentRevision: true,
  confidence: true,
  effectiveAt: true,
  lastConfirmedAt: true,
  supersededAt: true,
  supersededById: true,
  createdByType: true,
  createdById: true,
  modelProvider: true,
  modelName: true,
  createdAt: true,
  updatedAt: true,
  revisions: {
    orderBy: { revision: 'desc' as const },
    take: 1,
    select: {
      revision: true,
      body: true,
      structuredData: true,
      sourceDigest: true,
      authoredByType: true,
      authoredById: true,
      modelProvider: true,
      modelName: true,
      createdAt: true,
    },
  },
  sources: {
    orderBy: { createdAt: 'desc' as const },
    take: 8,
    select: {
      id: true,
      sourceType: true,
      sourceId: true,
      sourceRef: true,
      excerpt: true,
      occurredAt: true,
      metadata: true,
    },
  },
  entityLinks: {
    take: 20,
    select: { entityType: true, entityId: true, relationship: true },
  },
  decision: {
    select: {
      id: true,
      status: true,
      decision: true,
      rationale: true,
      scope: true,
      affectedSystems: true,
      effectiveAt: true,
      supersedesId: true,
    },
  },
  priority: {
    select: {
      id: true,
      status: true,
      rank: true,
      timeHorizon: true,
      ownerId: true,
      rationale: true,
      workstreams: true,
      startsAt: true,
      endsAt: true,
    },
  },
} satisfies Prisma.CompanyKnowledgeItemSelect

type SelectedKnowledgeItem = Prisma.CompanyKnowledgeItemGetPayload<{ select: typeof detailSelect }>

function serializeItem(item: SelectedKnowledgeItem) {
  const revision = item.revisions[0] ?? null
  return {
    id: item.id,
    scope: {
      access: item.accessScope,
      tenantId: item.tenantId,
      venueId: item.venueId,
      organizationId: item.organizationId,
    },
    type: item.type,
    title: item.title,
    summary: item.summary,
    body: revision?.body ?? null,
    structuredData: revision?.structuredData ?? {},
    authority: item.authority,
    promotionStatus: item.promotionStatus,
    effectiveAt: item.effectiveAt?.toISOString() ?? null,
    lastConfirmedAt: item.lastConfirmedAt?.toISOString() ?? null,
    supersession: {
      supersededAt: item.supersededAt?.toISOString() ?? null,
      supersededById: item.supersededById,
    },
    revision: revision
      ? {
          number: revision.revision,
          sourceDigest: revision.sourceDigest,
          createdAt: revision.createdAt.toISOString(),
        }
      : null,
    provenance: {
      createdByType: item.createdByType,
      createdById: item.createdById,
      modelProvider: item.modelProvider,
      modelName: item.modelName,
      sources: item.sources.map((source) => ({
        ...source,
        occurredAt: source.occurredAt?.toISOString() ?? null,
      })),
    },
    entityLinks: item.entityLinks,
    decision: item.decision
      ? { ...item.decision, effectiveAt: item.decision.effectiveAt?.toISOString() ?? null }
      : null,
    priority: item.priority
      ? {
          ...item.priority,
          startsAt: item.priority.startsAt?.toISOString() ?? null,
          endsAt: item.priority.endsAt?.toISOString() ?? null,
        }
      : null,
    freshness: { createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() },
  }
}

export async function searchCompanyKnowledge(
  rawInput: CompanyKnowledgeSearchRequest,
  access: KnowledgeAccessContext,
  client: CompanyKnowledgeClient = db,
  options: {
    queryEmbedding?: number[]
    semanticSearch?: typeof searchCompanyKnowledgeByEmbedding
  } = {},
) {
  const input = CompanyKnowledgeSearchRequest.parse(rawInput)
  await verifyRequestedVenue(access, input.venueId, input.clientId, client)
  const authorityFilter = input.includeHistorical
    ? input.authorities
    : input.authorities.filter((authority) => !['HISTORICAL', 'SUPERSEDED'].includes(authority))
  const terms = lexicalTerms(input.query)
  const candidates = await client.companyKnowledgeItem.findMany({
    where: {
      AND: [
        accessWhere(access, input.clientId),
        { promotionStatus: 'PROMOTED', archivedAt: null },
        ...(authorityFilter.length > 0 ? [{ authority: { in: authorityFilter } }] : []),
        ...(input.types.length > 0 ? [{ type: { in: input.types } }] : []),
        ...(input.venueId
          ? [venueContextWhere(access, input.venueId, input.clientId, input.organizationId)]
          : input.organizationId
            ? [{ organizationId: input.organizationId }]
            : []),
        ...(input.from || input.to
          ? [
              {
                effectiveAt: {
                  ...(input.from ? { gte: new Date(input.from) } : {}),
                  ...(input.to ? { lte: new Date(input.to) } : {}),
                },
              },
            ]
          : []),
        ...(options.queryEmbedding
          ? []
          : [
              {
                OR: terms.flatMap((term) => [
                  { title: { contains: term, mode: 'insensitive' as const } },
                  { summary: { contains: term, mode: 'insensitive' as const } },
                  {
                    revisions: {
                      some: { body: { contains: term, mode: 'insensitive' as const } },
                    },
                  },
                ]),
              },
            ]),
      ],
    },
    orderBy: [{ authority: 'asc' }, { lastConfirmedAt: 'desc' }, { updatedAt: 'desc' }],
    take: options.queryEmbedding ? 500 : Math.min(input.limit * 4, 80),
    select: detailSelect,
  })
  const semanticRows = options.queryEmbedding
    ? await (options.semanticSearch ?? searchCompanyKnowledgeByEmbedding)({
        queryEmbedding: options.queryEmbedding,
        authorizedCandidateIds: candidates.map((item) => item.id),
        limit: Math.min(input.limit * 8, 50),
      })
    : []
  const semanticById = new Map(semanticRows.map((row) => [row.id, row.distance]))
  const results = candidates
    .map((item) => ({
      item: serializeItem(item),
      relevance:
        lexicalScore(input.query, item.title, item.summary, item.revisions[0]?.body ?? null) * 10 +
        (semanticById.has(item.id)
          ? Math.max(0, Math.round((1 - semanticById.get(item.id)!) * 100))
          : 0),
    }))
    .filter(({ relevance }) => relevance > 0)
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, input.limit)
    .map(({ item, relevance }) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      snippet: item.summary,
      authority: item.authority,
      scope: item.scope,
      effectiveAt: item.effectiveAt,
      supersession: item.supersession,
      relevance,
      provenance: item.provenance.sources,
      next: { detail: 'knowledge.get' },
    }))
  const approximateBytes = Buffer.byteLength(JSON.stringify(results), 'utf8')
  if (approximateBytes > KNOWLEDGE_SEARCH_TARGET_BYTES * 2) {
    throw new CompanyKnowledgeError(
      'PAYLOAD_TOO_LARGE',
      'Knowledge search exceeded its hard payload ceiling',
    )
  }
  return {
    schemaVersion: 'company-knowledge-search.v1',
    retrieval: {
      mode: options.queryEmbedding ? 'HYBRID_STRUCTURED_SEMANTIC' : 'STRUCTURED_LEXICAL',
      permissionFilteredBeforeSelection: true,
      semanticCandidates: semanticRows.length,
    },
    results,
    payload: {
      approximateBytes,
      targetBytes: KNOWLEDGE_SEARCH_TARGET_BYTES,
      withinTarget: approximateBytes <= KNOWLEDGE_SEARCH_TARGET_BYTES,
    },
  }
}

export async function getCompanyKnowledgeItem(
  rawInput: CompanyKnowledgeGetRequest,
  access: KnowledgeAccessContext,
  client: CompanyKnowledgeClient = db,
) {
  const input = CompanyKnowledgeGetRequest.parse(rawInput)
  await verifyRequestedVenue(access, input.venueId, input.clientId, client)
  const item = await client.companyKnowledgeItem.findFirst({
    where: {
      AND: [
        { id: input.knowledgeItemId, archivedAt: null },
        accessWhere(access, input.clientId),
        ...(input.venueId ? [venueContextWhere(access, input.venueId, input.clientId)] : []),
      ],
    },
    select: detailSelect,
  })
  if (!item) {
    throw new CompanyKnowledgeError('NOT_FOUND', 'Knowledge item not found in verified scope')
  }
  return { schemaVersion: 'company-knowledge-item.v1', item: serializeItem(item) }
}
