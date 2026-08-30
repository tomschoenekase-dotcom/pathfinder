import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ audit: vi.fn() }))
vi.mock('./audit', () => ({ writeAuditLogStrict: mocks.audit }))

import {
  applyFounderDecisionPacketAction,
  FounderDecisionPacketActionError,
} from './founder-decision-packet-actions'

const packet = {
  schemaVersion: 'founder-decision-packet.v1' as const,
  packetId: 'founder-direction-2026-08-22',
  title: 'Founder direction',
  effectiveAt: '2026-08-22T05:00:00.000Z',
  sourceRef: 'vault://07 Decisions/Torchiko Founder Engineering Direction 2026-08-22.md',
  decisions: [
    {
      key: 'codex-autonomy',
      title: 'Codex autonomy',
      summary: 'Delegate ordinary engineering decisions.',
      decision: 'Make the best reasonable technical decision and keep moving.',
      rationale: 'Founder judgment should be reserved for consequential boundaries.',
      affectedSystems: ['engineering', 'company-brain', 'engineering'],
      scope: { productionAuthorized: false, environment: 'local-and-staging' },
    },
  ],
}

const actor = { type: 'HUMAN' as const, actorId: 'founder_1', role: 'PLATFORM_ADMIN' }

function client(options?: {
  existing?: unknown
  prior?: unknown[]
  createId?: string
  transactionFailure?: unknown
}) {
  const tx = {
    companyKnowledgeItem: {
      findUnique: vi.fn().mockResolvedValue(options?.existing ?? null),
      findMany: vi.fn().mockResolvedValue(options?.prior ?? []),
      create: vi.fn().mockResolvedValue({ id: options?.createId ?? 'knowledge_new' }),
      update: vi.fn().mockResolvedValue({ id: 'knowledge_prior' }),
    },
  }
  const transaction = vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => {
    if (options?.transactionFailure) throw options.transactionFailure
    return operation(tx)
  })
  return { tx, client: { $transaction: transaction }, transaction }
}

describe('applyFounderDecisionPacketAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('atomically promotes a source-linked founder decision with strict audit evidence', async () => {
    const fixture = client()
    const result = await applyFounderDecisionPacketAction(
      { packet, actor },
      fixture.client as never,
    )

    expect(result.results).toEqual([
      {
        key: 'codex-autonomy',
        knowledgeItemId: 'knowledge_new',
        state: 'APPLIED',
        supersededKnowledgeItemId: null,
      },
    ])
    expect(fixture.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    })
    expect(fixture.tx.companyKnowledgeItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authority: 'AUTHORITATIVE_CURRENT',
        promotionStatus: 'PROMOTED',
        accessScope: 'RESTRICTED',
        createdByType: 'HUMAN',
        createdById: 'founder_1',
        sources: {
          create: expect.objectContaining({
            sourceType: 'HUMAN_ENTRY',
            sourceId: packet.packetId,
            sourceRef: packet.sourceRef,
          }),
        },
        entityLinks: {
          create: {
            entityType: 'FOUNDER_DECISION_KEY',
            entityId: 'codex-autonomy',
            relationship: 'GOVERNS',
          },
        },
        decision: {
          create: expect.objectContaining({
            status: 'ACTIVE',
            affectedSystems: ['company-brain', 'engineering'],
            scope: { environment: 'local-and-staging', productionAuthorized: false },
          }),
        },
      }),
      select: { id: true },
    })
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'company-decision.packet-applied',
        structuredReason: expect.objectContaining({ decisionKey: 'codex-autonomy' }),
      }),
      fixture.tx,
    )
  })

  it('replays the exact current packet without creating or auditing again', async () => {
    const fixture = client({
      existing: {
        id: 'knowledge_existing',
        contentHash: 'placeholder',
        authority: 'AUTHORITATIVE_CURRENT',
        promotionStatus: 'PROMOTED',
        decision: { status: 'ACTIVE' },
      },
    })
    const first = client()
    await applyFounderDecisionPacketAction({ packet, actor }, first.client as never)
    const createInput = first.tx.companyKnowledgeItem.create.mock.calls[0]![0]
    ;(fixture.tx.companyKnowledgeItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'knowledge_existing',
      contentHash: createInput.data.contentHash,
      authority: 'AUTHORITATIVE_CURRENT',
      promotionStatus: 'PROMOTED',
      decision: { status: 'ACTIVE' },
    })

    const result = await applyFounderDecisionPacketAction(
      { packet, actor },
      fixture.client as never,
    )
    expect(result.results[0]).toMatchObject({
      knowledgeItemId: 'knowledge_existing',
      state: 'REPLAYED_CURRENT',
    })
    expect(fixture.tx.companyKnowledgeItem.create).not.toHaveBeenCalled()
    expect(mocks.audit).toHaveBeenCalledTimes(1)
  })

  it('supersedes one current decision and preserves the explicit lineage', async () => {
    const fixture = client({
      prior: [
        {
          id: 'knowledge_prior',
          effectiveAt: new Date('2026-08-21T05:00:00.000Z'),
          decision: { id: 'decision_prior' },
        },
      ],
    })
    const result = await applyFounderDecisionPacketAction(
      { packet, actor },
      fixture.client as never,
    )
    expect(result.results[0]).toMatchObject({ supersededKnowledgeItemId: 'knowledge_prior' })
    expect(fixture.tx.companyKnowledgeItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: { create: expect.objectContaining({ supersedesId: 'decision_prior' }) },
        }),
      }),
    )
    expect(fixture.tx.companyKnowledgeItem.update).toHaveBeenCalledWith({
      where: { id: 'knowledge_prior' },
      data: expect.objectContaining({
        authority: 'SUPERSEDED',
        promotionStatus: 'SUPERSEDED',
        supersededById: 'knowledge_new',
        decision: { update: { status: 'SUPERSEDED' } },
      }),
    })
  })

  it('fails closed for machine actors and ambiguous current truth', async () => {
    const fixture = client({
      prior: [
        {
          id: 'one',
          effectiveAt: new Date('2026-08-21T05:00:00.000Z'),
          decision: { id: 'decision_one' },
        },
        {
          id: 'two',
          effectiveAt: new Date('2026-08-21T05:00:00.000Z'),
          decision: { id: 'decision_two' },
        },
      ],
    })
    await expect(
      applyFounderDecisionPacketAction(
        {
          packet,
          actor: {
            type: 'AGENT',
            actorId: 'agent_1',
            role: 'AGENT',
            capability: 'knowledge.propose',
            agentIdentityId: 'agent_1',
            agentRunId: 'run_1',
            workerId: 'worker_1',
            credentialId: 'credential_1',
          },
        },
        fixture.client as never,
      ),
    ).rejects.toBeInstanceOf(FounderDecisionPacketActionError)
    await expect(
      applyFounderDecisionPacketAction({ packet, actor }, fixture.client as never),
    ).rejects.toThrow(/multiple current records/u)
  })

  it('refuses to let an older packet replace newer current truth', async () => {
    const fixture = client({
      prior: [
        {
          id: 'knowledge_newer',
          effectiveAt: new Date('2026-08-23T05:00:00.000Z'),
          decision: { id: 'decision_newer' },
        },
      ],
    })
    await expect(
      applyFounderDecisionPacketAction({ packet, actor }, fixture.client as never),
    ).rejects.toThrow(/not newer/u)
    expect(fixture.tx.companyKnowledgeItem.create).not.toHaveBeenCalled()
  })
})
