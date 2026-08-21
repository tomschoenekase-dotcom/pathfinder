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

    const query = findMany.mock.calls[0]?.[0]
    expect(JSON.stringify(query.where)).toContain('customerRelationships')
    expect(JSON.stringify(query.where)).not.toContain('PLATFORM')
    expect(JSON.stringify(query.where)).toContain('AUTHORITATIVE_CURRENT')
    expect(query.take).toBe(20)
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
