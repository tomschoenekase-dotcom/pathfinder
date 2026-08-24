import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  consumeApproval,
  createUpdate,
  createSupport,
  transitionSupport,
  appendSupportMessage,
  createIntake,
  buildPreview,
  listGaps,
  proposeCorrection,
  prepareCustomerAccess,
  prepareLocationDraft,
  prepareSupportTriage,
  triageSupport,
  prepareSupportInformationRequest,
  requestSupportInformation,
  prepareSupportCompletion,
  completeSupport,
  readSupportFulfillment,
  prepareAgentImprovement,
  recordAgentImprovementValidation,
  publishEvent,
  assertVenueAi,
  requestReportDraft,
  enqueueReportKick,
  preparePackageApproval,
  approvePackage,
  preparePackageApplication,
  applyPackage,
} = vi.hoisted(() => ({
  consumeApproval: vi.fn(),
  createUpdate: vi.fn(),
  createSupport: vi.fn(),
  transitionSupport: vi.fn(),
  appendSupportMessage: vi.fn(),
  createIntake: vi.fn(),
  buildPreview: vi.fn(),
  listGaps: vi.fn(),
  proposeCorrection: vi.fn(),
  prepareCustomerAccess: vi.fn(),
  prepareLocationDraft: vi.fn(),
  prepareSupportTriage: vi.fn(),
  triageSupport: vi.fn(),
  prepareSupportInformationRequest: vi.fn(),
  requestSupportInformation: vi.fn(),
  prepareSupportCompletion: vi.fn(),
  completeSupport: vi.fn(),
  readSupportFulfillment: vi.fn(),
  prepareAgentImprovement: vi.fn(),
  recordAgentImprovementValidation: vi.fn(),
  publishEvent: vi.fn(),
  assertVenueAi: vi.fn(),
  requestReportDraft: vi.fn(),
  enqueueReportKick: vi.fn(),
  preparePackageApproval: vi.fn(),
  approvePackage: vi.fn(),
  preparePackageApplication: vi.fn(),
  applyPackage: vi.fn(),
}))

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  consumeApprovalGrantAction: consumeApproval,
  createOperationalUpdateAction: createUpdate,
  createSupportRequestAction: createSupport,
  transitionSupportRequestStatusAction: transitionSupport,
  appendSupportMessageAction: appendSupportMessage,
  createIntakeProposal: createIntake,
  buildOperationalUpdatePreview: buildPreview,
  listConversationKnowledgeGaps: listGaps,
  proposeKnowledgeCorrectionAction: proposeCorrection,
  prepareCustomerAccessRequestAction: prepareCustomerAccess,
  prepareLocationDraftProposalAction: prepareLocationDraft,
  prepareSupportTriageProposalAction: prepareSupportTriage,
  triageSupportRequestAction: triageSupport,
  prepareSupportInformationRequestProposalAction: prepareSupportInformationRequest,
  requestSupportInformationAction: requestSupportInformation,
  prepareSupportCompletionProposalAction: prepareSupportCompletion,
  completeSupportRequestAction: completeSupport,
  readSupportPackageFulfillment: readSupportFulfillment,
  prepareAgentImprovementProposalAction: prepareAgentImprovement,
  recordAgentImprovementValidationAction: recordAgentImprovementValidation,
  publishOperationalEvent: publishEvent,
  assertVenueAiAvailable: assertVenueAi,
}))

vi.mock('../lib/weekly-report-generation', () => ({
  requestWeeklyReportDraftAction: requestReportDraft,
}))

vi.mock('../lib/support-package-approval-actions', () => ({
  prepareSupportPackageApprovalProposalAction: preparePackageApproval,
}))

vi.mock('../lib/support-package-application-actions', () => ({
  prepareSupportPackageApplicationProposalAction: preparePackageApplication,
}))

vi.mock('../lib/venue-package-core', () => ({
  approveVenuePackageLifecycle: approvePackage,
  applyVenuePackageLifecycle: applyPackage,
}))

vi.mock('@pathfinder/jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/jobs')>()),
  enqueueGenerationDispatchKick: enqueueReportKick,
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
    readSupportFulfillment.mockResolvedValue({
      contractVersion: 1,
      linkedPackageCount: 0,
      packages: [],
      digest: 'b'.repeat(64),
    })
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

  it('prepares a typed location proposal without creating or activating venue content', async () => {
    prepareLocationDraft.mockResolvedValue({
      approvalRequest: { id: '33333333-3333-4333-8333-333333333333' },
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
    const locationCredential = {
      ...credential,
      capabilities: ['locations:propose'],
    } satisfies VerifiedMcpCredentialScope
    const result = await registry.callTool(
      'torchiko.locations.propose_draft',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '33333333-3333-4333-8333-333333333333',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        reason: 'The current public visitor map supports this anchor.',
        evidence: [{ type: 'PublicMap', id: 'map-1' }],
        draft: {
          stableKey: 'east-entrance',
          kind: 'ENTRANCE',
          displayName: 'East entrance',
          description: null,
          visibility: 'PUBLIC',
          floorId: null,
          parentLocationId: null,
          coordinates: null,
          mapAnchor: null,
          externalMapReference: null,
          accessibilityMetadata: {},
        },
      },
      { credential: locationCredential },
    )
    expect(prepareLocationDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        actor: expect.objectContaining({
          capability: 'locations:propose',
          credentialId: 'credential-1',
        }),
      }),
      database,
    )
    expect(database.agentRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['RUNNING', 'AWAITING_APPROVAL'] } }),
      }),
    )
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.location-draft-proposal',
      data: {
        approvalRequired: true,
        applicationRequiredAfterApproval: true,
        canonicalVenueContentChanged: false,
      },
    })
  })

  it('prepares exact-version support triage without changing request or client activity', async () => {
    prepareSupportTriage.mockResolvedValue({
      approvalRequest: { id: '44444444-4444-4444-8444-444444444444' },
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
    const triageCredential = {
      ...credential,
      capabilities: ['support:triage'],
    } satisfies VerifiedMcpCredentialScope
    const result = await registry.callTool(
      'pathfinder.propose_support_triage',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '44444444-4444-4444-8444-444444444444',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        requestId: 'support-1',
        expectedVersion: 3,
        category: 'CONTENT_CORRECTION',
        missingInformation: ['Current price', 'Effective date'],
        reason: 'The support request needs two exact facts before work can begin.',
        evidence: [{ type: 'SupportMessage', id: 'message-1' }],
      },
      { credential: triageCredential },
    )

    expect(prepareSupportTriage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: 'support-1',
        expectedVersion: 3,
        category: 'CONTENT_CORRECTION',
        missingInformation: ['Current price', 'Effective date'],
        actor: expect.objectContaining({
          capability: 'support:triage',
          workerId: 'worker-id-1',
          credentialId: 'credential-1',
        }),
      }),
      database,
    )
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.support-triage-proposal',
      data: {
        approvalRequired: true,
        separateApplicationRequired: true,
        supportRequestChanged: false,
        clientActivityChanged: false,
        customerContacted: false,
        executionAuthorized: false,
      },
    })
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventType: 'support-triage.proposal-created',
          linkedObjectId: '44444444-4444-4444-8444-444444444444',
        }),
      }),
    )
  })

  it('consumes exact one-shot authority and applies only the approved support triage fields', async () => {
    consumeApproval.mockResolvedValue({
      consumption: { id: 'consumption-1', resultReference: null },
      replayed: false,
    })
    triageSupport.mockResolvedValue({
      id: 'support-1',
      status: 'OPEN',
      category: 'CONTENT_CORRECTION',
      missingInformation: ['Current exhibit label photograph'],
      version: 4,
      clientVersion: 8,
    })
    const tx = {
      approvalGrantConsumption: { update: vi.fn().mockResolvedValue({ id: 'consumption-1' }) },
      supportRequest: { findFirst: vi.fn() },
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
      $transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
    }
    const triageCredential = {
      ...credential,
      capabilities: ['support:triage'],
    } satisfies VerifiedMcpCredentialScope
    const result = await createSafeOperationalMcpRegistry(database as never).callTool(
      'pathfinder.apply_support_triage',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '45444444-4444-4444-8444-444444444444',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        requestId: 'support-1',
        expectedVersion: 3,
        category: 'CONTENT_CORRECTION',
        missingInformation: ['Current exhibit label photograph'],
      },
      { credential: triageCredential, approvalGrantId: 'grant-1' },
    )
    expect(consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalGrantId: 'grant-1',
        actionName: 'pathfinder.apply_support_triage',
        capability: 'support:triage',
        parameters: {
          clientId: 'tenant-1',
          venueId: 'venue-1',
          requestId: 'support-1',
          expectedVersion: 3,
          category: 'CONTENT_CORRECTION',
          missingInformation: ['Current exhibit label photograph'],
        },
      }),
      expect.anything(),
    )
    expect(triageSupport).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'support-1',
        expectedVersion: 3,
        actor: expect.objectContaining({
          approvalGrantId: 'grant-1',
          capability: 'support:triage',
          workerId: 'worker-1',
        }),
      }),
      expect.anything(),
    )
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.support-triage-applied',
      data: {
        status: 'OPEN',
        version: 4,
        replayed: false,
        messageSent: false,
        customerContacted: false,
        participantGranted: false,
        lifecycleChanged: false,
        executionTriggered: false,
      },
    })
  })

  it('prepares an exact client information request without contact or state change', async () => {
    prepareSupportInformationRequest.mockResolvedValue({
      approvalRequest: { id: '46444444-4444-4444-8444-444444444444' },
      replayed: false,
    })
    publishEvent.mockResolvedValue({ id: 'event-1' })
    const database = {
      agentWorker: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'worker-id-1',
          workerKey: 'worker-1',
          modelProvider: 'openai',
          modelName: 'gpt-test',
        }),
      },
      agentRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }) },
    }
    const supportCredential = {
      ...credential,
      capabilities: ['support:request-information'],
    } satisfies VerifiedMcpCredentialScope
    const result = await createSafeOperationalMcpRegistry(database as never).callTool(
      'pathfinder.propose_support_information_request',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '46444444-4444-4444-8444-444444444444',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        requestId: 'support-1',
        expectedVersion: 3,
        fromStatus: 'IN_REVIEW',
        body: 'Please provide the current exhibit label photograph.',
        missingInformation: ['Current exhibit label photograph'],
        reason: 'The reviewed source does not contain the current label.',
        evidence: [{ type: 'SupportMessage', id: 'message-1' }],
      },
      { credential: supportCredential },
    )
    expect(prepareSupportInformationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'support-1',
        fromStatus: 'IN_REVIEW',
        actor: expect.objectContaining({
          capability: 'support:request-information',
          workerId: 'worker-1',
        }),
      }),
      database,
    )
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.support-information-request-proposal',
      data: {
        approvalRequired: true,
        supportRequestChanged: false,
        clientVisibleMessageCreated: false,
        customerContacted: false,
        externalDeliveryTriggered: false,
      },
    })
  })

  it('consumes exact one-shot authority with the canonical in-app support action', async () => {
    consumeApproval.mockResolvedValue({
      consumption: { id: 'consumption-1', resultReference: null },
      replayed: false,
    })
    requestSupportInformation.mockResolvedValue({
      message: { id: 'message-1' },
      status: 'WAITING_FOR_CLIENT',
      missingInformation: ['Current exhibit label photograph'],
      requestVersion: 4,
      clientVersion: 9,
      replayed: false,
    })
    const tx = {
      approvalGrantConsumption: { update: vi.fn().mockResolvedValue({ id: 'consumption-1' }) },
    }
    const database = {
      approvalGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'grant-1' }) },
      agentWorker: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'worker-id-1',
          workerKey: 'worker-1',
          modelProvider: 'openai',
          modelName: 'gpt-test',
        }),
      },
      agentRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }) },
      $transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
    }
    const supportCredential = {
      ...credential,
      capabilities: ['support:request-information'],
    } satisfies VerifiedMcpCredentialScope
    const result = await createSafeOperationalMcpRegistry(database as never).callTool(
      'pathfinder.apply_support_information_request',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '47444444-4444-4444-8444-444444444444',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        requestId: 'support-1',
        expectedVersion: 3,
        fromStatus: 'IN_REVIEW',
        body: 'Please provide the current exhibit label photograph.',
        missingInformation: ['Current exhibit label photograph'],
      },
      { credential: supportCredential, approvalGrantId: 'grant-1' },
    )
    expect(consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.apply_support_information_request',
        capability: 'support:request-information',
        parameters: expect.objectContaining({
          fromStatus: 'IN_REVIEW',
          toStatus: 'WAITING_FOR_CLIENT',
          body: 'Please provide the current exhibit label photograph.',
        }),
      }),
      expect.anything(),
    )
    expect(requestSupportInformation).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({
          approvalGrantId: 'grant-1',
          capability: 'support:request-information',
        }),
      }),
      expect.anything(),
    )
    expect(tx.approvalGrantConsumption.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          resultReference:
            'SupportMessage:message-1:SupportRequest:support-1:v4:WAITING_FOR_CLIENT',
        },
      }),
    )
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.support-information-request-applied',
      data: {
        status: 'WAITING_FOR_CLIENT',
        replayed: false,
        clientVisibleMessageCreated: true,
        customerContacted: true,
        externalDeliveryTriggered: false,
        participantChanged: false,
        triageChanged: false,
        packageLifecycleChanged: false,
      },
    })
  })

  it('prepares an exact support completion without contact or state change', async () => {
    prepareSupportCompletion.mockResolvedValue({
      approvalRequest: {
        id: '48444444-4444-4444-8444-444444444444',
        scopeSnapshot: {
          contractVersion: 2,
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          requestId: 'support-1',
          expectedVersion: 4,
          fromStatus: 'IN_REVIEW',
          toStatus: 'COMPLETED',
          body: 'Your requested venue update is complete.',
          missingInformationCount: 0,
          packageFulfillment: {
            contractVersion: 1,
            linkedPackageCount: 0,
            packages: [],
            digest: 'b'.repeat(64),
          },
          allLinkedPackagesApplied: true,
          supportRequestChanged: false,
          clientActivityChanged: false,
          clientVisibleMessageCreated: false,
          customerContacted: false,
          externalDeliveryTriggered: false,
          executionAuthorized: false,
        },
      },
      replayed: false,
    })
    publishEvent.mockResolvedValue({ id: 'event-1' })
    const database = {
      agentWorker: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'worker-id-1',
          workerKey: 'worker-1',
          modelProvider: 'openai',
          modelName: 'gpt-test',
        }),
      },
      agentRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }) },
    }
    const supportCredential = {
      ...credential,
      capabilities: ['support:complete'],
    } satisfies VerifiedMcpCredentialScope
    const result = await createSafeOperationalMcpRegistry(database as never).callTool(
      'pathfinder.propose_support_completion',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '48444444-4444-4444-8444-444444444444',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        requestId: 'support-1',
        expectedVersion: 4,
        fromStatus: 'IN_REVIEW',
        body: 'Your requested venue update is complete.',
        reason: 'The requested work passed review and no information remains unresolved.',
        evidence: [{ type: 'SupportRequest', id: 'support-1' }],
      },
      { credential: supportCredential },
    )
    expect(prepareSupportCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'support-1',
        fromStatus: 'IN_REVIEW',
        actor: expect.objectContaining({ capability: 'support:complete', workerId: 'worker-1' }),
      }),
      database,
    )
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.support-completion-proposal',
      data: {
        approvalRequired: true,
        supportRequestChanged: false,
        clientVisibleMessageCreated: false,
        customerContacted: false,
        externalDeliveryTriggered: false,
      },
    })
  })

  it('consumes exact one-shot authority with the canonical support completion action', async () => {
    consumeApproval.mockResolvedValue({
      consumption: { id: 'consumption-1', resultReference: null },
      replayed: false,
    })
    completeSupport.mockResolvedValue({
      message: { id: 'message-1' },
      status: 'COMPLETED',
      missingInformation: [],
      requestVersion: 5,
      clientVersion: 10,
      replayed: false,
    })
    const tx = {
      approvalGrantConsumption: { update: vi.fn().mockResolvedValue({ id: 'consumption-1' }) },
    }
    const database = {
      approvalGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'grant-1' }) },
      agentWorker: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'worker-id-1',
          workerKey: 'worker-1',
          modelProvider: 'openai',
          modelName: 'gpt-test',
        }),
      },
      agentRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }) },
      $transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
    }
    const supportCredential = {
      ...credential,
      capabilities: ['support:complete'],
    } satisfies VerifiedMcpCredentialScope
    const result = await createSafeOperationalMcpRegistry(database as never).callTool(
      'pathfinder.apply_support_completion',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '49444444-4444-4444-8444-444444444444',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        requestId: 'support-1',
        expectedVersion: 4,
        fromStatus: 'IN_REVIEW',
        body: 'Your requested venue update is complete.',
      },
      { credential: supportCredential, approvalGrantId: 'grant-1' },
    )
    expect(consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.apply_support_completion',
        capability: 'support:complete',
        parameters: expect.objectContaining({
          fromStatus: 'IN_REVIEW',
          toStatus: 'COMPLETED',
          body: 'Your requested venue update is complete.',
        }),
      }),
      expect.anything(),
    )
    expect(completeSupport).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({
          approvalGrantId: 'grant-1',
          capability: 'support:complete',
        }),
      }),
      expect.anything(),
    )
    expect(tx.approvalGrantConsumption.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          resultReference: 'SupportMessage:message-1:SupportRequest:support-1:v5:COMPLETED',
        },
      }),
    )
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.support-completion-applied',
      data: {
        status: 'COMPLETED',
        replayed: false,
        clientVisibleMessageCreated: true,
        customerContacted: true,
        externalDeliveryTriggered: false,
        participantChanged: false,
        triageChanged: false,
        packageLifecycleChanged: false,
      },
    })
  })

  it('prepares an outcome-backed improvement proposal without changing behavior or authority', async () => {
    prepareAgentImprovement.mockResolvedValue({
      id: 'proposal-1',
      approvalRequestId: 'approval-1',
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
    const improvementCredential = {
      ...credential,
      capabilities: ['agent-improvements:propose'],
    } satisfies VerifiedMcpCredentialScope

    const result = await registry.callTool(
      'torchiko.agent_improvements.propose',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '44444444-4444-4444-8444-444444444444',
        agentIdentityId: 'review-agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        targetAgentIdentityId: 'target-agent-1',
        outcomeObservationIds: ['outcome-1', 'outcome-2'],
        proposalKey: 'research-source-grounding',
        revision: 1,
        targetKind: 'RETRIEVAL',
        title: 'Ground research answers in current sources',
        hypothesis: 'Retrieval misses are causing unsupported recommendations.',
        proposedChange: 'Require current-source retrieval before each recommendation.',
        validationPlan: 'Replay affected cases and compare outcomes before any rollout.',
      },
      { credential: improvementCredential },
    )

    expect(prepareAgentImprovement).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentIdentityId: 'target-agent-1',
        actor: expect.objectContaining({
          agentIdentityId: 'review-agent-1',
          capability: 'agent-improvements:propose',
          credentialId: 'credential-1',
        }),
      }),
      database,
    )
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.agent-improvement-proposal',
      data: {
        approvalRequired: true,
        implementationRequiredAfterApproval: true,
        agentBehaviorChanged: false,
        agentAuthorityChanged: false,
      },
    })
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventType: 'agent-improvement.proposal-created',
          linkedObjectId: 'proposal-1',
        }),
      }),
    )
  })

  it('records approved before/after validation evidence without promoting the implementation', async () => {
    recordAgentImprovementValidation.mockResolvedValue({
      id: 'validation-1',
      proposalId: 'proposal-1',
      comparisonHash: '9'.repeat(64),
      replayed: false,
    })
    const database = {
      agentWorker: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'worker-id-1',
          modelProvider: 'openai',
          modelName: 'gpt-validator',
        }),
      },
      agentRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }) },
    }
    const registry = createSafeOperationalMcpRegistry(database as never)
    const validationCredential = {
      ...credential,
      capabilities: ['agent-improvements:validate'],
    } satisfies VerifiedMcpCredentialScope

    const result = await registry.callTool(
      'torchiko.agent_improvements.record_validation',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '55555555-5555-4555-8555-555555555555',
        agentIdentityId: 'validator-agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        proposalId: 'proposal-1',
        baselineEvalRunId: '11111111-1111-4111-8111-111111111111',
        candidateEvalRunId: '22222222-2222-4222-8222-222222222222',
        implementationKind: 'CODE_COMMIT',
        implementationRef: 'git:3e3d8a3',
        implementationVersion: '3e3d8a3',
        implementationHash: 'a'.repeat(64),
        changeDimensions: ['MODEL'],
      },
      { credential: validationCredential },
    )

    expect(recordAgentImprovementValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: 'proposal-1',
        actor: expect.objectContaining({
          capability: 'agent-improvements:validate',
          modelProvider: 'openai',
          modelName: 'gpt-validator',
        }),
      }),
      database,
    )
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.agent-improvement-validation',
      data: {
        validationEvidenceId: 'validation-1',
        agentBehaviorChanged: false,
        agentAuthorityChanged: false,
        promotionDecisionRecorded: false,
      },
    })
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

  it('creates only an internal support draft through exact machine and grant scope', async () => {
    consumeApproval.mockResolvedValue({
      replayed: false,
      consumption: { id: 'consumption-support', resultReference: null },
    })
    createSupport.mockResolvedValue({
      request: { id: 'support-1', status: 'DRAFT', category: 'GENERAL' },
      message: { id: 'message-1', visibility: 'INTERNAL_ONLY' },
      replayed: false,
    })
    const tx = {
      approvalGrantConsumption: { update: vi.fn().mockResolvedValue({}) },
    }
    const database = {
      approvalGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'grant-support' }) },
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
    const input = {
      clientId: 'tenant-1',
      venueId: 'venue-1',
      operationId: '1c5f9673-d43d-4e40-a01d-cf188431ab81',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      subject: 'Review visitor answer',
      body: 'Investigate internally. Do not contact the customer.',
      category: 'GENERAL' as const,
    }
    const result = await createSafeOperationalMcpRegistry(database as never).callTool(
      'pathfinder.create_support_draft',
      input,
      {
        credential: { ...credential, capabilities: ['support:draft'] },
        approvalGrantId: 'grant-support',
      },
    )
    expect(consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.create_support_draft',
        capability: 'support:draft',
        parameters: {
          clientId: 'tenant-1',
          venueId: 'venue-1',
          category: 'GENERAL',
          subject: input.subject,
          body: input.body,
        },
        actor: expect.objectContaining({
          agentRunId: 'run-1',
          workerId: 'worker-1',
          credentialId: 'credential-1',
          approvalGrantId: 'grant-support',
        }),
      }),
      expect.anything(),
    )
    expect(createSupport).toHaveBeenCalledWith(
      expect.objectContaining({
        draftOnly: true,
        attachments: [],
        actor: expect.objectContaining({
          capability: 'support:draft',
          approvalGrantId: 'grant-support',
        }),
      }),
      expect.anything(),
    )
    expect(tx.approvalGrantConsumption.update).toHaveBeenCalledWith({
      where: { id: 'consumption-support' },
      data: { resultReference: 'SupportRequest:support-1' },
    })
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.support-request-draft',
      data: {
        id: 'support-1',
        status: 'DRAFT',
        messageVisibility: 'INTERNAL_ONLY',
        replayed: false,
      },
    })
  })

  it('opens one internal support draft through exact approval without customer contact', async () => {
    consumeApproval.mockResolvedValue({
      replayed: false,
      consumption: { id: 'consumption-open', resultReference: null },
    })
    transitionSupport.mockResolvedValue({
      id: 'support-1',
      status: 'OPEN',
      version: 2,
      clientVersion: 1,
      statusChangedAt: new Date('2030-01-01T12:00:00.000Z'),
    })
    const tx = {
      approvalGrantConsumption: { update: vi.fn().mockResolvedValue({}) },
      supportRequest: { findFirst: vi.fn() },
    }
    const database = {
      approvalGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'grant-open' }) },
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
    const input = {
      clientId: 'tenant-1',
      venueId: 'venue-1',
      operationId: '3c5f9673-d43d-4e40-a01d-cf188431ab81',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      requestId: 'support-1',
      expectedVersion: 1,
    }
    const result = await createSafeOperationalMcpRegistry(database as never).callTool(
      'pathfinder.open_support_request',
      input,
      {
        credential: { ...credential, capabilities: ['support:open'] },
        approvalGrantId: 'grant-open',
      },
    )
    expect(consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.open_support_request',
        capability: 'support:open',
        parameters: {
          clientId: 'tenant-1',
          venueId: 'venue-1',
          requestId: 'support-1',
          expectedVersion: 1,
          fromStatus: 'DRAFT',
          toStatus: 'OPEN',
        },
      }),
      expect.anything(),
    )
    expect(transitionSupport).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'support-1',
        expectedVersion: 1,
        toStatus: 'OPEN',
        actor: expect.objectContaining({
          participantKind: 'AGENT',
          capability: 'support:open',
          approvalGrantId: 'grant-open',
        }),
      }),
      expect.anything(),
    )
    expect(tx.approvalGrantConsumption.update).toHaveBeenCalledWith({
      where: { id: 'consumption-open' },
      data: { resultReference: 'SupportRequest:support-1:OPEN' },
    })
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.support-request-opened',
      data: { id: 'support-1', status: 'OPEN', version: 2, replayed: false },
    })
    expect(result.structuredContent.summary).toContain('no participant was added')
  })

  it('adds one attachment-free internal support note through exact approval', async () => {
    consumeApproval.mockResolvedValue({
      replayed: false,
      consumption: { id: 'consumption-note', resultReference: null },
    })
    appendSupportMessage.mockResolvedValue({
      message: { id: 'message-note-1', visibility: 'INTERNAL_ONLY' },
      requestVersion: 3,
      clientVersion: 1,
      replayed: false,
    })
    const tx = { approvalGrantConsumption: { update: vi.fn().mockResolvedValue({}) } }
    const database = {
      approvalGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'grant-note' }) },
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
    const input = {
      clientId: 'tenant-1',
      venueId: 'venue-1',
      operationId: '4c5f9673-d43d-4e40-a01d-cf188431ab81',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      requestId: 'support-1',
      expectedVersion: 2,
      body: 'Internal diagnostic confirms the visitor-answer source was stale.',
    }
    const result = await createSafeOperationalMcpRegistry(database as never).callTool(
      'pathfinder.add_support_internal_note',
      input,
      {
        credential: { ...credential, capabilities: ['support:note'] },
        approvalGrantId: 'grant-note',
      },
    )
    expect(consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.add_support_internal_note',
        capability: 'support:note',
        parameters: {
          clientId: 'tenant-1',
          venueId: 'venue-1',
          requestId: 'support-1',
          expectedVersion: 2,
          visibility: 'INTERNAL_ONLY',
          body: input.body,
          attachmentCount: 0,
        },
      }),
      expect.anything(),
    )
    expect(appendSupportMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'support-1',
        expectedVersion: 2,
        visibility: 'INTERNAL_ONLY',
        attachments: [],
        actor: expect.objectContaining({
          participantKind: 'AGENT',
          capability: 'support:note',
          approvalGrantId: 'grant-note',
        }),
      }),
      expect.anything(),
    )
    expect(tx.approvalGrantConsumption.update).toHaveBeenCalledWith({
      where: { id: 'consumption-note' },
      data: { resultReference: 'SupportMessage:message-note-1:INTERNAL_ONLY' },
    })
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.support-internal-note-added',
      data: {
        messageId: 'message-note-1',
        requestId: 'support-1',
        visibility: 'INTERNAL_ONLY',
        requestVersion: 3,
        clientVersionUnchanged: true,
        replayed: false,
      },
    })
    expect(result.structuredContent.summary).toContain('no customer was contacted')
  })

  it('creates only a review-pending NOTES intake proposal through exact machine and grant scope', async () => {
    consumeApproval.mockResolvedValue({
      replayed: false,
      consumption: { id: 'consumption-intake', resultReference: null },
    })
    createIntake.mockResolvedValue({
      id: 'intake-1',
      venueId: 'venue-1',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      displayName: 'Optional notes',
      createdAt: new Date('2030-01-01T12:00:00.000Z'),
      autoApprove: false,
      autoApply: false,
      nextAction: 'REVIEW_PROPOSAL',
      replayed: false,
    })
    const tx = {
      venue: {},
      intakeRun: {},
      intakeEvidenceRecord: {},
      intakeRunEvent: {},
      venuePackage: {},
      intakePackageHandoff: {},
      auditLog: {},
      approvalGrantConsumption: { update: vi.fn().mockResolvedValue({}) },
    }
    const database = {
      approvalGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'grant-intake' }) },
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
    const input = {
      clientId: 'tenant-1',
      venueId: 'venue-1',
      operationId: '2c5f9673-d43d-4e40-a01d-cf188431ab81',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      notes: 'Use the accessible east entrance facts as onboarding source material.',
    }
    const result = await createSafeOperationalMcpRegistry(database as never).callTool(
      'pathfinder.create_intake_notes_proposal',
      input,
      {
        credential: { ...credential, capabilities: ['intake:draft'] },
        approvalGrantId: 'grant-intake',
      },
    )
    expect(consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.create_intake_notes_proposal',
        capability: 'intake:draft',
        parameters: {
          clientId: 'tenant-1',
          venueId: 'venue-1',
          kind: 'NOTES',
          notes: input.notes,
        },
        actor: expect.objectContaining({
          agentRunId: 'run-1',
          workerId: 'worker-1',
          approvalGrantId: 'grant-intake',
        }),
      }),
      expect.anything(),
    )
    expect(createIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: input.operationId,
        proposal: { kind: 'NOTES', notes: input.notes },
        actor: expect.objectContaining({
          type: 'AGENT',
          capability: 'intake:draft',
          approvalGrantId: 'grant-intake',
        }),
      }),
    )
    expect(tx.approvalGrantConsumption.update).toHaveBeenCalledWith({
      where: { id: 'consumption-intake' },
      data: { resultReference: 'IntakeRun:intake-1' },
    })
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.intake-notes-proposal',
      data: {
        id: 'intake-1',
        status: 'AWAITING_REVIEW',
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        nextAction: 'REVIEW_PROPOSAL',
        replayed: false,
      },
    })
  })

  it('requests only an internal weekly-report draft through AI admission and exact grant scope', async () => {
    consumeApproval.mockResolvedValue({
      replayed: false,
      consumption: { id: 'consumption-report', resultReference: null },
    })
    const tx = {
      approvalGrantConsumption: { update: vi.fn().mockResolvedValue({}) },
    }
    requestReportDraft.mockImplementation(async (_input, hooks) => {
      await hooks.authorize(tx)
      const result = {
        dispatchId: 'dispatch-report',
        reportId: 'report-1',
        requestId: '84444444-4444-4444-8444-444444444444',
        dispatchState: 'PENDING',
        replayed: false,
        enqueueAllowed: true,
      }
      await hooks.resolved(tx, result)
      return result
    })
    const database = {
      approvalGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'grant-report' }) },
      agentWorker: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'worker-id-1',
          workerKey: 'worker-1',
          modelProvider: 'openai',
          modelName: 'gpt-test',
        }),
      },
      agentRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }) },
    }
    const input = {
      clientId: 'tenant-1',
      venueId: 'venue-1',
      operationId: '84444444-4444-4444-8444-444444444444',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      weekStart: '2030-01-07T00:00:00.000Z',
      weekEnd: '2030-01-13T23:59:59.000Z',
      title: 'Weekly venue report',
    }
    const result = await createSafeOperationalMcpRegistry(database as never).callTool(
      'pathfinder.generate_weekly_report_draft',
      input,
      {
        credential: { ...credential, capabilities: ['reports:draft'] },
        approvalGrantId: 'grant-report',
      },
    )

    expect(assertVenueAi).toHaveBeenCalledWith(database, {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })
    expect(consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.generate_weekly_report_draft',
        capability: 'reports:draft',
        parameters: {
          clientId: 'tenant-1',
          venueId: 'venue-1',
          weekStart: input.weekStart,
          weekEnd: input.weekEnd,
          title: input.title,
        },
        actor: expect.objectContaining({
          agentRunId: 'run-1',
          workerId: 'worker-1',
          approvalGrantId: 'grant-report',
        }),
      }),
      expect.anything(),
    )
    expect(requestReportDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: input.operationId,
        actor: expect.objectContaining({
          id: 'agent-1',
          role: 'AGENT',
          lineage: expect.objectContaining({ capability: 'reports:draft' }),
        }),
      }),
      expect.anything(),
      database,
    )
    expect(tx.approvalGrantConsumption.update).toHaveBeenCalledWith({
      where: { id: 'consumption-report' },
      data: { resultReference: 'WeeklyReport:report-1' },
    })
    expect(enqueueReportKick).toHaveBeenCalledWith('dispatch-report')
    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.weekly-report-draft-request',
      data: {
        reportId: 'report-1',
        dispatchState: 'PENDING',
        nextAction: 'REVIEW_DRAFT',
        replayed: false,
      },
    })
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

  it('returns explicit bounded incident-control health without reasons, actors, or recovery authority', async () => {
    const now = new Date('2030-01-01T12:00:00.000Z')
    const database = {
      correspondenceProviderAccount: { findMany: vi.fn().mockResolvedValue([]) },
      billingAccount: { findUnique: vi.fn().mockResolvedValue(null) },
      agentWorker: { findMany: vi.fn().mockResolvedValue([]) },
      agentBridgeSession: { findMany: vi.fn().mockResolvedValue([]) },
      embeddingDispatch: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      embeddingWorkClaim: { findFirst: vi.fn().mockResolvedValue(null) },
      intakeUpload: { findFirst: vi.fn().mockResolvedValue(null) },
      intakeUploadVerificationReceipt: { findFirst: vi.fn().mockResolvedValue(null) },
      analyticsEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      dailyRollup: { findFirst: vi.fn().mockResolvedValue(null) },
      jobRecord: { findFirst: vi.fn().mockResolvedValue(null) },
      nativeVenueDeploymentRelease: { findFirst: vi.fn().mockResolvedValue(null) },
      aiUsageEvent: {
        findFirst: vi.fn().mockResolvedValueOnce({ createdAt: now }).mockResolvedValueOnce(null),
      },
      externalAccessCredential: { findMany: vi.fn().mockResolvedValue([]) },
      platformConfig: {
        findUnique: vi.fn().mockImplementation(({ where }: { where: { key: string } }) =>
          where.key === 'global-ai-control-v1'
            ? Promise.resolve({
                value: {
                  schemaVersion: 1,
                  paused: true,
                  reason: 'private global incident reason',
                },
                updatedAt: now,
                updatedBy: 'private-operator-id',
              })
            : Promise.resolve({
                value: {
                  schemaVersion: 1,
                  overrides: [
                    {
                      provider: 'anthropic',
                      reason: 'private provider incident reason',
                      expiresAt: '2030-01-01T13:00:00.000Z',
                    },
                  ],
                },
                updatedAt: now,
                updatedBy: 'private-operator-id',
              }),
        ),
      },
    }
    const registry = createSafeOperationalMcpRegistry(database as never)
    const result = await registry.callTool(
      'torchiko.integrations.health',
      { clientId: 'tenant-1', venueId: 'venue-1' },
      { credential: { ...credential, capabilities: ['integrations:read'] } },
    )

    expect(result.structuredContent).toMatchObject({
      kind: 'torchiko.integration-health',
      data: {
        schemaVersion: 'integration-health.v2',
        controlPlane: {
          globalAiAdmission: { state: 'PAUSED', admissionOpen: false },
          providerRouting: {
            state: 'DEGRADED',
            routingAvailable: true,
            activeExclusions: [{ provider: 'anthropic', expiresAt: '2030-01-01T13:00:00.000Z' }],
          },
          boundaries: {
            incidentReasonIncluded: false,
            operatorIdentityIncluded: false,
            rawProviderErrorsIncluded: false,
            mutationAuthorized: false,
            automaticRecoveryAuthorized: false,
          },
        },
        integrations: expect.arrayContaining([
          expect.objectContaining({ integration: 'GLOBAL_AI_ADMISSION', state: 'OFFLINE' }),
          expect.objectContaining({ integration: 'AI_PROVIDERS', state: 'OFFLINE' }),
        ]),
      },
    })
    expect(JSON.stringify(result)).not.toMatch(
      /private global incident reason|private provider incident reason|private-operator-id/u,
    )
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

  it('preserves founder approval and separate agent lineage for exact package approval', async () => {
    const packageUpdatedAt = new Date('2030-01-02T00:00:00.000Z')
    const snapshot = {
      packageId: 'package-1',
      payloadHash: 'a'.repeat(64),
      baseDigest: 'b'.repeat(64),
      warningDigest: 'c'.repeat(64),
      warningCodes: [],
      supportHandoff: {
        handoffId: 'handoff-1',
        supportRequestId: 'request-1',
        supportRequestVersion: 5,
      },
      evaluationEvidence: {
        exactPackageRunIds: ['77777777-7777-4777-8777-777777777777'],
        truncated: false,
        thresholdApplied: false,
      },
    }
    preparePackageApproval.mockResolvedValue({
      approvalRequest: { id: 'approval-request-1' },
      snapshot,
      replayed: false,
    })
    consumeApproval.mockResolvedValue({
      consumption: { id: 'consumption-1', resultReference: null },
      replayed: false,
    })
    approvePackage.mockResolvedValue({
      id: 'package-1',
      status: 'APPROVED',
      payloadHash: snapshot.payloadHash,
      baseDigest: snapshot.baseDigest,
      updatedAt: packageUpdatedAt,
    })
    publishEvent.mockResolvedValue({ id: 'event-1' })
    const tx = {
      approvalGrant: {
        findFirst: vi.fn().mockResolvedValue({
          approvalDecision: {
            decision: 'APPROVED',
            decidedByType: 'HUMAN',
            decidedById: 'founder-1',
          },
        }),
      },
      supportPackageHandoff: { findFirst: vi.fn().mockResolvedValue({ id: 'handoff-1' }) },
      agentAction: { create: vi.fn().mockResolvedValue({ id: 'action-1' }) },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'timeline-1' }) },
      approvalGrantConsumption: { update: vi.fn().mockResolvedValue({ id: 'consumption-1' }) },
    }
    const database = {
      agentWorker: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'worker-id-1',
          workerKey: 'worker-1',
          modelProvider: 'deterministic',
          modelName: 'fixture',
        }),
      },
      agentRun: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 'run-1', requestedOperation: 'support.package-approval' }),
      },
      approvalGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'grant-1' }) },
      $transaction: vi.fn(async (callback) => callback(tx)),
    }
    const registry = createSafeOperationalMcpRegistry(database as never)
    const scopedCredential: VerifiedMcpCredentialScope = {
      ...credential,
      capabilities: ['packages:approve'],
    }
    await registry.callTool(
      'pathfinder.propose_support_package_approval',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '66666666-6666-4666-8666-666666666666',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        packageId: 'package-1',
        expectedUpdatedAt: '2030-01-01T00:00:00.000Z',
        reason: 'The exact support-linked package is ready for founder review.',
      },
      { credential: scopedCredential },
    )
    expect(preparePackageApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        packageId: 'package-1',
        expectedUpdatedAt: new Date('2030-01-01T00:00:00.000Z'),
        actor: expect.objectContaining({ capability: 'packages:approve' }),
      }),
      database,
    )

    const result = await registry.callTool(
      'pathfinder.apply_support_package_approval',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '88888888-8888-4888-8888-888888888888',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        packageId: 'package-1',
        expectedUpdatedAt: '2030-01-01T00:00:00.000Z',
        payloadHash: snapshot.payloadHash,
        baseDigest: snapshot.baseDigest,
        warningDigest: snapshot.warningDigest,
        supportHandoff: snapshot.supportHandoff,
      },
      { credential: scopedCredential, approvalGrantId: 'grant-1' },
    )
    expect(consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.apply_support_package_approval',
        capability: 'packages:approve',
        actor: expect.objectContaining({ agentIdentityId: 'agent-1' }),
      }),
      expect.anything(),
    )
    expect(approvePackage).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'HUMAN', id: 'founder-1', role: 'PLATFORM_ADMIN' },
        command: expect.objectContaining({ id: 'package-1' }),
      }),
    )
    expect(tx.agentAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'AGENT',
          actorId: 'agent-1',
          actionName: 'torchiko.support.apply_package_approval',
        }),
      }),
    )
    expect(result.structuredContent.data).toMatchObject({
      packageStatus: 'APPROVED',
      packageApplied: false,
      packagePublished: false,
      supportRequestChanged: false,
    })
  })

  it('applies current content only under exact founder grant and agent lineage', async () => {
    const updatedAt = new Date('2030-01-02T00:00:01.000Z')
    const snapshot = {
      packageId: 'package-1',
      payloadHash: 'a'.repeat(64),
      baseDigest: 'b'.repeat(64),
      warningDigest: 'c'.repeat(64),
      approvedAt: '2030-01-01T00:00:00.000Z',
      approvedBy: 'founder-1',
      supportHandoff: {
        handoffId: 'handoff-1',
        supportRequestId: 'request-1',
        supportRequestVersion: 5,
      },
      warningCodes: [],
      evaluationEvidence: { exactPackageRunIds: [], truncated: false, thresholdApplied: false },
    }
    preparePackageApplication.mockResolvedValue({
      approvalRequest: { id: 'approval-request-1' },
      snapshot,
      replayed: false,
    })
    publishEvent.mockResolvedValue({ id: 'event-application-1' })
    consumeApproval.mockResolvedValue({
      consumption: { id: 'consumption-1', resultReference: null },
      replayed: false,
    })
    applyPackage.mockResolvedValue({
      id: 'package-1',
      status: 'APPLIED',
      payloadHash: snapshot.payloadHash,
      baseDigest: snapshot.baseDigest,
      approvedAt: new Date(snapshot.approvedAt),
      approvedBy: snapshot.approvedBy,
      updatedAt,
    })
    const tx = {
      approvalGrant: {
        findFirst: vi.fn().mockResolvedValue({
          approvalDecision: { decision: 'APPROVED', decidedByType: 'HUMAN' },
        }),
      },
      supportPackageHandoff: { findFirst: vi.fn().mockResolvedValue({ id: 'handoff-1' }) },
      agentAction: { create: vi.fn().mockResolvedValue({ id: 'action-1' }) },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'timeline-1' }) },
      approvalGrantConsumption: { update: vi.fn().mockResolvedValue({ id: 'consumption-1' }) },
    }
    const database = {
      agentWorker: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'worker-id-1',
          workerKey: 'worker-1',
          modelProvider: 'deterministic',
          modelName: 'fixture',
        }),
      },
      agentRun: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 'run-1', requestedOperation: 'support.package-application' }),
      },
      approvalGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'grant-1' }) },
      $transaction: vi.fn(async (callback) => callback(tx)),
    }
    const registry = createSafeOperationalMcpRegistry(database as never)
    const scopedCredential: VerifiedMcpCredentialScope = {
      ...credential,
      capabilities: ['packages:apply'],
    }
    await registry.callTool(
      'pathfinder.propose_support_package_application',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '77777777-7777-4777-8777-777777777777',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        packageId: 'package-1',
        expectedUpdatedAt: '2030-01-02T00:00:00.000Z',
        reason: 'The approved package is ready for founder application review.',
      },
      { credential: scopedCredential },
    )
    expect(preparePackageApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        packageId: 'package-1',
        actor: expect.objectContaining({ capability: 'packages:apply' }),
      }),
      database,
    )
    const result = await registry.callTool(
      'pathfinder.apply_support_package_application',
      {
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: '88888888-8888-4888-8888-888888888888',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        packageId: 'package-1',
        expectedUpdatedAt: '2030-01-02T00:00:00.000Z',
        payloadHash: snapshot.payloadHash,
        baseDigest: snapshot.baseDigest,
        warningDigest: snapshot.warningDigest,
        approvedAt: snapshot.approvedAt,
        approvedBy: snapshot.approvedBy,
        supportHandoff: snapshot.supportHandoff,
      },
      { credential: scopedCredential, approvalGrantId: 'grant-1' },
    )
    expect(consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'pathfinder.apply_support_package_application',
        capability: 'packages:apply',
        actor: expect.objectContaining({
          agentIdentityId: 'agent-1',
          approvalGrantId: 'grant-1',
        }),
      }),
      expect.anything(),
    )
    expect(applyPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ type: 'AGENT', capability: 'packages:apply' }),
        command: expect.objectContaining({ id: 'package-1' }),
      }),
    )
    expect(tx.agentAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionName: 'torchiko.support.apply_package_application',
          actorType: 'AGENT',
          actorId: 'agent-1',
        }),
      }),
    )
    expect(result.structuredContent.data).toMatchObject({
      packageStatus: 'APPLIED',
      currentContentMutated: true,
      visitorVisibleChangePossible: true,
      supportRequestChanged: false,
      supportCompletionTriggered: false,
      customerContacted: false,
      revertTriggered: false,
    })
  })
})
