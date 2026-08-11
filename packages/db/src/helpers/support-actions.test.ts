import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  appendSupportMessageAction,
  createSupportRequestAction,
  SupportActionError,
} from './support-actions'

const now = new Date('2030-01-01T00:00:00.000Z')
const request = {
  id: 'request_1',
  venueId: 'venue_1',
  category: 'GENERAL',
  status: 'OPEN',
  subject: 'Help',
  missingInformation: [],
  version: 1,
  statusChangedAt: now,
  createdAt: now,
  updatedAt: now,
}
const message = {
  id: 'message_1',
  authorKind: 'CLIENT',
  visibility: 'CLIENT_VISIBLE',
  body: 'Help',
  createdAt: now,
  attachments: [],
}

function harness() {
  const tx = {
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue_1' }) },
    supportRequest: {
      findFirst: vi.fn().mockResolvedValue({ id: 'request_1', status: 'OPEN', version: 1 }),
      create: vi.fn().mockResolvedValue(request),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    supportMessage: { create: vi.fn().mockResolvedValue(message) },
    supportRequestAuditEvent: { create: vi.fn().mockResolvedValue({ id: 'event_1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  return { tx, client, actionClient: client as never }
}

describe('support domain actions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates the request, first message, support event, and platform audit in one scoped transaction', async () => {
    const { tx, actionClient } = harness()
    await createSupportRequestAction(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        category: 'GENERAL',
        subject: 'Help',
        body: 'Please help',
        attachments: [],
        actor: {
          actorType: 'HUMAN',
          participantKind: 'CLIENT',
          actorId: 'client_1',
          auditRole: 'STAFF',
        },
      },
      actionClient,
    )
    expect(tx.venue.findFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { id: true },
    })
    expect(tx.supportRequest.create).toHaveBeenCalledOnce()
    expect(tx.supportMessage.create).toHaveBeenCalledOnce()
    expect(tx.supportRequestAuditEvent.create).toHaveBeenCalledOnce()
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })

  it('prevents a client adapter from spoofing an internal note before starting a transaction', async () => {
    const { client, actionClient } = harness()
    await expect(
      appendSupportMessageAction(
        {
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          requestId: 'request_1',
          expectedVersion: 1,
          visibility: 'INTERNAL_ONLY',
          body: 'hidden',
          attachments: [],
          actor: {
            actorType: 'HUMAN',
            participantKind: 'CLIENT',
            actorId: 'client_1',
            auditRole: 'STAFF',
          },
        },
        actionClient,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<SupportActionError>)
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it.each([
    [
      {
        actorType: 'HUMAN',
        participantKind: 'OPERATOR',
        actorId: 'operator_1',
        auditRole: 'PLATFORM_ADMIN',
      } as const,
      'INTERNAL_ONLY' as const,
      'INTERNAL_NOTE_ADDED',
    ],
    [
      {
        actorType: 'HUMAN',
        participantKind: 'OPERATOR',
        actorId: 'operator_1',
        auditRole: 'PLATFORM_ADMIN',
      } as const,
      'CLIENT_VISIBLE' as const,
      'OPERATOR_MESSAGE_ADDED',
    ],
    [
      {
        actorType: 'AGENT',
        participantKind: 'AGENT',
        actorId: 'agent_1',
        auditRole: 'AGENT',
      } as const,
      'INTERNAL_ONLY' as const,
      'AGENT_INTERNAL_NOTE_ADDED',
    ],
    [
      {
        actorType: 'AGENT',
        participantKind: 'AGENT',
        actorId: 'agent_1',
        auditRole: 'AGENT',
      } as const,
      'CLIENT_VISIBLE' as const,
      'AGENT_MESSAGE_ADDED',
    ],
  ])(
    'maps trusted actor and visibility to durable evidence',
    async (actor, visibility, eventType) => {
      const { tx, actionClient } = harness()
      await appendSupportMessageAction(
        {
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          requestId: 'request_1',
          expectedVersion: 1,
          visibility,
          body: 'message',
          attachments: [],
          actor,
        },
        actionClient,
      )
      expect(tx.supportMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            authorKind: actor.participantKind,
            authorId: actor.actorId,
            visibility,
          }),
        }),
      )
      expect(tx.supportRequestAuditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType, actorKind: actor.participantKind }),
        }),
      )
    },
  )

  it('binds lookup and CAS to tenant and venue and rejects stale versions', async () => {
    const { tx, actionClient } = harness()
    tx.supportRequest.findFirst.mockResolvedValueOnce({
      id: 'request_1',
      status: 'OPEN',
      version: 2,
    })
    await expect(
      appendSupportMessageAction(
        {
          tenantId: 'tenant_1',
          venueId: 'venue_other',
          requestId: 'request_1',
          expectedVersion: 1,
          visibility: 'CLIENT_VISIBLE',
          body: 'message',
          attachments: [],
          actor: {
            actorType: 'HUMAN',
            participantKind: 'CLIENT',
            actorId: 'client_1',
            auditRole: 'STAFF',
          },
        },
        actionClient,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.supportRequest.findFirst).toHaveBeenCalledWith({
      where: { id: 'request_1', tenantId: 'tenant_1', venueId: 'venue_other' },
      select: { id: true, status: true, version: true },
    })
    expect(tx.supportRequest.updateMany).not.toHaveBeenCalled()
  })

  it('fails the domain action when the coupled platform audit cannot persist', async () => {
    const { tx, actionClient } = harness()
    tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(
      appendSupportMessageAction(
        {
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          requestId: 'request_1',
          expectedVersion: 1,
          visibility: 'INTERNAL_ONLY',
          body: 'note',
          attachments: [],
          actor: {
            actorType: 'HUMAN',
            participantKind: 'OPERATOR',
            actorId: 'operator_1',
            auditRole: 'PLATFORM_ADMIN',
          },
        },
        actionClient,
      ),
    ).rejects.toThrow('audit unavailable')
    expect(tx.supportRequest.updateMany).toHaveBeenCalledOnce()
    expect(tx.supportMessage.create).toHaveBeenCalledOnce()
    expect(tx.supportRequestAuditEvent.create).toHaveBeenCalledOnce()
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })
})
