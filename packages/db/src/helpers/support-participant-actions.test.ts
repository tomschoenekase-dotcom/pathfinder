import { describe, expect, it, vi } from 'vitest'

import {
  grantSupportRequestParticipantAction,
  revokeSupportRequestParticipantAction,
} from './support-participant-actions'

const input = {
  operationId: '00000000-0000-4000-8000-000000000010',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  requestId: 'request_1',
  userId: 'member_2',
  expectedClientVersion: 2,
  actor: {
    actorType: 'HUMAN' as const,
    participantKind: 'CLIENT' as const,
    actorId: 'requester_1',
    auditRole: 'STAFF' as const,
  },
}

function harness() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    supportRequest: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'request_1',
        version: 4,
        clientVersion: 2,
        requesterUserId: 'requester_1',
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    tenantMembership: { findFirst: vi.fn().mockResolvedValue({ userId: 'member_2' }) },
    supportRequestParticipant: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'participant_1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    supportRequestAuditEvent: { create: vi.fn().mockResolvedValue({ id: 'event_1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, rawClient: client, client: client as never }
}

describe('support participant actions', () => {
  it('grants an exact active tenant member with requester CAS and sanitized audit', async () => {
    const { tx, client } = harness()
    await expect(grantSupportRequestParticipantAction(input, client)).resolves.toMatchObject({
      active: true,
      clientVersion: 3,
      replayed: false,
    })
    expect(tx.supportRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requesterUserId: 'requester_1' }),
      }),
    )
    expect(tx.tenantMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', userId: 'member_2', status: 'ACTIVE' },
      }),
    )
    const audit = JSON.stringify(tx.auditLog.create.mock.calls)
    expect(audit).not.toContain('member_2')
  })

  it('rejects delegation, inactive membership, self grant, and stale CAS without writes', async () => {
    const participant = harness()
    participant.tx.supportRequest.findFirst.mockResolvedValueOnce(null)
    await expect(
      grantSupportRequestParticipantAction(
        { ...input, actor: { ...input.actor, actorId: 'participant_3' } },
        participant.client,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const inactive = harness()
    inactive.tx.tenantMembership.findFirst.mockResolvedValueOnce(null)
    await expect(
      grantSupportRequestParticipantAction(input, inactive.client),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    const self = harness()
    await expect(
      grantSupportRequestParticipantAction({ ...input, userId: 'requester_1' }, self.client),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const stale = harness()
    stale.tx.supportRequest.findFirst.mockResolvedValueOnce({
      id: 'request_1',
      version: 4,
      clientVersion: 3,
      requesterUserId: 'requester_1',
    })
    await expect(grantSupportRequestParticipantAction(input, stale.client)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(stale.tx.supportRequestParticipant.create).not.toHaveBeenCalled()
  })

  it('revokes under the same request lock and replays exact identity', async () => {
    const first = harness()
    first.tx.supportRequestParticipant.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'participant_1' })
    await expect(revokeSupportRequestParticipantAction(input, first.client)).resolves.toMatchObject(
      {
        active: false,
        clientVersion: 3,
      },
    )
    expect(first.tx.supportRequestParticipant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ revokedAt: null }) }),
    )

    const replay = harness()
    const seed = harness()
    await grantSupportRequestParticipantAction(input, seed.client)
    const grantHash =
      seed.tx.supportRequestParticipant.create.mock.calls[0]?.[0]?.data.grantOperationHash
    expect(grantHash).toMatch(/^[0-9a-f]{64}$/)
    replay.tx.supportRequestParticipant.findFirst.mockResolvedValueOnce({
      id: 'participant_1',
      supportRequestId: 'request_1',
      userId: 'member_2',
      revokeOperationHash: expect.any(String),
    })
    // A mismatched persisted hash never discloses participant state.
    await expect(revokeSupportRequestParticipantAction(input, replay.client)).rejects.toMatchObject(
      { code: 'CONFLICT' },
    )
    expect(replay.tx.supportRequest.updateMany).not.toHaveBeenCalled()
  })

  it('converges a P2002 grant race only through exact actor-bound replay', async () => {
    const seed = harness()
    await grantSupportRequestParticipantAction(input, seed.client)
    const operationHash =
      seed.tx.supportRequestParticipant.create.mock.calls[0]?.[0]?.data.grantOperationHash
    const replay = harness()
    replay.tx.supportRequestParticipant.findFirst.mockResolvedValue({
      id: 'participant_1',
      supportRequestId: 'request_1',
      userId: 'member_2',
      grantOperationHash: operationHash,
      grantRequestVersion: 5,
      grantClientVersion: 3,
      grantActionAt: new Date('2030-01-01T00:00:00.000Z'),
      revokedAt: null,
    })
    const transaction = replay.rawClient.$transaction.getMockImplementation()!
    replay.rawClient.$transaction
      .mockRejectedValueOnce({ code: 'P2002' })
      .mockImplementation(transaction)
    await expect(grantSupportRequestParticipantAction(input, replay.client)).resolves.toMatchObject(
      {
        replayed: true,
        clientVersion: 3,
      },
    )
    expect(replay.tx.supportRequest.updateMany).not.toHaveBeenCalled()
    expect(replay.tx.supportRequestAuditEvent.create).not.toHaveBeenCalled()

    await expect(
      grantSupportRequestParticipantAction(
        { ...input, actor: { ...input.actor, actorId: 'other_requester' } },
        replay.client,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('replays durable produced versions and fails closed for legacy evidence', async () => {
    const seed = harness()
    await grantSupportRequestParticipantAction(input, seed.client)
    const operationHash =
      seed.tx.supportRequestParticipant.create.mock.calls[0]?.[0]?.data.grantOperationHash
    const replay = harness()
    replay.tx.supportRequest.findFirst.mockResolvedValueOnce({
      id: 'request_1',
      version: 99,
      clientVersion: 88,
      requesterUserId: 'requester_1',
    })
    replay.tx.supportRequestParticipant.findFirst.mockResolvedValueOnce({
      id: 'participant_1',
      supportRequestId: 'request_1',
      userId: 'member_2',
      grantOperationHash: operationHash,
      grantRequestVersion: 5,
      grantClientVersion: 3,
      grantActionAt: new Date('2030-01-01T00:00:00.000Z'),
      revokedAt: null,
    })
    await expect(grantSupportRequestParticipantAction(input, replay.client)).resolves.toMatchObject(
      {
        requestVersion: 5,
        clientVersion: 3,
        replayed: true,
      },
    )

    const legacy = harness()
    legacy.tx.supportRequestParticipant.findFirst.mockResolvedValueOnce({
      id: 'participant_1',
      supportRequestId: 'request_1',
      userId: 'member_2',
      grantOperationHash: operationHash,
      grantRequestVersion: null,
      grantClientVersion: null,
      grantActionAt: null,
      revokedAt: null,
    })
    await expect(grantSupportRequestParticipantAction(input, legacy.client)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('authorizes requester before replay but does not revalidate a later-deactivated target', async () => {
    const seed = harness()
    await grantSupportRequestParticipantAction(input, seed.client)
    const operationHash =
      seed.tx.supportRequestParticipant.create.mock.calls[0]?.[0]?.data.grantOperationHash
    const replay = harness()
    replay.tx.tenantMembership.findFirst.mockResolvedValueOnce(null)
    replay.tx.supportRequestParticipant.findFirst.mockResolvedValueOnce({
      id: 'participant_1',
      supportRequestId: 'request_1',
      userId: 'member_2',
      grantOperationHash: operationHash,
      grantRequestVersion: 5,
      grantClientVersion: 3,
      grantActionAt: new Date('2030-01-01T00:00:00.000Z'),
      revokedAt: new Date('2030-01-02T00:00:00.000Z'),
    })

    await expect(grantSupportRequestParticipantAction(input, replay.client)).resolves.toMatchObject(
      {
        active: true,
        requestVersion: 5,
        clientVersion: 3,
        replayed: true,
      },
    )
    expect(replay.tx.tenantMembership.findFirst).not.toHaveBeenCalled()
    expect(replay.tx.supportRequest.updateMany).not.toHaveBeenCalled()
  })
})
