import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  createCompanyKnowledgeCandidateAction,
  promoteCompanyKnowledgeAction,
  supersedeCompanyKnowledgeAction,
} from './company-knowledge-actions'

const machineActor = {
  type: 'AGENT',
  actorId: 'agent_1',
  role: 'AGENT',
  agentIdentityId: 'agent_1',
  agentRunId: 'run_1',
  workerId: 'worker_1',
  credentialId: 'credential_1',
  capability: 'knowledge.propose',
  modelProvider: 'hermes',
  modelName: 'worker-default',
} as const

function harness() {
  const tx = {
    venue: {
      findFirst: vi.fn().mockResolvedValue({ id: 'venue_1' }),
      findMany: vi.fn().mockResolvedValue([{ id: 'venue_1' }, { id: 'venue_2' }]),
    },
    prospectOrganization: { findFirst: vi.fn().mockResolvedValue({ id: 'org_1' }) },
    companyKnowledgeItem: {
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({
        id: 'knowledge_1',
        contentHash: 'a'.repeat(64),
        promotionStatus: 'CANDIDATE',
      }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    companyDecision: { update: vi.fn().mockResolvedValue({ id: 'decision_1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
    embeddingDispatch: { upsert: vi.fn().mockResolvedValue({ id: 'dispatch_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, client: client as never }
}

function candidateInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    organizationId: 'org_1',
    type: 'CLIENT_INSIGHT',
    title: 'Communication preference',
    summary: 'Primary contact prefers concise email.',
    body: 'Jane asked Torchiko to keep operational email concise.',
    accessScope: 'ORGANIZATION',
    authority: 'DURABLE_CONTEXT',
    sourceType: 'MEETING',
    sourceId: 'meeting_1',
    idempotencyKey: 'knowledge:meeting_1:preference_1',
    actor: machineActor,
    ...overrides,
  } as const
}

function candidateContentHash() {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'Communication preference',
        'Primary contact prefers concise email.',
        'Jane asked Torchiko to keep operational email concise.',
      ]),
    )
    .digest('hex')
}

describe('company knowledge canonical actions', () => {
  it('creates an idempotent candidate through verified scope with machine lineage', async () => {
    const { tx, client } = harness()
    const result = await createCompanyKnowledgeCandidateAction(candidateInput(), client)
    expect(result.replayed).toBe(false)
    expect(tx.prospectOrganization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerRelationships: { some: { tenantId: 'tenant_1', status: 'ACTIVE' } },
        }),
      }),
    )
    expect(tx.companyKnowledgeItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          promotionStatus: 'CANDIDATE',
          createdByType: 'AGENT',
          revisions: { create: expect.objectContaining({ authoredById: 'agent_1' }) },
        }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'company-knowledge.candidate-created',
          actorType: 'AGENT',
          workerId: 'worker_1',
        }),
      }),
    )
  })

  it('creates a verified explicit venue subset as durable applicability links', async () => {
    const { tx, client } = harness()
    await createCompanyKnowledgeCandidateAction(
      candidateInput({ applicableVenueIds: ['venue_2', 'venue_1'] }),
      client,
    )
    expect(tx.venue.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', id: { in: ['venue_1', 'venue_2'] } },
      select: { id: true },
    })
    expect(tx.companyKnowledgeItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityLinks: {
            create: [
              {
                tenantId: 'tenant_1',
                entityType: 'VENUE',
                entityId: 'venue_1',
                relationship: 'APPLIES_TO',
              },
              {
                tenantId: 'tenant_1',
                entityType: 'VENUE',
                entityId: 'venue_2',
                relationship: 'APPLIES_TO',
              },
            ],
          },
        }),
      }),
    )
  })

  it('fails closed when an explicit venue subset contains an unverified venue', async () => {
    const { tx, client } = harness()
    tx.venue.findMany.mockResolvedValue([{ id: 'venue_1' }])
    await expect(
      createCompanyKnowledgeCandidateAction(
        candidateInput({ applicableVenueIds: ['venue_1', 'venue_other'] }),
        client,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(tx.companyKnowledgeItem.create).not.toHaveBeenCalled()
  })

  it('binds idempotency replay to the exact knowledge scope and applicability', async () => {
    const { tx, client } = harness()
    tx.companyKnowledgeItem.findUnique.mockResolvedValue({
      id: 'knowledge_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      organizationId: 'org_1',
      accessScope: 'ORGANIZATION',
      contentHash: candidateContentHash(),
      promotionStatus: 'CANDIDATE',
      entityLinks: [{ entityId: 'venue_1' }],
    })
    await expect(
      createCompanyKnowledgeCandidateAction(
        candidateInput({ applicableVenueIds: ['venue_1', 'venue_2'] }),
        client,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('replays only an exact content, scope, and venue-applicability match', async () => {
    const { tx, client } = harness()
    tx.companyKnowledgeItem.findUnique.mockResolvedValue({
      id: 'knowledge_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      organizationId: 'org_1',
      accessScope: 'ORGANIZATION',
      contentHash: candidateContentHash(),
      promotionStatus: 'CANDIDATE',
      entityLinks: [{ entityId: 'venue_1' }],
    })
    const result = await createCompanyKnowledgeCandidateAction(
      candidateInput({ applicableVenueIds: ['venue_1'] }),
      client,
    )
    expect(result).toMatchObject({ id: 'knowledge_1', replayed: true })
    expect(tx.companyKnowledgeItem.create).not.toHaveBeenCalled()
  })

  it('rejects duplicate venue IDs instead of silently changing requested scope', async () => {
    await expect(
      createCompanyKnowledgeCandidateAction(
        candidateInput({ applicableVenueIds: ['venue_1', 'venue_1'] }),
        harness().client,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
  })

  it('prevents a machine proposal from declaring itself authoritative', async () => {
    await expect(
      createCompanyKnowledgeCandidateAction(
        candidateInput({ authority: 'AUTHORITATIVE_CURRENT' }),
        harness().client,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('creates first-class decision detail in the same canonical transaction', async () => {
    const { tx, client } = harness()
    await createCompanyKnowledgeCandidateAction(
      candidateInput({
        type: 'DECISION',
        authority: 'AUTHORITATIVE_CURRENT',
        actor: { type: 'HUMAN', actorId: 'admin_1', role: 'PLATFORM_ADMIN' },
        decision: {
          status: 'ACTIVE',
          decision: 'Use add-on pricing for custom characters.',
          rationale: 'Support sustainable custom production.',
          affectedSystems: ['billing', 'sales'],
        },
      }),
      client,
    )
    expect(tx.companyKnowledgeItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: {
            create: expect.objectContaining({
              status: 'ACTIVE',
              decision: 'Use add-on pricing for custom characters.',
              affectedSystems: ['billing', 'sales'],
            }),
          },
        }),
      }),
    )
  })

  it('allows capability-bounded machine promotion only for low-risk knowledge', async () => {
    const { tx, client } = harness()
    tx.companyKnowledgeItem.findFirst.mockResolvedValue({
      id: 'knowledge_1',
      tenantId: 'tenant_1',
      promotionStatus: 'CANDIDATE',
      authority: 'DURABLE_CONTEXT',
      venueId: 'venue_1',
      updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    })
    tx.companyKnowledgeItem.findUniqueOrThrow.mockResolvedValue({
      id: 'knowledge_1',
      tenantId: 'tenant_1',
      promotionStatus: 'PROMOTED',
      authority: 'DURABLE_CONTEXT',
      venueId: 'venue_1',
      updatedAt: new Date('2030-01-01T00:01:00.000Z'),
    })
    const result = await promoteCompanyKnowledgeAction(
      {
        knowledgeItemId: 'knowledge_1',
        tenantId: 'tenant_1',
        promotionReason: 'Policy-reviewed low-risk client preference',
        actor: { ...machineActor, capability: 'knowledge.promote-low-risk' },
      },
      client,
    )
    expect(result.promotionStatus).toBe('PROMOTED')
    expect(tx.embeddingDispatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ entityType: 'COMPANY_KNOWLEDGE' }),
      }),
    )
  })

  it('rejects promotion by a non-admin human or an unreviewed system actor', async () => {
    const first = harness()
    await expect(
      promoteCompanyKnowledgeAction(
        {
          knowledgeItemId: 'knowledge_1',
          promotionReason: 'Unreviewed promotion',
          actor: { type: 'HUMAN', actorId: 'client_1', role: 'CLIENT_ADMIN' },
        },
        first.client,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(first.tx.companyKnowledgeItem.findFirst).not.toHaveBeenCalled()

    const second = harness()
    await expect(
      promoteCompanyKnowledgeAction(
        {
          knowledgeItemId: 'knowledge_1',
          promotionReason: 'Background promotion',
          actor: {
            type: 'SYSTEM',
            actorId: 'company-brain-refresh',
            role: 'SYSTEM',
            systemJobId: 'job_1',
          },
        },
        second.client,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(second.tx.companyKnowledgeItem.findFirst).not.toHaveBeenCalled()
  })

  it('supersedes current knowledge only through a human action and preserves linkage', async () => {
    const { tx, client } = harness()
    tx.companyKnowledgeItem.findFirst
      .mockResolvedValueOnce({
        id: 'knowledge_old',
        tenantId: null,
        promotionStatus: 'PROMOTED',
        authority: 'AUTHORITATIVE_CURRENT',
        venueId: null,
        organizationId: null,
        accessScope: 'RESTRICTED',
        type: 'DECISION',
        entityLinks: [],
        supersededById: null,
        decision: { id: 'decision_old' },
      })
      .mockResolvedValueOnce({
        id: 'knowledge_new',
        tenantId: null,
        promotionStatus: 'PROMOTED',
        authority: 'AUTHORITATIVE_CURRENT',
        venueId: null,
        organizationId: null,
        accessScope: 'RESTRICTED',
        type: 'DECISION',
        entityLinks: [],
        supersededById: null,
        decision: { id: 'decision_new' },
      })
    tx.companyKnowledgeItem.update.mockResolvedValue({
      id: 'knowledge_old',
      supersededById: 'knowledge_new',
      authority: 'SUPERSEDED',
      promotionStatus: 'SUPERSEDED',
    })
    const result = await supersedeCompanyKnowledgeAction(
      {
        priorItemId: 'knowledge_old',
        replacementItemId: 'knowledge_new',
        reason: 'New pricing policy',
        actor: { type: 'HUMAN', actorId: 'admin_1', role: 'PLATFORM_ADMIN' },
      },
      client,
    )
    expect(result.prior.supersededById).toBe('knowledge_new')
    expect(tx.companyKnowledgeItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          promotionStatus: 'PROMOTED',
          supersededById: null,
        }),
      }),
    )
    expect(tx.companyDecision.update).toHaveBeenCalledWith({
      where: { id: 'decision_old' },
      data: { status: 'SUPERSEDED' },
    })
  })

  it('does not assume every authoritative knowledge item has a decision child', async () => {
    const { tx, client } = harness()
    tx.companyKnowledgeItem.findFirst
      .mockResolvedValueOnce({
        id: 'knowledge_old',
        tenantId: 'tenant_1',
        promotionStatus: 'PROMOTED',
        authority: 'AUTHORITATIVE_CURRENT',
        venueId: 'venue_1',
        organizationId: 'org_1',
        accessScope: 'ORGANIZATION',
        type: 'CLIENT_INSIGHT',
        entityLinks: [],
        supersededById: null,
        decision: null,
      })
      .mockResolvedValueOnce({
        id: 'knowledge_new',
        tenantId: 'tenant_1',
        promotionStatus: 'PROMOTED',
        authority: 'AUTHORITATIVE_CURRENT',
        venueId: 'venue_1',
        organizationId: 'org_1',
        accessScope: 'ORGANIZATION',
        type: 'CLIENT_INSIGHT',
        entityLinks: [],
        supersededById: null,
        decision: null,
      })
    await supersedeCompanyKnowledgeAction(
      {
        priorItemId: 'knowledge_old',
        replacementItemId: 'knowledge_new',
        tenantId: 'tenant_1',
        reason: 'Replacement approved',
        actor: { type: 'HUMAN', actorId: 'admin_1', role: 'PLATFORM_ADMIN' },
      },
      client,
    )
    expect(tx.companyDecision.update).not.toHaveBeenCalled()
  })

  it('rejects cross-scope supersession before changing current truth', async () => {
    const { tx, client } = harness()
    tx.companyKnowledgeItem.findFirst
      .mockResolvedValueOnce({
        id: 'knowledge_old',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        organizationId: 'org_1',
        accessScope: 'ORGANIZATION',
        type: 'CLIENT_INSIGHT',
        promotionStatus: 'PROMOTED',
        authority: 'DURABLE_CONTEXT',
        supersededById: null,
        entityLinks: [{ entityId: 'venue_1' }],
        decision: null,
      })
      .mockResolvedValueOnce({
        id: 'knowledge_new',
        tenantId: 'tenant_2',
        venueId: 'venue_2',
        organizationId: 'org_2',
        accessScope: 'ORGANIZATION',
        type: 'CLIENT_INSIGHT',
        promotionStatus: 'PROMOTED',
        authority: 'DURABLE_CONTEXT',
        supersededById: null,
        entityLinks: [{ entityId: 'venue_2' }],
        decision: null,
      })
    await expect(
      supersedeCompanyKnowledgeAction(
        {
          priorItemId: 'knowledge_old',
          replacementItemId: 'knowledge_new',
          reason: 'Invalid cross-tenant replacement',
          actor: { type: 'HUMAN', actorId: 'admin_1', role: 'PLATFORM_ADMIN' },
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    expect(tx.companyKnowledgeItem.updateMany).not.toHaveBeenCalled()
  })

  it('rejects supersession of an unpromoted candidate', async () => {
    const { tx, client } = harness()
    const common = {
      tenantId: 'tenant_1',
      venueId: null,
      organizationId: null,
      accessScope: 'TENANT',
      type: 'POLICY_CONTEXT',
      authority: 'DURABLE_CONTEXT',
      supersededById: null,
      entityLinks: [],
      decision: null,
    }
    tx.companyKnowledgeItem.findFirst
      .mockResolvedValueOnce({ ...common, id: 'knowledge_old', promotionStatus: 'CANDIDATE' })
      .mockResolvedValueOnce({ ...common, id: 'knowledge_new', promotionStatus: 'PROMOTED' })
    await expect(
      supersedeCompanyKnowledgeAction(
        {
          priorItemId: 'knowledge_old',
          replacementItemId: 'knowledge_new',
          tenantId: 'tenant_1',
          reason: 'Candidate cannot become historical truth',
          actor: { type: 'HUMAN', actorId: 'admin_1', role: 'PLATFORM_ADMIN' },
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.companyKnowledgeItem.updateMany).not.toHaveBeenCalled()
  })

  it('replays the winner of a concurrent promotion without duplicate evidence', async () => {
    const { tx, client } = harness()
    tx.companyKnowledgeItem.findFirst.mockResolvedValue({
      id: 'knowledge_1',
      tenantId: 'tenant_1',
      promotionStatus: 'CANDIDATE',
      authority: 'DURABLE_CONTEXT',
      venueId: 'venue_1',
    })
    tx.companyKnowledgeItem.updateMany.mockResolvedValue({ count: 0 })
    tx.companyKnowledgeItem.findUnique.mockResolvedValue({
      id: 'knowledge_1',
      tenantId: 'tenant_1',
      promotionStatus: 'PROMOTED',
      authority: 'DURABLE_CONTEXT',
      venueId: 'venue_1',
      updatedAt: new Date('2030-01-01T00:01:00.000Z'),
    })
    const result = await promoteCompanyKnowledgeAction(
      {
        knowledgeItemId: 'knowledge_1',
        tenantId: 'tenant_1',
        promotionReason: 'Concurrent reviewed promotion',
        actor: { type: 'HUMAN', actorId: 'admin_1', role: 'PLATFORM_ADMIN' },
      },
      client,
    )
    expect(result).toMatchObject({ promotionStatus: 'PROMOTED', replayed: true })
    expect(tx.embeddingDispatch.upsert).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('replays only the same replacement after a concurrent supersession', async () => {
    const { tx, client } = harness()
    const common = {
      tenantId: 'tenant_1',
      venueId: null,
      organizationId: null,
      accessScope: 'TENANT',
      type: 'POLICY_CONTEXT',
      authority: 'DURABLE_CONTEXT',
      entityLinks: [],
      decision: null,
    }
    tx.companyKnowledgeItem.findFirst
      .mockResolvedValueOnce({
        ...common,
        id: 'knowledge_old',
        promotionStatus: 'PROMOTED',
        supersededById: null,
      })
      .mockResolvedValueOnce({
        ...common,
        id: 'knowledge_new',
        promotionStatus: 'PROMOTED',
        supersededById: null,
      })
    tx.companyKnowledgeItem.updateMany.mockResolvedValue({ count: 0 })
    tx.companyKnowledgeItem.findUnique.mockResolvedValue({
      id: 'knowledge_old',
      supersededById: 'knowledge_new',
      authority: 'SUPERSEDED',
      promotionStatus: 'SUPERSEDED',
    })
    const result = await supersedeCompanyKnowledgeAction(
      {
        priorItemId: 'knowledge_old',
        replacementItemId: 'knowledge_new',
        tenantId: 'tenant_1',
        reason: 'Concurrent replacement',
        actor: { type: 'HUMAN', actorId: 'admin_1', role: 'PLATFORM_ADMIN' },
      },
      client,
    )
    expect(result).toMatchObject({ replayed: true, prior: { supersededById: 'knowledge_new' } })
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })
})
