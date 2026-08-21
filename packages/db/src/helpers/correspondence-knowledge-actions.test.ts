import { describe, expect, it, vi } from 'vitest'

import { proposeCorrespondenceKnowledgeAction } from './correspondence-knowledge-actions'

const actor = {
  type: 'AGENT',
  actorId: 'agent_1',
  role: 'AGENT',
  agentIdentityId: 'agent_1',
  agentRunId: 'run_1',
  workerId: 'worker_1',
  credentialId: 'credential_1',
  capability: 'knowledge.propose',
} as const

function harness() {
  const tx = {
    venue: { findFirst: vi.fn() },
    prospectOrganization: { findFirst: vi.fn().mockResolvedValue({ id: 'org_1' }) },
    companyKnowledgeItem: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: 'knowledge_1',
        contentHash: 'hash',
        promotionStatus: 'CANDIDATE',
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  return {
    tx,
    client: {
      prospectEmailMessage: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'message_1',
          organizationId: 'org_1',
          occurredAt: new Date('2030-01-01T00:00:00.000Z'),
          subject: 'Preference',
        }),
      },
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    },
  }
}

describe('correspondence knowledge proposals', () => {
  it('verifies account ownership and creates an inference candidate with bounded provenance', async () => {
    const { tx, client } = harness()
    const result = await proposeCorrespondenceKnowledgeAction(
      {
        tenantId: 'tenant_1',
        emailMessageId: 'message_1',
        type: 'CLIENT_INSIGHT',
        title: 'Communication preference',
        summary: 'Jane asked for concise email.',
        body: 'Primary contact prefers concise email for operational updates.',
        sourceExcerpt: `Please keep emails short. ${'x'.repeat(800)}`,
        confidence: 0.9,
        idempotencyKey: 'message_1:client-insight:1',
        actor,
      },
      client as never,
    )
    expect(result.promotionStatus).toBe('CANDIDATE')
    expect(client.prospectEmailMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'message_1',
          organization: {
            customerRelationships: { some: { tenantId: 'tenant_1', status: 'ACTIVE' } },
          },
        }),
      }),
    )
    expect(tx.companyKnowledgeItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accessScope: 'ORGANIZATION',
          authority: 'INFERENCE',
          promotionStatus: 'CANDIDATE',
          sources: {
            create: expect.objectContaining({ sourceType: 'EMAIL', sourceId: 'message_1' }),
          },
        }),
      }),
    )
  })

  it('does not allow correspondence automation to propose strategy or authoritative decisions', async () => {
    const { client } = harness()
    await expect(
      proposeCorrespondenceKnowledgeAction(
        {
          tenantId: 'tenant_1',
          emailMessageId: 'message_1',
          type: 'DECISION',
          title: 'Pricing policy',
          summary: 'Policy',
          body: 'Policy',
          idempotencyKey: 'message_1:decision:1',
          actor,
        },
        client as never,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(client.prospectEmailMessage.findFirst).not.toHaveBeenCalled()
  })
})
