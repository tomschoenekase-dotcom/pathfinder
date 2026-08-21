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
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue_1' }) },
    prospectOrganization: { findFirst: vi.fn().mockResolvedValue({ id: 'org_1' }) },
    companyKnowledgeItem: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({
        id: 'knowledge_1',
        contentHash: 'a'.repeat(64),
        promotionStatus: 'CANDIDATE',
      }),
      update: vi.fn(),
    },
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
    tx.companyKnowledgeItem.update.mockResolvedValue({
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

  it('supersedes current knowledge only through a human action and preserves linkage', async () => {
    const { tx, client } = harness()
    tx.companyKnowledgeItem.findFirst
      .mockResolvedValueOnce({
        id: 'knowledge_old',
        tenantId: null,
        promotionStatus: 'PROMOTED',
        authority: 'AUTHORITATIVE_CURRENT',
        supersededById: null,
        decision: { id: 'decision_old' },
      })
      .mockResolvedValueOnce({
        id: 'knowledge_new',
        tenantId: null,
        promotionStatus: 'PROMOTED',
        authority: 'AUTHORITATIVE_CURRENT',
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
    expect(tx.companyKnowledgeItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authority: 'SUPERSEDED',
          promotionStatus: 'SUPERSEDED',
          decision: { update: { status: 'SUPERSEDED' } },
        }),
      }),
    )
  })

  it('does not assume every authoritative knowledge item has a decision child', async () => {
    const { tx, client } = harness()
    tx.companyKnowledgeItem.findFirst
      .mockResolvedValueOnce({
        id: 'knowledge_old',
        tenantId: 'tenant_1',
        promotionStatus: 'PROMOTED',
        authority: 'AUTHORITATIVE_CURRENT',
        supersededById: null,
        decision: null,
      })
      .mockResolvedValueOnce({
        id: 'knowledge_new',
        tenantId: 'tenant_1',
        promotionStatus: 'PROMOTED',
        authority: 'AUTHORITATIVE_CURRENT',
        supersededById: null,
        decision: null,
      })
    tx.companyKnowledgeItem.update.mockResolvedValue({
      id: 'knowledge_old',
      supersededById: 'knowledge_new',
      authority: 'SUPERSEDED',
      promotionStatus: 'SUPERSEDED',
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
    expect(tx.companyKnowledgeItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ decision: expect.anything() }),
      }),
    )
  })
})
