import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  appendSupportMessageAction,
  createSupportRequestAction,
  SupportActionError,
} from './support-actions'

const now = new Date('2030-01-01T00:00:00.000Z')
const operationId = '00000000-0000-4000-8000-000000000001'
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
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  supportRequestId: 'request_1',
  authorKind: 'CLIENT',
  authorId: 'client_1',
  visibility: 'CLIENT_VISIBLE',
  body: 'Help',
  createdAt: now,
  attachments: [],
}

const clientActor = {
  actorType: 'HUMAN' as const,
  participantKind: 'CLIENT' as const,
  actorId: 'client_1',
  auditRole: 'STAFF',
}
const createInput = {
  operationId,
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  category: 'GENERAL' as const,
  subject: 'Help',
  body: 'Please help',
  attachments: [],
  actor: clientActor,
}
const appendInput = {
  operationId,
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  requestId: 'request_1',
  expectedVersion: 1,
  visibility: 'CLIENT_VISIBLE' as const,
  body: 'message',
  attachments: [],
  actor: clientActor,
}
function verifiedUpload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'upload_1',
    status: 'AWAITING_REVIEW',
    fileName: 'verified.pdf',
    mimeType: 'application/pdf',
    byteSize: 42,
    sha256: 'a'.repeat(64),
    verifiedAt: now,
    storageVersionId: 'storage-version',
    requestedBy: 'client_1',
    intakeRunId: 'run_1',
    intakeRun: {
      id: 'run_1',
      sourceKind: 'FILE_UPLOAD',
      status: 'AWAITING_REVIEW',
      evidence: [
        {
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          runId: 'run_1',
          sourceKind: 'FILE_UPLOAD',
          locator: 'intake-upload:upload_1',
          normalizedHash: 'a'.repeat(64),
        },
      ],
    },
    ...overrides,
  }
}

function harness() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue_1' }) },
    intakeUpload: { findMany: vi.fn().mockResolvedValue([]) },
    supportRequest: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue({ id: 'request_1', status: 'OPEN', version: 1 }),
      create: vi.fn().mockResolvedValue(request),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    supportMessage: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(message),
    },
    supportRequestAuditEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'event_1' }),
    },
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
        operationId,
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
          operationId,
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
          operationId,
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
          operationId,
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
          operationId,
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

  it('replays an exact create without duplicate writes and rejects changed content', async () => {
    const first = harness()
    await createSupportRequestAction(createInput, first.actionClient)
    const inputHash = first.tx.supportMessage.create.mock.calls[0]?.[0]?.data.submissionInputHash
    const replay = harness()
    replay.tx.supportMessage.findFirst.mockResolvedValue({
      ...message,
      body: createInput.body,
      submissionRequestId: operationId,
      submissionInputHash: inputHash,
      attachments: [],
      supportRequest: request,
    })
    await expect(
      createSupportRequestAction(createInput, replay.actionClient),
    ).resolves.toMatchObject({
      replayed: true,
    })
    expect(replay.tx.supportRequest.create).not.toHaveBeenCalled()
    expect(replay.tx.supportRequestAuditEvent.create).not.toHaveBeenCalled()
    await expect(
      createSupportRequestAction({ ...createInput, body: 'changed' }, replay.actionClient),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('replays an exact append at its original version without a second CAS or audit', async () => {
    const first = harness()
    await appendSupportMessageAction(appendInput, first.actionClient)
    const inputHash = first.tx.supportMessage.create.mock.calls[0]?.[0]?.data.submissionInputHash
    const replay = harness()
    replay.tx.supportMessage.findFirst.mockResolvedValue({
      ...message,
      body: appendInput.body,
      submissionRequestId: operationId,
      submissionInputHash: inputHash,
      attachments: [],
    })
    await expect(
      appendSupportMessageAction(appendInput, replay.actionClient),
    ).resolves.toMatchObject({
      requestVersion: 2,
      replayed: true,
    })
    expect(replay.tx.supportRequest.updateMany).not.toHaveBeenCalled()
    expect(replay.tx.supportRequestAuditEvent.create).not.toHaveBeenCalled()
    await expect(
      appendSupportMessageAction(
        { ...appendInput, actor: { ...clientActor, actorId: 'other' } },
        replay.actionClient,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it.each(['create', 'append'] as const)(
    'converges a P2002 %s race through an exact durable replay',
    async (kind) => {
      const seed = harness()
      if (kind === 'create') await createSupportRequestAction(createInput, seed.actionClient)
      else await appendSupportMessageAction(appendInput, seed.actionClient)
      const inputHash = seed.tx.supportMessage.create.mock.calls[0]?.[0]?.data.submissionInputHash
      const replay = harness()
      replay.tx.supportMessage.findFirst.mockResolvedValue(
        kind === 'create'
          ? {
              ...message,
              body: createInput.body,
              submissionRequestId: operationId,
              submissionInputHash: inputHash,
              attachments: [],
              supportRequest: request,
            }
          : {
              ...message,
              body: appendInput.body,
              submissionRequestId: operationId,
              submissionInputHash: inputHash,
              attachments: [],
            },
      )
      const originalTransaction = replay.client.$transaction.getMockImplementation()!
      replay.client.$transaction
        .mockRejectedValueOnce({ code: 'P2002' })
        .mockImplementation(originalTransaction)
      const result =
        kind === 'create'
          ? await createSupportRequestAction(createInput, replay.actionClient)
          : await appendSupportMessageAction(appendInput, replay.actionClient)
      expect(result.replayed).toBe(true)
      expect(replay.tx.supportMessage.create).not.toHaveBeenCalled()
      expect(replay.tx.supportRequestAuditEvent.create).not.toHaveBeenCalled()
    },
  )

  it('maps a P2002 followed by a mismatched durable identity to CONFLICT', async () => {
    const replay = harness()
    replay.tx.supportMessage.findFirst.mockResolvedValue({
      ...message,
      submissionRequestId: operationId,
      submissionInputHash: 'f'.repeat(64),
      attachments: [],
      supportRequest: request,
    })
    const originalTransaction = replay.client.$transaction.getMockImplementation()!
    replay.client.$transaction
      .mockRejectedValueOnce({ code: 'P2002' })
      .mockImplementation(originalTransaction)
    await expect(
      createSupportRequestAction(createInput, replay.actionClient),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(replay.tx.supportRequest.create).not.toHaveBeenCalled()
  })

  it('derives attachment metadata only from requester-owned exact verified evidence', async () => {
    const { tx, actionClient } = harness()
    tx.intakeUpload.findMany.mockResolvedValue([verifiedUpload()])
    await createSupportRequestAction(
      { ...createInput, attachments: [{ intakeUploadId: 'upload_1' }] },
      actionClient,
    )
    expect(tx.intakeUpload.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          requestedBy: 'client_1',
          verifiedAt: { not: null },
          storageVersionId: { not: null },
        }),
      }),
    )
    expect(tx.supportMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attachments: {
            create: [
              expect.objectContaining({
                filename: 'verified.pdf',
                mediaType: 'application/pdf',
                byteSize: 42n,
                intakeUploadId: 'upload_1',
              }),
            ],
          },
        }),
      }),
    )
    expect(
      tx.supportMessage.create.mock.calls[0]?.[0]?.data.attachments.create[0],
    ).not.toHaveProperty('sourceId')
    expect(
      JSON.stringify(tx.auditLog.create.mock.calls, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('upload_1')
  })

  it('rejects a mixed valid and invalid attachment set atomically', async () => {
    const { tx, actionClient } = harness()
    tx.intakeUpload.findMany.mockResolvedValue([verifiedUpload()])
    await expect(
      createSupportRequestAction(
        {
          ...createInput,
          attachments: [{ intakeUploadId: 'upload_1' }, { intakeUploadId: 'upload_other_scope' }],
        },
        actionClient,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(tx.supportRequest.create).not.toHaveBeenCalled()
    expect(tx.supportMessage.create).not.toHaveBeenCalled()
  })

  it('does not constrain platform operators to the original requester', async () => {
    const { tx, actionClient } = harness()
    tx.intakeUpload.findMany.mockResolvedValue([verifiedUpload({ requestedBy: 'someone_else' })])
    await appendSupportMessageAction(
      {
        ...appendInput,
        attachments: [{ intakeUploadId: 'upload_1' }],
        actor: {
          actorType: 'HUMAN',
          participantKind: 'OPERATOR',
          actorId: 'operator_1',
          auditRole: 'PLATFORM_ADMIN',
        },
      },
      actionClient,
    )
    const where = tx.intakeUpload.findMany.mock.calls[0]?.[0]?.where
    expect(where).not.toHaveProperty('requestedBy')
  })

  it.each([
    ['reserved upload', { status: 'RESERVED' }],
    ['wrong upload MIME', { mimeType: 'text/plain' }],
    ['empty upload', { byteSize: 0 }],
    ['missing verified timestamp', { verifiedAt: null }],
    ['missing storage version', { storageVersionId: null }],
    ['wrong requester', { requestedBy: 'other_client' }],
    ['unlinked run', { intakeRunId: null, intakeRun: null }],
    ['wrong run status', { intakeRun: { ...verifiedUpload().intakeRun, status: 'COMPLETED' } }],
    ['wrong run source', { intakeRun: { ...verifiedUpload().intakeRun, sourceKind: 'WEBSITE' } }],
    [
      'duplicate evidence',
      {
        intakeRun: {
          ...verifiedUpload().intakeRun,
          evidence: [
            verifiedUpload().intakeRun.evidence[0],
            verifiedUpload().intakeRun.evidence[0],
          ],
        },
      },
    ],
    [
      'wrong locator',
      {
        intakeRun: {
          ...verifiedUpload().intakeRun,
          evidence: [{ ...verifiedUpload().intakeRun.evidence[0], locator: 'intake-upload:other' }],
        },
      },
    ],
    [
      'wrong evidence hash',
      {
        intakeRun: {
          ...verifiedUpload().intakeRun,
          evidence: [{ ...verifiedUpload().intakeRun.evidence[0], normalizedHash: 'b'.repeat(64) }],
        },
      },
    ],
    [
      'wrong evidence scope',
      {
        intakeRun: {
          ...verifiedUpload().intakeRun,
          evidence: [{ ...verifiedUpload().intakeRun.evidence[0], tenantId: 'tenant_other' }],
        },
      },
    ],
  ])('rejects %s before support mutation', async (_label, overrides) => {
    const { tx, actionClient } = harness()
    tx.intakeUpload.findMany.mockResolvedValue([verifiedUpload(overrides)])
    await expect(
      createSupportRequestAction(
        { ...createInput, attachments: [{ intakeUploadId: 'upload_1' }] },
        actionClient,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(tx.supportRequest.create).not.toHaveBeenCalled()
  })

  it('rejects malformed direct input before opening a transaction', async () => {
    const { client, actionClient } = harness()
    await expect(
      createSupportRequestAction({ ...createInput, actor: undefined } as never, actionClient),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })
})
