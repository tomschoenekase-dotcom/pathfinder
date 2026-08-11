import { describe, expect, it, vi } from 'vitest'

import { transitionSupportRequestStatusAction } from './support-status-transitions'

const actor = {
  actorType: 'HUMAN',
  participantKind: 'OPERATOR',
  actorId: 'admin_1',
  auditRole: 'PLATFORM_ADMIN',
} as const
const changedAt = new Date('2030-01-01T00:00:00.000Z')
const input = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  requestId: 'request_1',
  expectedVersion: 2,
  toStatus: 'PATCH_DRAFTED' as const,
  actor,
  changedAt,
}

function harness() {
  const tx = {
    supportRequest: {
      findFirst: vi.fn().mockResolvedValue({ id: 'request_1', status: 'IN_REVIEW', version: 2 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    supportRequestAuditEvent: { create: vi.fn().mockResolvedValue({ id: 'event_1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, client, actionClient: client as never }
}

describe('support status transition domain action', () => {
  it('uses exact scope and CAS with coupled support and platform audit', async () => {
    const { tx, actionClient } = harness()
    await transitionSupportRequestStatusAction(input, actionClient)
    expect(tx.supportRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'request_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      }),
    )
    expect(tx.supportRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'request_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        version: 2,
        status: 'IN_REVIEW',
      },
      data: {
        status: 'PATCH_DRAFTED',
        statusChangedAt: changedAt,
        version: 3,
        updatedByKind: 'OPERATOR',
        updatedById: 'admin_1',
      },
    })
    expect(tx.supportRequestAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'STATUS_CHANGED',
          fromStatus: 'IN_REVIEW',
          toStatus: 'PATCH_DRAFTED',
          requestVersion: 3,
        }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          afterState: expect.objectContaining({
            packageLifecycleChanged: false,
            executionTriggered: false,
          }),
        }),
      }),
    )
    expect(tx).not.toHaveProperty('venuePackage')
  })

  it.each([
    ['IN_REVIEW', 'COMPLETED'],
    ['PATCH_DRAFTED', 'APPLYING'],
    ['COMPLETED', 'OPEN'],
    ['CANCELLED', 'OPEN'],
  ] as const)('rejects unsafe transition %s -> %s', async (fromStatus, toStatus) => {
    const { tx, actionClient } = harness()
    tx.supportRequest.findFirst.mockResolvedValueOnce({
      id: 'request_1',
      status: fromStatus,
      version: 2,
    })
    await expect(
      transitionSupportRequestStatusAction({ ...input, toStatus }, actionClient),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.supportRequest.updateMany).not.toHaveBeenCalled()
  })

  it('rejects wrong scope, stale CAS, and a concurrent state change', async () => {
    const missing = harness()
    missing.tx.supportRequest.findFirst.mockResolvedValueOnce(null)
    await expect(
      transitionSupportRequestStatusAction(input, missing.actionClient),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const stale = harness()
    await expect(
      transitionSupportRequestStatusAction({ ...input, expectedVersion: 1 }, stale.actionClient),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const race = harness()
    race.tx.supportRequest.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(
      transitionSupportRequestStatusAction(input, race.actionClient),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects client/agent spoofing before transaction', async () => {
    for (const badActor of [
      { ...actor, participantKind: 'CLIENT' as const },
      {
        actorType: 'AGENT',
        participantKind: 'OPERATOR',
        actorId: 'agent',
        auditRole: 'PLATFORM_ADMIN',
      } as never,
    ]) {
      const { client, actionClient } = harness()
      await expect(
        transitionSupportRequestStatusAction({ ...input, actor: badActor }, actionClient),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(client.$transaction).not.toHaveBeenCalled()
    }
  })

  it('propagates audit failure to the transaction boundary', async () => {
    const { tx, actionClient } = harness()
    tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(transitionSupportRequestStatusAction(input, actionClient)).rejects.toThrow(
      'audit unavailable',
    )
  })
})
