import { beforeEach, describe, expect, it, vi } from 'vitest'

const audit = vi.hoisted(() => vi.fn())
vi.mock('./audit', () => ({ writeAuditLogStrict: audit }))

import {
  completeSupportRequestAction,
  requestSupportInformationAction,
  respondToSupportInformationAction,
} from './support-actions'
import { supportPackageFulfillmentDigest } from './support-package-fulfillment'

const operationId = '11111111-1111-4111-8111-111111111111'
const tenantId = 'tenant_1'
const venueId = 'venue_1'
const requestId = 'request_1'
const packageFreeFulfillment = {
  contractVersion: 1 as const,
  linkedPackageCount: 0,
  packages: [],
  digest: supportPackageFulfillmentDigest({
    contractVersion: 1,
    linkedPackageCount: 0,
    packages: [],
  }),
}

function harness(overrides: Record<string, unknown> = {}) {
  const request = {
    id: requestId,
    status: 'IN_REVIEW',
    missingInformation: [],
    version: 4,
    clientVersion: 3,
    createdByKind: 'CLIENT',
    requesterUserId: 'client_1',
    requesterMembership: { status: 'ACTIVE' },
    participants: [],
    ...overrides,
  }
  const message = {
    id: 'message_1',
    tenantId,
    venueId,
    supportRequestId: requestId,
    authorKind: 'OPERATOR',
    authorId: 'operator_1',
    visibility: 'CLIENT_VISIBLE',
    body: 'Please provide a current photo.',
    clientVersion: 4,
    createdAt: new Date('2026-08-12T12:00:00.000Z'),
    attachments: [],
  }
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    supportRequest: {
      findFirst: vi.fn().mockResolvedValue(request),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    supportMessage: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(message),
    },
    supportRequestAuditEvent: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
    supportPackageHandoff: { findMany: vi.fn().mockResolvedValue([]) },
    intakeUpload: { findMany: vi.fn().mockResolvedValue([]) },
  }
  const client = { $transaction: vi.fn(async (callback) => callback(tx)) }
  return { client, tx, request, message }
}

const operator = {
  actorType: 'HUMAN' as const,
  participantKind: 'OPERATOR' as const,
  actorId: 'operator_1',
  auditRole: 'PLATFORM_ADMIN' as const,
}
const clientActor = {
  actorType: 'HUMAN' as const,
  participantKind: 'CLIENT' as const,
  actorId: 'client_1',
  auditRole: 'STAFF' as const,
}

describe('manual Support loop actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    audit.mockResolvedValue(undefined)
  })

  it('atomically requests information with prompt, items, status, versions and audits', async () => {
    const h = harness()
    const result = await requestSupportInformationAction(
      {
        operationId,
        tenantId,
        venueId,
        requestId,
        expectedVersion: 4,
        body: 'Please provide a current photo.',
        missingInformation: ['Current photo'],
        actor: operator,
      },
      h.client as never,
    )
    expect(result).toMatchObject({
      status: 'WAITING_FOR_CLIENT',
      missingInformation: ['Current photo'],
      requestVersion: 5,
      clientVersion: 4,
      replayed: false,
    })
    expect(h.tx.supportRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'WAITING_FOR_CLIENT',
          missingInformation: ['Current photo'],
          version: 5,
          clientVersion: 4,
        }),
      }),
    )
    expect(h.tx.supportRequestAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'INFORMATION_REQUESTED',
          fromStatus: 'IN_REVIEW',
          toStatus: 'WAITING_FOR_CLIENT',
        }),
      }),
    )
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        afterState: expect.objectContaining({
          packageLifecycleChanged: false,
          executionTriggered: false,
        }),
      }),
      h.tx,
    )
  })

  it('accepts only fully attributed approved agent execution for the client-visible prompt', async () => {
    const h = harness({ missingInformation: ['Current photo'] })
    await requestSupportInformationAction(
      {
        operationId,
        tenantId,
        venueId,
        requestId,
        expectedVersion: 4,
        body: 'Please provide a current photo.',
        missingInformation: ['Current photo'],
        actor: {
          actorType: 'AGENT',
          participantKind: 'AGENT',
          actorId: 'agent_1',
          auditRole: 'AGENT',
          agentIdentityId: 'agent_1',
          agentRunId: 'run_1',
          workerId: 'worker_1',
          credentialId: 'credential_1',
          approvalGrantId: 'grant_1',
          capability: 'support:request-information',
          modelProvider: 'openai',
          modelName: 'gpt-test',
          idempotencyKey: operationId,
        },
      },
      h.client as never,
    )
    expect(h.tx.supportMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authorKind: 'AGENT', visibility: 'CLIENT_VISIBLE' }),
      }),
    )
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({
          type: 'AGENT',
          approvalGrantId: 'grant_1',
          capability: 'support:request-information',
        }),
        afterState: expect.objectContaining({
          customerContacted: true,
          externalDeliveryTriggered: false,
          participantChanged: false,
        }),
      }),
      h.tx,
    )

    await expect(
      requestSupportInformationAction(
        {
          operationId,
          tenantId,
          venueId,
          requestId,
          expectedVersion: 4,
          body: 'Please provide a current photo.',
          missingInformation: ['Current photo'],
          actor: {
            actorType: 'AGENT',
            participantKind: 'AGENT',
            actorId: 'agent_1',
            auditRole: 'AGENT',
            agentIdentityId: 'agent_1',
            agentRunId: 'run_1',
            workerId: 'worker_1',
            credentialId: 'credential_1',
            capability: 'support:request-information',
            idempotencyKey: operationId,
          } as never,
        },
        harness().client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('accepts an authorized client response and clears the checklist', async () => {
    const h = harness({
      status: 'WAITING_FOR_CLIENT',
      missingInformation: ['Current photo'],
    })
    h.message.authorKind = 'CLIENT'
    h.message.authorId = 'client_1'
    const result = await respondToSupportInformationAction(
      {
        operationId,
        tenantId,
        venueId,
        requestId,
        expectedClientVersion: 3,
        body: 'The photo is attached in intake.',
        attachments: [],
        actor: clientActor,
      },
      h.client as never,
    )
    expect(result).toMatchObject({
      status: 'IN_REVIEW',
      missingInformation: [],
      requestVersion: 5,
      clientVersion: 4,
    })
    expect(h.tx.supportRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clientVersion: 3, status: 'WAITING_FOR_CLIENT' }),
      }),
    )
  })

  it('authorizes the client before accepting an operation replay', async () => {
    const h = harness({
      status: 'WAITING_FOR_CLIENT',
      requesterMembership: { status: 'REMOVED' },
    })
    h.tx.supportMessage.findFirst.mockResolvedValue({
      ...h.message,
      submissionRequestId: operationId,
      submissionInputHash: 'irrelevant',
    })
    await expect(
      respondToSupportInformationAction(
        {
          operationId,
          tenantId,
          venueId,
          requestId,
          expectedClientVersion: 3,
          body: 'Details',
          attachments: [],
          actor: clientActor,
        },
        h.client as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(h.tx.supportMessage.findFirst).not.toHaveBeenCalled()
  })

  it('retains uploader ownership for requested-information attachments', async () => {
    const h = harness({ status: 'WAITING_FOR_CLIENT', missingInformation: ['Photo'] })
    h.tx.intakeUpload.findMany.mockResolvedValue([
      {
        id: 'upload_1',
        status: 'AWAITING_REVIEW',
        fileName: 'photo.png',
        mimeType: 'image/png',
        byteSize: 100,
        sha256: 'a'.repeat(64),
        verifiedAt: new Date(),
        storageVersionId: 'version_1',
        requestedBy: 'different_client',
        intakeRunId: 'run_1',
        intakeRun: {
          id: 'run_1',
          sourceKind: 'FILE_UPLOAD',
          status: 'AWAITING_REVIEW',
          evidence: [
            {
              tenantId,
              venueId,
              runId: 'run_1',
              sourceKind: 'FILE_UPLOAD',
              locator: 'intake-upload:upload_1',
              normalizedHash: 'a'.repeat(64),
            },
          ],
        },
      },
    ])
    await expect(
      respondToSupportInformationAction(
        {
          operationId,
          tenantId,
          venueId,
          requestId,
          expectedClientVersion: 3,
          body: 'Attached.',
          attachments: [{ intakeUploadId: 'upload_1' }],
          actor: clientActor,
        },
        h.client as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(h.tx.supportRequest.updateMany).not.toHaveBeenCalled()
  })

  it('manually completes only an open or reviewed request with no missing items', async () => {
    const h = harness()
    const result = await completeSupportRequestAction(
      {
        operationId,
        tenantId,
        venueId,
        requestId,
        expectedVersion: 4,
        body: 'This request is complete. No package was changed.',
        actor: operator,
      },
      h.client as never,
    )
    expect(result.status).toBe('COMPLETED')
    expect(h.tx.supportMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ visibility: 'CLIENT_VISIBLE', authorKind: 'OPERATOR' }),
      }),
    )

    const blocked = harness({ missingInformation: ['Current photo'] })
    await expect(
      completeSupportRequestAction(
        {
          operationId,
          tenantId,
          venueId,
          requestId,
          expectedVersion: 4,
          body: 'Complete',
          actor: operator,
        },
        blocked.client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(blocked.tx.supportRequest.updateMany).not.toHaveBeenCalled()
  })

  it('attributes approved agent completion and records customer contact truthfully', async () => {
    const h = harness()
    h.message.authorKind = 'AGENT'
    h.message.authorId = 'agent_1'
    const result = await completeSupportRequestAction(
      {
        operationId,
        tenantId,
        venueId,
        requestId,
        expectedVersion: 4,
        body: 'Your requested update is complete.',
        packageFulfillment: packageFreeFulfillment,
        actor: {
          actorType: 'AGENT',
          participantKind: 'AGENT',
          actorId: 'agent_1',
          auditRole: 'AGENT',
          agentIdentityId: 'agent_1',
          agentRunId: 'run_1',
          workerId: 'worker_1',
          credentialId: 'credential_1',
          approvalGrantId: 'grant_1',
          capability: 'support:complete',
          idempotencyKey: operationId,
        },
      },
      h.client as never,
    )
    expect(result.status).toBe('COMPLETED')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({
          type: 'AGENT',
          capability: 'support:complete',
          approvalGrantId: 'grant_1',
        }),
        afterState: expect.objectContaining({
          clientVisibleMessageCreated: true,
          customerContacted: true,
          externalDeliveryTriggered: false,
          packageLifecycleChanged: false,
          executionTriggered: false,
        }),
      }),
      h.tx,
    )
  })

  it('rolls back the action when strict audit fails', async () => {
    const h = harness()
    audit.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(
      requestSupportInformationAction(
        {
          operationId,
          tenantId,
          venueId,
          requestId,
          expectedVersion: 4,
          body: 'Please provide details.',
          missingInformation: ['Details'],
          actor: operator,
        },
        h.client as never,
      ),
    ).rejects.toThrow('audit unavailable')
    expect(h.client.$transaction).toHaveBeenCalledTimes(1)
  })

  it('re-runs authorization and the whole transaction after a unique-race rollback', async () => {
    const h = harness({ status: 'WAITING_FOR_CLIENT', missingInformation: ['Details'] })
    h.message.authorKind = 'CLIENT'
    h.message.authorId = 'client_1'
    h.tx.supportMessage.create
      .mockRejectedValueOnce({ code: 'P2002' })
      .mockResolvedValueOnce(h.message)

    const result = await respondToSupportInformationAction(
      {
        operationId,
        tenantId,
        venueId,
        requestId,
        expectedClientVersion: 3,
        body: 'Here are the details.',
        attachments: [],
        actor: clientActor,
      },
      h.client as never,
    )

    expect(result.replayed).toBe(false)
    expect(h.client.$transaction).toHaveBeenCalledTimes(2)
    expect(h.tx.supportRequest.findFirst).toHaveBeenCalledTimes(2)
  })

  it('replays the durable produced versions after a later global-only request change', async () => {
    const h = harness({ status: 'WAITING_FOR_CLIENT', missingInformation: ['Details'] })
    h.message.authorKind = 'CLIENT'
    h.message.authorId = 'client_1'

    const first = await respondToSupportInformationAction(
      {
        operationId,
        tenantId,
        venueId,
        requestId,
        expectedClientVersion: 3,
        body: 'Here are the details.',
        attachments: [],
        actor: clientActor,
      },
      h.client as never,
    )
    expect(first).toMatchObject({ requestVersion: 5, clientVersion: 4, replayed: false })
    const createdData = h.tx.supportMessage.create.mock.calls[0]![0].data
    expect(createdData.requestVersion).toBe(5)
    expect(createdData.createdAt).toEqual(
      h.tx.supportRequest.updateMany.mock.calls[0]![0].data.clientActivityAt,
    )

    h.tx.supportRequest.findFirst.mockResolvedValue({
      ...h.request,
      status: 'IN_REVIEW',
      missingInformation: [],
      version: 6,
      clientVersion: 4,
    })
    h.tx.supportMessage.findFirst.mockResolvedValue({
      ...h.message,
      submissionRequestId: operationId,
      submissionInputHash: createdData.submissionInputHash,
      requestVersion: 5,
      clientVersion: 4,
    })
    h.tx.supportRequest.updateMany.mockClear()
    h.tx.supportMessage.create.mockClear()
    h.tx.supportRequestAuditEvent.create.mockClear()
    audit.mockClear()

    const replay = await respondToSupportInformationAction(
      {
        operationId,
        tenantId,
        venueId,
        requestId,
        expectedClientVersion: 3,
        body: 'Here are the details.',
        attachments: [],
        actor: clientActor,
      },
      h.client as never,
    )
    expect(replay).toMatchObject({ requestVersion: 5, clientVersion: 4, replayed: true })
    expect(h.tx.supportRequest.updateMany).not.toHaveBeenCalled()
    expect(h.tx.supportMessage.create).not.toHaveBeenCalled()
    expect(h.tx.supportRequestAuditEvent.create).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()

    h.tx.supportMessage.findFirst.mockResolvedValue({
      ...h.message,
      submissionRequestId: operationId,
      submissionInputHash: createdData.submissionInputHash,
      requestVersion: null,
      clientVersion: 4,
    })
    await expect(
      respondToSupportInformationAction(
        {
          operationId,
          tenantId,
          venueId,
          requestId,
          expectedClientVersion: 3,
          body: 'Here are the details.',
          attachments: [],
          actor: clientActor,
        },
        h.client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
