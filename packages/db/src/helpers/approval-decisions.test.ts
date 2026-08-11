import { describe, expect, it, vi } from 'vitest'

import { recordApprovalDecisionAction } from './approval-decisions'

const actor = { actorType: 'HUMAN', actorId: 'admin_1', auditRole: 'PLATFORM_ADMIN' } as const
const decidedAt = new Date('2030-01-01T12:00:00.000Z')

function harness() {
  const tx = {
    approvalRequest: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'approval_1',
        venueId: 'venue_1',
        proposedAction: 'publish_update',
        riskCategory: 'HIGH',
        expiresAt: new Date('2030-01-02T00:00:00.000Z'),
        decision: null,
      }),
    },
    approvalDecision: {
      create: vi.fn().mockResolvedValue({
        id: 'decision_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalRequestId: 'approval_1',
        decision: 'APPROVED',
        decidedByType: 'HUMAN',
        decidedById: 'admin_1',
        reason: 'Reviewed',
        createdAt: decidedAt,
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, client, actionClient: client as never }
}

function input(overrides: Partial<Parameters<typeof recordApprovalDecisionAction>[0]> = {}) {
  return {
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    approvalRequestId: 'approval_1',
    decision: 'APPROVED' as const,
    reason: 'Reviewed',
    decidedAt,
    actor,
    ...overrides,
  }
}

describe('approval decision domain action', () => {
  it('records decision and immutable audit evidence without execution side effects', async () => {
    const { tx, actionClient } = harness()
    await recordApprovalDecisionAction(input(), actionClient)
    expect(tx.approvalRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'approval_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      }),
    )
    expect(tx.approvalDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'APPROVED',
          decidedByType: 'HUMAN',
          decidedById: 'admin_1',
        }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          afterState: expect.objectContaining({ executionTriggered: false }),
        }),
      }),
    )
    expect(tx).not.toHaveProperty('agentAction')
    expect(tx).not.toHaveProperty('agentRun')
    expect(tx).not.toHaveProperty('jobRecord')
  })

  it('rejects an expired request before writing a decision', async () => {
    const { tx, actionClient } = harness()
    tx.approvalRequest.findFirst.mockResolvedValueOnce({
      id: 'approval_1',
      venueId: 'venue_1',
      proposedAction: 'x',
      riskCategory: 'LOW',
      expiresAt: decidedAt,
      decision: null,
    })
    await expect(recordApprovalDecisionAction(input(), actionClient)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Approval request has expired',
    })
    expect(tx.approvalDecision.create).not.toHaveBeenCalled()
  })

  it('requires exact venue scope and returns not found for cross-venue lookup', async () => {
    const { tx, actionClient } = harness()
    tx.approvalRequest.findFirst.mockResolvedValueOnce(null)
    await expect(
      recordApprovalDecisionAction(input({ venueId: 'venue_other' }), actionClient),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(tx.approvalRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'approval_1', tenantId: 'tenant_1', venueId: 'venue_other' },
      }),
    )
  })

  it('normalizes a duplicate-decision race to conflict', async () => {
    const { tx, actionClient } = harness()
    tx.approvalDecision.create.mockRejectedValueOnce({ code: 'P2002' })
    await expect(recordApprovalDecisionAction(input(), actionClient)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Approval request already has a decision',
    })
  })

  it.each(['AGENT', 'SYSTEM'])(
    'rejects %s actor spoofing before transaction',
    async (actorType) => {
      const { client, actionClient } = harness()
      await expect(
        recordApprovalDecisionAction(
          input({ actor: { actorType, actorId: 'spoof', auditRole: 'PLATFORM_ADMIN' } as never }),
          actionClient,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(client.$transaction).not.toHaveBeenCalled()
    },
  )

  it('fails the transaction contract when immutable audit persistence fails', async () => {
    const { tx, actionClient } = harness()
    tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(recordApprovalDecisionAction(input(), actionClient)).rejects.toThrow(
      'audit unavailable',
    )
    expect(tx.approvalDecision.create).toHaveBeenCalledOnce()
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })
})
