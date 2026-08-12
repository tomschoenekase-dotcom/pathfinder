import { describe, expect, it, vi } from 'vitest'

import { linkSupportRequestDraftPackageAction } from './support-package-handoffs'

const actor = {
  actorType: 'HUMAN',
  participantKind: 'OPERATOR',
  actorId: 'admin_1',
  auditRole: 'PLATFORM_ADMIN',
} as const
const input = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  requestId: 'request_1',
  venuePackageId: 'package_1',
  expectedVersion: 3,
  actor,
}

function harness() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    supportRequest: {
      findFirst: vi.fn().mockResolvedValue({ id: 'request_1', status: 'OPEN', version: 3 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    venuePackage: { findFirst: vi.fn().mockResolvedValue({ id: 'package_1', status: 'DRAFT' }) },
    supportPackageHandoff: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: 'handoff_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        supportRequestId: 'request_1',
        venuePackageId: 'package_1',
        requestVersion: 4,
        linkedByKind: 'OPERATOR',
        linkedById: 'admin_1',
        createdAt: new Date(),
      }),
    },
    supportRequestAuditEvent: { create: vi.fn().mockResolvedValue({ id: 'event_1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, client, actionClient: client as never }
}

describe('support request draft-package handoff', () => {
  it('uses exact scope, CAS, immutable evidence and never mutates package lifecycle', async () => {
    const { tx, actionClient } = harness()
    await linkSupportRequestDraftPackageAction(input, actionClient)
    expect(tx.supportRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'request_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      }),
    )
    expect(tx.$executeRaw).toHaveBeenCalledOnce()
    expect(tx.venuePackage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'package_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      }),
    )
    expect(tx.supportRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          version: 3,
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        }),
        data: { version: 4, updatedByKind: 'OPERATOR', updatedById: 'admin_1' },
      }),
    )
    expect(tx.supportRequestAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'PACKAGE_DRAFT_LINKED', requestVersion: 4 }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
    expect(tx.venuePackage).not.toHaveProperty('create')
    expect(tx.venuePackage).not.toHaveProperty('update')
  })

  it.each(['COMPLETED', 'CANCELLED'])('rejects closed request status %s', async (status) => {
    const { tx, actionClient } = harness()
    tx.supportRequest.findFirst.mockResolvedValueOnce({ id: 'request_1', status, version: 3 })
    await expect(linkSupportRequestDraftPackageAction(input, actionClient)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(tx.supportPackageHandoff.create).not.toHaveBeenCalled()
  })

  it('rejects wrong-scope package and non-DRAFT package', async () => {
    const { tx, actionClient } = harness()
    tx.venuePackage.findFirst.mockResolvedValueOnce(null)
    await expect(linkSupportRequestDraftPackageAction(input, actionClient)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    tx.venuePackage.findFirst.mockResolvedValueOnce({ id: 'package_1', status: 'APPROVED' })
    await expect(linkSupportRequestDraftPackageAction(input, actionClient)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('rejects stale versions, duplicates, and client actors', async () => {
    const first = harness()
    await expect(
      linkSupportRequestDraftPackageAction({ ...input, expectedVersion: 2 }, first.actionClient),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const second = harness()
    second.tx.supportPackageHandoff.findFirst.mockResolvedValueOnce({ id: 'existing' })
    await expect(
      linkSupportRequestDraftPackageAction(input, second.actionClient),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const third = harness()
    await expect(
      linkSupportRequestDraftPackageAction(
        { ...input, actor: { ...actor, participantKind: 'CLIENT' } },
        third.actionClient,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(third.client.$transaction).not.toHaveBeenCalled()
  })

  it('normalizes duplicate races and propagates audit failure', async () => {
    const race = harness()
    race.tx.supportPackageHandoff.create.mockRejectedValueOnce({ code: 'P2002' })
    await expect(
      linkSupportRequestDraftPackageAction(input, race.actionClient),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const audit = harness()
    audit.tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(linkSupportRequestDraftPackageAction(input, audit.actionClient)).rejects.toThrow(
      'audit unavailable',
    )
  })
})
