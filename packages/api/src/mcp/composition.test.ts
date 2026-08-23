import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  consumeApproval,
  createUpdate,
  buildPreview,
  listGaps,
  proposeCorrection,
  prepareCustomerAccess,
  publishEvent,
} = vi.hoisted(() => ({
  consumeApproval: vi.fn(),
  createUpdate: vi.fn(),
  buildPreview: vi.fn(),
  listGaps: vi.fn(),
  proposeCorrection: vi.fn(),
  prepareCustomerAccess: vi.fn(),
  publishEvent: vi.fn(),
}))

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  consumeApprovalGrantAction: consumeApproval,
  createOperationalUpdateAction: createUpdate,
  buildOperationalUpdatePreview: buildPreview,
  listConversationKnowledgeGaps: listGaps,
  proposeKnowledgeCorrectionAction: proposeCorrection,
  prepareCustomerAccessRequestAction: prepareCustomerAccess,
  publishOperationalEvent: publishEvent,
}))

import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'

import { createSafeOperationalMcpRegistry } from './composition'

const credential = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueIds: ['venue-1'],
  capabilities: ['packages:draft'],
} satisfies VerifiedMcpCredentialScope

describe('safe operational MCP composition', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('exposes the canonical catalog while unbound writes still fail closed', async () => {
    const registry = createSafeOperationalMcpRegistry({
      approvalGrant: {
        findFirst: vi.fn().mockResolvedValue({ id: 'grant-1', maxUses: 1, useCount: 0 }),
      },
    } as never)
    expect(registry.listTools().some((tool) => tool.name === 'pathfinder.read')).toBe(true)
    await expect(
      registry.callTool(
        'pathfinder.create_package_draft',
        {
          clientId: 'tenant-1',
          venueId: 'venue-1',
          title: 'Synthetic draft',
          changeRequest: 'Prepare a reviewable synthetic change.',
          sourceIds: [],
        },
        { credential, approvalGrantId: 'grant-1' },
      ),
    ).rejects.toMatchObject({
      code: 'MCP_ACTION_UNAVAILABLE',
    })
  })

  it('prepares an invitation approval item through canonical machine attribution without provider effects', async () => {
    prepareCustomerAccess.mockResolvedValue({
      request: {
        id: 'access-1',
        approvalRequestId: 'approval-1',
        status: 'AWAITING_APPROVAL',
        requestedRole: 'MEMBER',
      },
      replayed: false,
    })
    publishEvent.mockResolvedValue({ id: 'event-1' })
    const database = {
      agentWorker: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'worker-id-1',
          modelProvider: 'openai',
          modelName: 'gpt-test',
        }),
      },
      agentRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }) },
    }
    const registry = createSafeOperationalMcpRegistry(database as never)
    const accessCredential = {
      ...credential,
      capabilities: ['customer-access:prepare'],
    } satisfies VerifiedMcpCredentialScope

    const result = await registry.callTool(
      'torchiko.customer_access.prepare_invitation',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '22222222-2222-4222-8222-222222222222',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        supportRequestId: 'support-1',
        sourceSupportMessageId: 'message-1',
        emailAddress: 'new.member@example.com',
        requestedRole: 'MEMBER',
        reason: 'The active organization owner requested this teammate invitation.',
      },
      { credential: accessCredential },
    )

    expect(prepareCustomerAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        emailAddress: 'new.member@example.com',
        actor: expect.objectContaining({
          capability: 'customer-access:prepare',
          workerId: 'worker-id-1',
          credentialId: 'credential-1',
        }),
      }),
      database,
    )
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.customer-access-request',
      data: {
        status: 'AWAITING_APPROVAL',
        externalEffectsExecuted: false,
        invitationSent: false,
      },
    })
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventType: 'customer-access.approval-required',
          linkedObjectId: 'access-1',
        }),
      }),
    )
  })

  it('consumes an exact one-shot grant and uses the canonical machine-attributed draft action', async () => {
    const update = {
      id: 'update-1',
      status: 'DRAFT',
      isActive: false,
      startsAt: new Date('2030-01-01T10:00:00.000Z'),
      expiresAt: new Date('2030-01-01T12:00:00.000Z'),
    }
    consumeApproval.mockResolvedValue({
      replayed: false,
      consumption: { id: 'consumption-1', resultReference: null },
    })
    createUpdate.mockResolvedValue({
      update,
      preview: { lifecycle: 'DRAFT', guestVisibleNow: false },
    })
    const tx = {
      operationalUpdate: { findFirst: vi.fn() },
      approvalGrantConsumption: { update: vi.fn().mockResolvedValue({}) },
    }
    const database = {
      approvalGrant: {
        findFirst: vi.fn().mockResolvedValue({ id: 'grant-1', maxUses: 1, useCount: 0 }),
      },
      agentWorker: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'worker-id-1',
          workerKey: 'worker-1',
          modelProvider: 'openai',
          modelName: 'gpt-test',
        }),
      },
      agentRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }) },
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    }
    const registry = createSafeOperationalMcpRegistry(database as never)
    const machineCredential: VerifiedMcpCredentialScope = {
      ...credential,
      capabilities: ['updates:draft'],
    }
    const input = {
      clientId: 'tenant-1',
      venueId: 'venue-1',
      operationId: '8c5f9673-d43d-4e40-a01d-cf188431ab81',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      title: 'Synthetic closure draft',
      body: 'Review before publishing.',
      startsAt: '2030-01-01T10:00:00.000Z',
      expiresAt: '2030-01-01T12:00:00.000Z',
    }

    const result = await registry.callTool('pathfinder.create_update_draft', input, {
      credential: machineCredential,
      approvalGrantId: 'grant-1',
    })

    expect(consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalGrantId: 'grant-1',
        operationId: input.operationId,
        actionName: 'pathfinder.create_update_draft',
        capability: 'updates:draft',
        parameters: expect.objectContaining({
          updateType: 'GENERAL_NOTICE',
          severity: 'INFO',
          priority: 'NORMAL',
          title: input.title,
        }),
        actor: expect.objectContaining({
          type: 'AGENT',
          actorId: 'agent-1',
          agentRunId: 'run-1',
          workerId: 'worker-1',
          approvalGrantId: 'grant-1',
        }),
      }),
      expect.anything(),
    )
    expect(createUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        schedule: false,
        actor: expect.objectContaining({ type: 'AGENT', capability: 'updates:draft' }),
      }),
      expect.anything(),
    )
    expect(tx.approvalGrantConsumption.update).toHaveBeenCalledWith({
      where: { id: 'consumption-1' },
      data: { resultReference: 'OperationalUpdate:update-1' },
    })
    expect(result.structuredContent.data).toMatchObject({ id: 'update-1', replayed: false })
    expect(database.agentWorker.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          credentialId: 'credential-1',
          capabilities: { has: 'updates:draft' },
        }),
      }),
    )
    expect(database.agentRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ executionWorkerId: 'worker-id-1' }),
      }),
    )
  })

  it('returns only the canonical bounded visitor-gap projection through review scope', async () => {
    listGaps.mockResolvedValue([
      {
        id: '22222222-2222-4222-8222-222222222222',
        category: 'KNOWLEDGE_GAP',
        visitorQuestion: 'Where is the accessible entrance?',
        assistantAnswer: 'I do not have that information.',
      },
    ])
    const registry = createSafeOperationalMcpRegistry({} as never)
    const result = await registry.callTool(
      'torchiko.knowledge.list_gaps',
      { clientId: 'tenant-1', venueId: 'venue-1', limit: 5 },
      { credential: { ...credential, capabilities: ['conversations:review'] } },
    )

    expect(listGaps).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', venueId: 'venue-1', limit: 5 },
      expect.anything(),
    )
    expect(result.structuredContent.data).toMatchObject({
      items: [expect.objectContaining({ category: 'KNOWLEDGE_GAP' })],
    })
  })

  it('returns a coherent report lifecycle without content, raw sources, provider errors, or publication authority', async () => {
    const database = {
      weeklyReport: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'report-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          weekStart: new Date('2026-08-01T00:00:00.000Z'),
          weekEnd: new Date('2026-08-07T23:59:59.000Z'),
          title: 'Weekly evidence',
          status: 'DRAFT',
          updatedAt: new Date('2026-08-08T10:00:00.000Z'),
          generatedAt: new Date('2026-08-08T09:00:00.000Z'),
          publishedAt: null,
          answerCount: 7,
          sessionCount: 11,
          error: 'raw report error must stay private',
          createdAt: new Date('2026-08-08T08:00:00.000Z'),
        }),
      },
      venueReportConfiguration: {
        findFirst: vi.fn().mockResolvedValue({
          enabled: true,
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
          updatedBy: 'private-operator-id',
        }),
      },
      generationRequestDispatch: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'dispatch-1',
          requestId: '11111111-1111-4111-8111-111111111111',
          status: 'CONSUMED',
          attempts: 2,
          nextAttemptAt: new Date('2026-08-08T08:30:00.000Z'),
          lastError: 'raw dispatch error must stay private',
          consumedAt: new Date('2026-08-08T08:45:00.000Z'),
          createdAt: new Date('2026-08-08T08:00:00.000Z'),
          updatedAt: new Date('2026-08-08T08:45:00.000Z'),
        }),
      },
      jobRecord: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'job-1',
            jobName: 'weekly-report.process',
            status: 'COMPLETE',
            error: 'raw job error must stay private',
            attemptNumber: 2,
            maxAttempts: 3,
            failureDisposition: null,
            startedAt: new Date('2026-08-08T08:45:00.000Z'),
            completedAt: new Date('2026-08-08T09:00:00.000Z'),
            terminalAt: null,
            createdAt: new Date('2026-08-08T08:45:00.000Z'),
          },
        ]),
      },
      auditLog: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'audit-1',
            actorId: 'private-operator-id',
            actorRole: 'PLATFORM_ADMIN',
            action: 'admin.report.requested',
            createdAt: new Date('2026-08-08T08:00:00.000Z'),
          },
        ]),
      },
    }
    const registry = createSafeOperationalMcpRegistry(database as never)
    const result = await registry.callTool(
      'torchiko.reports.get_lifecycle',
      { clientId: 'tenant-1', venueId: 'venue-1', reportId: 'report-1' },
      { credential: { ...credential, capabilities: ['reports:read'] } },
    )

    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.weekly-report-lifecycle',
      data: {
        status: 'REVIEW',
        report: {
          sourceEvidence: {
            capturedAnswerCount: 7,
            publicSessionCount: 11,
            exactSourceArtifactsAvailable: false,
          },
          failurePresent: true,
        },
        generation: {
          dispatch: { state: 'CONSUMED', attempts: 2, failurePresent: true },
          jobs: { count: 1, latest: { status: 'COMPLETE', failurePresent: true } },
        },
        publication: {
          state: 'NOT_PUBLISHED',
          clientVisible: false,
          externalDelivery: 'NOT_MODELED',
        },
        boundaries: {
          reportContentIncluded: false,
          rawSourceArtifactsIncluded: false,
          rawProviderErrorsIncluded: false,
          generationAuthorized: false,
          publicationAuthorized: false,
        },
      },
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('raw report error')
    expect(serialized).not.toContain('raw dispatch error')
    expect(serialized).not.toContain('raw job error')
    expect(serialized).not.toContain('private-operator-id')
  })

  it('lets a verified knowledge worker prepare review evidence without changing canonical content', async () => {
    proposeCorrection.mockResolvedValue({
      proposal: { id: '11111111-1111-4111-8111-111111111111', status: 'PENDING_REVIEW' },
      replayed: false,
    })
    publishEvent.mockResolvedValue({})
    const database = {
      agentWorker: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'worker-id-1',
          modelProvider: 'provider-dark',
          modelName: 'deterministic-fixture',
        }),
      },
      agentRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }) },
    }
    const registry = createSafeOperationalMcpRegistry(database as never)
    const input = {
      clientId: 'tenant-1',
      venueId: 'venue-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      conversationInsightId: '22222222-2222-4222-8222-222222222222',
      correctionKind: 'RETRIEVAL_CORRECTION' as const,
      aiInference: 'The answer lacks trusted support.',
      proposedChange: 'Add a source-backed accessibility entry.',
      reason: 'The public question should be answerable.',
      confidence: 0.8,
    }
    const result = await registry.callTool('torchiko.knowledge.propose_correction', input, {
      credential: { ...credential, capabilities: ['knowledge:draft'] },
    })

    expect(database.agentWorker.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          credentialId: 'credential-1',
          capabilities: { has: 'knowledge:draft' },
        }),
      }),
    )
    expect(proposeCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        actor: expect.objectContaining({
          type: 'AGENT',
          capability: 'knowledge:draft',
          agentRunId: 'run-1',
        }),
      }),
      database,
    )
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventType: 'knowledge.proposal.created',
          actionRequired: true,
        }),
      }),
    )
    expect(result.structuredContent.data).toMatchObject({
      status: 'PENDING_REVIEW',
      canonicalKnowledgeChanged: false,
    })
  })
})
