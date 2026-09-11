import { describe, expect, it, vi } from 'vitest'

import { getCompanyKnowledgeItem, searchCompanyKnowledge } from './company-knowledge'

const date = new Date('2030-01-01T12:00:00.000Z')

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'knowledge_1',
    tenantId: 'tenant_1',
    venueId: null,
    organizationId: 'org_1',
    type: 'DECISION',
    title: 'Current custom character pricing',
    summary: 'Early-customer custom characters remain included through renewal.',
    accessScope: 'ORGANIZATION',
    authority: 'AUTHORITATIVE_CURRENT',
    promotionStatus: 'PROMOTED',
    currentRevision: 1,
    confidence: 1,
    effectiveAt: date,
    lastConfirmedAt: date,
    supersededAt: null,
    supersededById: null,
    createdByType: 'HUMAN',
    createdById: 'admin_1',
    modelProvider: null,
    modelName: null,
    createdAt: date,
    updatedAt: date,
    revisions: [
      {
        revision: 1,
        body: 'Custom characters remain included for the early-customer cohort.',
        structuredData: {},
        sourceDigest: 'a'.repeat(64),
        authoredByType: 'HUMAN',
        authoredById: 'admin_1',
        modelProvider: null,
        modelName: null,
        createdAt: date,
      },
    ],
    sources: [
      {
        id: 'source_1',
        sourceType: 'MEETING',
        sourceId: 'meeting_1',
        sourceRef: null,
        excerpt: 'Pricing discussion',
        occurredAt: date,
        metadata: {},
      },
    ],
    entityLinks: [{ entityType: 'ORGANIZATION', entityId: 'org_1', relationship: 'CONCERNS' }],
    decision: {
      id: 'decision_1',
      status: 'ACTIVE',
      decision: 'Include custom characters through renewal.',
      rationale: 'Honor the early-customer promise.',
      scope: { cohort: 'early-customer' },
      affectedSystems: ['billing'],
      effectiveAt: date,
      supersedesId: 'decision_old',
    },
    priority: null,
    ...overrides,
  }
}

describe('company knowledge retrieval', () => {
  it('applies client and authority scope before selecting search candidates', async () => {
    const findMany = vi.fn().mockResolvedValue([item()])
    const result = await searchCompanyKnowledge(
      { query: 'custom character pricing', clientId: 'tenant_1', limit: 5 },
      { kind: 'CLIENT', clientId: 'tenant_1', roles: ['CLIENT_ADMIN'] },
      { companyKnowledgeItem: { findMany } } as never,
    )

    const exactQuery = findMany.mock.calls[0]?.[0]
    const strictQuery = findMany.mock.calls[1]?.[0]
    expect(JSON.stringify(strictQuery.where)).toContain('customerRelationships')
    expect(JSON.stringify(strictQuery.where)).not.toContain('PLATFORM')
    expect(JSON.stringify(strictQuery.where)).toContain('AUTHORITATIVE_CURRENT')
    expect(JSON.stringify(strictQuery.where)).toContain('custom')
    expect(JSON.stringify(strictQuery.where)).toContain('character')
    expect(JSON.stringify(strictQuery.where)).toContain('pricing')
    expect(JSON.stringify(strictQuery.where)).not.toContain('custom character pricing')
    expect(JSON.stringify(exactQuery.where)).toContain('custom character pricing')
    expect(exactQuery.take).toBe(20)
    expect(strictQuery.take).toBe(80)
    expect(findMany.mock.calls[2]?.[0].take).toBe(20)
    expect(result.retrieval.permissionFilteredBeforeSelection).toBe(true)
    expect(result.results[0]).toMatchObject({
      id: 'knowledge_1',
      authority: 'AUTHORITATIVE_CURRENT',
      next: { detail: 'knowledge.get' },
    })
    expect(result.results[0]!.relevance).toBeGreaterThan(0)
  })

  it('turns a mismatched requested tenant into an impossible pre-selection predicate', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    await searchCompanyKnowledge(
      { query: 'pricing', clientId: 'tenant_other' },
      { kind: 'CLIENT', clientId: 'tenant_1', roles: [] },
      { companyKnowledgeItem: { findMany } } as never,
    )
    expect(JSON.stringify(findMany.mock.calls[0]?.[0].where)).toContain(
      '__forbidden_client_scope__',
    )
  })

  it('semantic-ranks only IDs returned by the permission-first structured query', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        item({ id: 'allowed_1', title: 'Outdoor venue lesson', summary: 'Weather resilience.' }),
        item({ id: 'allowed_2', title: 'Another lesson', summary: 'Operational context.' }),
      ])
    const semanticSearch = vi.fn().mockResolvedValue([
      { id: 'private_stronger_match', distance: 0.01 },
      { id: 'allowed_2', distance: 0.1 },
      { id: 'allowed_2', distance: 0.2 },
    ])
    const result = await searchCompanyKnowledge(
      { query: 'what did we learn outdoors', clientId: 'tenant_1', limit: 5 },
      { kind: 'CLIENT', clientId: 'tenant_1', roles: [] },
      { companyKnowledgeItem: { findMany } } as never,
      { queryEmbedding: [0.1, 0.2], semanticSearch },
    )
    expect(semanticSearch).toHaveBeenCalledWith(
      expect.objectContaining({ authorizedCandidateIds: ['allowed_1', 'allowed_2'] }),
    )
    expect(findMany.mock.calls[2]?.[0].take).toBe(20)
    expect(JSON.stringify(findMany.mock.calls[2]?.[0].where)).toContain('outdoors')
    expect(findMany.mock.calls[3]?.[0]).toMatchObject({ take: 501, select: { id: true } })
    expect(findMany.mock.calls[4]?.[0]).toMatchObject({
      take: 40,
      where: expect.objectContaining({
        AND: expect.arrayContaining([{ id: { in: ['allowed_2'] } }]),
      }),
    })
    expect(result.retrieval.mode).toBe('HYBRID_STRUCTURED_SEMANTIC')
    expect(result.retrieval.semanticCandidates).toBe(1)
    expect(result.results[0]?.id).toBe('allowed_2')
    expect(result.results.some((row) => row.id === 'private_stronger_match')).toBe(false)
  })

  it('inherits only applicable shared knowledge after verifying the requested venue', async () => {
    const findMany = vi.fn().mockResolvedValue([item()])
    const venueFindFirst = vi.fn().mockResolvedValue({ id: 'venue_2' })
    await searchCompanyKnowledge(
      {
        query: 'custom character pricing',
        clientId: 'tenant_1',
        venueId: 'venue_2',
        organizationId: 'org_1',
      },
      { kind: 'CLIENT', clientId: 'tenant_1', roles: [] },
      { venue: { findFirst: venueFindFirst }, companyKnowledgeItem: { findMany } } as never,
    )
    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue_2', tenantId: 'tenant_1' },
      select: { id: true },
    })
    const where = JSON.stringify(findMany.mock.calls[0]?.[0].where)
    expect(where).toContain('APPLIES_TO')
    expect(where).toContain('venue_2')
    expect(where).toContain('"venueId":null')
    expect(where).toContain('"accessScope":"TENANT"')
    expect(where).toContain('"accessScope":"ORGANIZATION"')
    expect(where).toContain('"accessScope":"VENUE"')
  })

  it('recovers an older all-term commitment beyond the broad recency cap', async () => {
    const olderCommitment = item({
      id: 'older_commitment',
      title: 'Early partner launch commitment',
      summary: 'The early partner launch commitment includes custom characters through renewal.',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      lastConfirmedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    const distractors = Array.from({ length: 500 }, (_, index) =>
      item({
        id: `recent_distractor_${index}`,
        title: index % 2 === 0 ? 'Recent launch note' : 'Recent partner note',
        summary: index % 3 === 0 ? 'Commitment discussion.' : 'Unrelated current context.',
      }),
    )
    const findMany = vi.fn(async (query: { where: { AND: unknown[] }; take: number }) => {
      if (JSON.stringify(query.where).includes('early partner launch commitment'))
        return [olderCommitment]
      const strictAllTerms = query.where.AND.length > 4
      return strictAllTerms ? [olderCommitment] : distractors.slice(0, query.take)
    })

    const result = await searchCompanyKnowledge(
      { query: 'early partner launch commitment', clientId: 'tenant_1', limit: 5 },
      { kind: 'CLIENT', clientId: 'tenant_1', roles: [] },
      { companyKnowledgeItem: { findMany } } as never,
    )

    expect(result.results[0]?.id).toBe('older_commitment')
    expect(result.retrieval.candidateCoverage).toMatchObject({
      strictAllTerms: 1,
      exactPhrase: 1,
      broad: 20,
      broadLimit: 20,
      partial: true,
    })
    expect(findMany).toHaveBeenCalledTimes(3)
  })

  it('pages semantic authorization windows and binds cursors to query, scope, roles, and embedding', async () => {
    const firstIds = Array.from({ length: 501 }, (_, index) => ({ id: `recent_${index}` }))
    const critical = item({
      id: 'older_critical',
      title: 'Older critical fact',
      summary: 'The exact long-tail answer.',
      updatedAt: new Date('2020-01-01T00:00:00.000Z'),
      lastConfirmedAt: new Date('2020-01-01T00:00:00.000Z'),
    })
    const recent = item({ id: 'recent_0', title: 'Recent distractor', summary: 'Weak match.' })
    const findFirst = vi.fn().mockResolvedValue({ id: 'recent_499' })
    const findMany = vi.fn(async (query: Record<string, unknown>) => {
      if (JSON.stringify(query.select) === JSON.stringify({ id: true }))
        return query.cursor ? [{ id: 'older_critical' }] : firstIds
      const ids = JSON.stringify(query.where)
      if (ids.includes('older_critical')) return [critical]
      if (ids.includes('recent_0')) return [recent]
      return []
    })
    const semanticSearch = vi.fn(
      async ({ authorizedCandidateIds }: { authorizedCandidateIds: string[] }) =>
        authorizedCandidateIds.includes('older_critical')
          ? [{ id: 'older_critical', distance: 0.001 }]
          : [{ id: 'recent_0', distance: 0.4 }],
    )
    const request = { query: 'critical long tail', clientId: 'tenant_1', limit: 5 }
    const access = { kind: 'CLIENT' as const, clientId: 'tenant_1', roles: ['OWNER', 'EDITOR'] }
    const client = { companyKnowledgeItem: { findMany, findFirst } } as never
    const first = await searchCompanyKnowledge(request, access, client, {
      queryEmbedding: [0.1, 0.2],
      semanticSearch,
    })
    expect(first.results.some((result) => result.id === 'older_critical')).toBe(false)
    expect(first.retrieval.candidateCoverage).toMatchObject({
      semanticAuthorized: 500,
      semanticAuthorizationLimit: 500,
      semanticRanking: 'PER_WINDOW',
      semanticWindowsExhausted: false,
      consistency: 'BEST_EFFORT_CURRENT_STATE',
    })
    const cursor = first.retrieval.candidateCoverage.nextCursor!
    const second = await searchCompanyKnowledge(
      { ...request, cursor },
      { ...access, roles: [...access.roles].reverse() },
      client,
      {
        queryEmbedding: [0.1, 0.2],
        semanticSearch,
      },
    )
    expect(second.results[0]?.id).toBe('older_critical')
    expect(second.retrieval.candidateCoverage).toMatchObject({
      semanticAuthorized: 1,
      nextCursor: null,
      semanticWindowsExhausted: true,
    })
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ AND: expect.any(Array) }) }),
    )

    const corrupted = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`
    await expect(
      searchCompanyKnowledge({ ...request, cursor: corrupted }, access, client, {
        queryEmbedding: [0.1, 0.2],
        semanticSearch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    const changedBindings: Array<[typeof request & { cursor: string }, typeof access, number[]]> = [
      [{ ...request, query: 'different query', cursor }, access, [0.1, 0.2]],
      [{ ...request, cursor }, { ...access, clientId: 'tenant_2' }, [0.1, 0.2]],
      [{ ...request, cursor }, { ...access, roles: ['OWNER'] }, [0.1, 0.2]],
      [{ ...request, cursor }, access, [0.1, 0.3]],
    ]
    for (const [changedRequest, changedAccess, embedding] of changedBindings) {
      await expect(
        searchCompanyKnowledge(changedRequest, changedAccess, client, {
          queryEmbedding: [...embedding],
          semanticSearch,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    }
  })

  it('rejects a valid continuation when its authorized anchor was deleted or left scope', async () => {
    const ids = Array.from({ length: 501 }, (_, index) => ({ id: `candidate_${index}` }))
    const findMany = vi.fn(async (query: Record<string, unknown>) =>
      JSON.stringify(query.select) === JSON.stringify({ id: true }) ? ids : [],
    )
    const client = {
      companyKnowledgeItem: { findMany, findFirst: vi.fn().mockResolvedValue(null) },
    } as never
    const request = { query: 'long tail fact', clientId: 'tenant_1', limit: 5 }
    const access = { kind: 'CLIENT' as const, clientId: 'tenant_1', roles: [] }
    const first = await searchCompanyKnowledge(request, access, client, {
      queryEmbedding: [0.1],
      semanticSearch: vi.fn().mockResolvedValue([]),
    })
    await expect(
      searchCompanyKnowledge(
        { ...request, cursor: first.retrieval.candidateCoverage.nextCursor! },
        access,
        client,
        { queryEmbedding: [0.1], semanticSearch: vi.fn().mockResolvedValue([]) },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  })

  it('rejects a foreign venue before selecting any knowledge candidates', async () => {
    const findMany = vi.fn()
    await expect(
      searchCompanyKnowledge(
        { query: 'pricing', clientId: 'tenant_1', venueId: 'venue_foreign' },
        { kind: 'CLIENT', clientId: 'tenant_1', roles: [] },
        {
          venue: { findFirst: vi.fn().mockResolvedValue(null) },
          companyKnowledgeItem: { findMany },
        } as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(findMany).not.toHaveBeenCalled()
  })

  it('retrieves inherited detail in venue context only after venue ownership validation', async () => {
    const findFirst = vi.fn().mockResolvedValue(item({ venueId: null }))
    const venueFindFirst = vi.fn().mockResolvedValue({ id: 'venue_2' })
    const result = await getCompanyKnowledgeItem(
      { knowledgeItemId: 'knowledge_1', clientId: 'tenant_1', venueId: 'venue_2' },
      { kind: 'CLIENT', clientId: 'tenant_1', roles: [] },
      { venue: { findFirst: venueFindFirst }, companyKnowledgeItem: { findFirst } } as never,
    )
    expect(result.item.id).toBe('knowledge_1')
    const where = JSON.stringify(findFirst.mock.calls[0]?.[0].where)
    expect(where).toContain('APPLIES_TO')
    expect(where).toContain('PROMOTED')
  })

  it('requires promoted status before client-scoped exact detail selection', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    await expect(
      getCompanyKnowledgeItem(
        { knowledgeItemId: 'candidate_hidden', clientId: 'tenant_1' },
        { kind: 'CLIENT', clientId: 'tenant_1', roles: [] },
        { companyKnowledgeItem: { findFirst } } as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(JSON.stringify(findFirst.mock.calls[0]?.[0].where)).toContain('PROMOTED')
  })

  it('returns exact detail with provenance and supersession, but not when scoped lookup misses', async () => {
    const findFirst = vi.fn().mockResolvedValueOnce(item()).mockResolvedValueOnce(null)
    const client = { companyKnowledgeItem: { findFirst } } as never
    const result = await getCompanyKnowledgeItem(
      { knowledgeItemId: 'knowledge_1', clientId: 'tenant_1' },
      { kind: 'CLIENT', clientId: 'tenant_1', roles: [] },
      client,
    )
    expect(result.item).toMatchObject({
      body: 'Custom characters remain included for the early-customer cohort.',
      decision: { status: 'ACTIVE', supersedesId: 'decision_old' },
      provenance: { sources: [{ sourceType: 'MEETING', sourceId: 'meeting_1' }] },
    })
    await expect(
      getCompanyKnowledgeItem(
        { knowledgeItemId: 'knowledge_hidden', clientId: 'tenant_1' },
        { kind: 'CLIENT', clientId: 'tenant_1', roles: [] },
        client,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
