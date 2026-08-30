import { describe, expect, it, vi } from 'vitest'

import {
  normalizeSupportMissingInformation,
  triageSupportRequestAction,
} from './support-triage-actions'

const actor = {
  actorType: 'HUMAN',
  participantKind: 'OPERATOR',
  actorId: 'operator_1',
  auditRole: 'PLATFORM_ADMIN',
} as const

const input = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  requestId: 'request_1',
  expectedVersion: 4,
  category: 'CONTENT_CORRECTION' as const,
  missingInformation: ['Current admission price', 'Effective date'],
  actor,
}

function harness() {
  const tx = {
    supportRequest: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'request_1',
        category: 'GENERAL',
        status: 'OPEN',
        missingInformation: [],
        version: 4,
        clientVersion: 6,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    supportRequestAuditEvent: { create: vi.fn().mockResolvedValue({ id: 'event_1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
  }
  return { tx, client, actionClient: client as never }
}

describe('structured support triage action', () => {
  it('uses exact scope and CAS, increments once, and writes both evidence ledgers atomically', async () => {
    const { tx, client, actionClient } = harness()
    await expect(triageSupportRequestAction(input, actionClient)).resolves.toMatchObject({
      id: 'request_1',
      category: 'CONTENT_CORRECTION',
      missingInformation: ['Current admission price', 'Effective date'],
      version: 5,
      clientVersion: 7,
      clientActivityAt: expect.any(Date),
    })
    expect(client.$transaction).toHaveBeenCalledOnce()
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
        version: 4,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
      data: {
        category: 'CONTENT_CORRECTION',
        missingInformation: ['Current admission price', 'Effective date'],
        version: 5,
        clientVersion: 7,
        clientActivityAt: expect.any(Date),
        updatedByKind: 'OPERATOR',
        updatedById: 'operator_1',
      },
    })
    expect(tx.supportRequestAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'TRIAGE_UPDATED',
          requestVersion: 5,
          fromStatus: null,
          toStatus: null,
        }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'support-request.triage-updated',
          beforeState: expect.not.objectContaining({ missingInformation: expect.anything() }),
          afterState: expect.objectContaining({
            statusChanged: false,
            messageSent: false,
            artifactsChanged: false,
            packageLifecycleChanged: false,
            executionTriggered: false,
          }),
        }),
      }),
    )
    expect(tx).not.toHaveProperty('supportMessage')
    expect(tx).not.toHaveProperty('venuePackage')
  })

  it('trims the list and rejects duplicate, empty, oversized, or over-count inputs', () => {
    expect(normalizeSupportMissingInformation(['  First item  ', 'Second item'])).toEqual([
      'First item',
      'Second item',
    ])
    expect(() => normalizeSupportMissingInformation(['same', ' same '])).toThrow('unique')
    expect(() => normalizeSupportMissingInformation(['   '])).toThrow('invalid')
    expect(() => normalizeSupportMissingInformation(['x'.repeat(501)])).toThrow('invalid')
    expect(() =>
      normalizeSupportMissingInformation(Array.from({ length: 31 }, (_, i) => `item ${i}`)),
    ).toThrow('at most 30')
  })

  it('rejects an invalid runtime category before opening a transaction', async () => {
    const { client, actionClient } = harness()
    await expect(
      triageSupportRequestAction({ ...input, category: 'ARBITRARY' as never }, actionClient),
    ).rejects.toThrow('category is invalid')
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('rejects non-human/non-operator actors before opening a transaction', async () => {
    for (const badActor of [
      { ...actor, actorType: 'AGENT' },
      { ...actor, participantKind: 'CLIENT' },
      { ...actor, actorId: ' ' },
    ]) {
      const { client, actionClient } = harness()
      await expect(
        triageSupportRequestAction({ ...input, actor: badActor as never }, actionClient),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(client.$transaction).not.toHaveBeenCalled()
    }
  })

  it('accepts only complete approval-bound machine lineage and attributes the visible triage change', async () => {
    const agentActor = {
      actorType: 'AGENT',
      participantKind: 'AGENT',
      actorId: 'agent_1',
      auditRole: 'AGENT',
      agentIdentityId: 'agent_1',
      agentRunId: 'run_1',
      workerId: 'worker_1',
      credentialId: 'credential_1',
      approvalGrantId: 'grant_1',
      capability: 'support:triage',
      modelProvider: 'openai',
      modelName: 'gpt-test',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
    } as const
    const { tx, actionClient } = harness()
    await triageSupportRequestAction({ ...input, actor: agentActor }, actionClient)
    expect(tx.supportRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ updatedByKind: 'AGENT' }) }),
    )
    expect(tx.supportRequestAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorKind: 'AGENT' }) }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'AGENT',
          agentIdentityId: 'agent_1',
          agentRunId: 'run_1',
          workerId: 'worker_1',
          credentialId: 'credential_1',
          approvalGrantId: 'grant_1',
          capability: 'support:triage',
        }),
      }),
    )
    const incomplete = harness()
    await expect(
      triageSupportRequestAction(
        { ...input, actor: { ...agentActor, approvalGrantId: '' } },
        incomplete.actionClient,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(incomplete.client.$transaction).not.toHaveBeenCalled()
  })

  it('fails closed for wrong scope, stale CAS, closed state, or audit failure', async () => {
    const missing = harness()
    missing.tx.supportRequest.findFirst.mockResolvedValueOnce(null)
    await expect(triageSupportRequestAction(input, missing.actionClient)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    const stale = harness()
    stale.tx.supportRequest.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(triageSupportRequestAction(input, stale.actionClient)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(stale.tx.supportRequestAuditEvent.create).not.toHaveBeenCalled()

    const closed = harness()
    closed.tx.supportRequest.findFirst.mockResolvedValueOnce({
      id: 'request_1',
      category: 'GENERAL',
      status: 'COMPLETED',
      missingInformation: [],
      version: 4,
    })
    await expect(triageSupportRequestAction(input, closed.actionClient)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(closed.tx.supportRequest.updateMany).not.toHaveBeenCalled()

    const auditFailure = harness()
    auditFailure.tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(triageSupportRequestAction(input, auditFailure.actionClient)).rejects.toThrow(
      'audit unavailable',
    )
  })
})
