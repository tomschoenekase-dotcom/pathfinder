import { describe, expect, it, vi } from 'vitest'

import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'

import { createPathfinderMcpRegistry, type PathfinderMcpDomainActions } from './registry'

const credential: VerifiedMcpCredentialScope = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  venueIds: ['venue-1'],
  capabilities: [
    'resources:read',
    'content:read',
    'packages:draft',
    'packages:approve',
    'packages:apply',
    'packages:revert',
    'packages:reconcile',
    'evaluations:request',
    'questions:ask',
    'delegations:create',
    'accounts:read',
    'knowledge:read',
    'meetings:read',
    'meetings:process',
    'customer-access:prepare',
  ],
}

function actions(): PathfinderMcpDomainActions {
  const result = {
    kind: 'test',
    summary: 'Canonical action result',
    data: { id: 'result-1' },
  } as const
  return {
    verifyApprovalGrant: vi.fn().mockResolvedValue(undefined),
    proposeBillingAction: vi.fn().mockResolvedValue(result),
    read: vi.fn().mockResolvedValue(result),
    accountContext: vi.fn().mockResolvedValue(result),
    accountTimeline: vi.fn().mockResolvedValue(result),
    accountMeetings: vi.fn().mockResolvedValue(result),
    accountMeetingGet: vi.fn().mockResolvedValue(result),
    processMeeting: vi.fn().mockResolvedValue(result),
    accountCorrespondence: vi.fn().mockResolvedValue(result),
    knowledgeSearch: vi.fn().mockResolvedValue(result),
    knowledgeGet: vi.fn().mockResolvedValue(result),
    listKnowledgeGaps: vi.fn().mockResolvedValue(result),
    listGuestAnswerAttributions: vi.fn().mockResolvedValue(result),
    previewGuestAnswerAttributionAgreement: vi.fn().mockResolvedValue(result),
    proposeKnowledgeCorrection: vi.fn().mockResolvedValue(result),
    proposeLocationDraft: vi.fn().mockResolvedValue(result),
    proposeSupportTriage: vi.fn().mockResolvedValue(result),
    applySupportTriage: vi.fn().mockResolvedValue(result),
    proposeSupportInformationRequest: vi.fn().mockResolvedValue(result),
    applySupportInformationRequest: vi.fn().mockResolvedValue(result),
    proposeSupportCompletion: vi.fn().mockResolvedValue(result),
    applySupportCompletion: vi.fn().mockResolvedValue(result),
    proposeSupportPackageDraft: vi.fn().mockResolvedValue(result),
    applySupportPackageDraft: vi.fn().mockResolvedValue(result),
    proposeSupportPackageApproval: vi.fn().mockResolvedValue(result),
    applySupportPackageApproval: vi.fn().mockResolvedValue(result),
    proposeSupportPackageApplication: vi.fn().mockResolvedValue(result),
    applySupportPackageApplication: vi.fn().mockResolvedValue(result),
    proposeSupportPackageReversion: vi.fn().mockResolvedValue(result),
    applySupportPackageReversion: vi.fn().mockResolvedValue(result),
    proposeSupportPackageHandoffSupersession: vi.fn().mockResolvedValue(result),
    applySupportPackageHandoffSupersession: vi.fn().mockResolvedValue(result),
    proposeAgentImprovement: vi.fn().mockResolvedValue(result),
    recordAgentImprovementValidation: vi.fn().mockResolvedValue(result),
    prepareCustomerAccessInvitation: vi.fn().mockResolvedValue(result),
    integrationHealth: vi.fn().mockResolvedValue(result),
    reportLifecycle: vi.fn().mockResolvedValue(result),
    askOperator: vi.fn().mockResolvedValue(result),
    delegateSpecialist: vi.fn().mockResolvedValue(result),
    createPackageDraft: vi.fn().mockResolvedValue(result),
    createUpdateDraft: vi.fn().mockResolvedValue(result),
    createSupportDraft: vi.fn().mockResolvedValue(result),
    openSupportRequest: vi.fn().mockResolvedValue(result),
    addSupportInternalNote: vi.fn().mockResolvedValue(result),
    createIntakeNotesProposal: vi.fn().mockResolvedValue(result),
    generateWeeklyReportDraft: vi.fn().mockResolvedValue(result),
    requestEvaluation: vi.fn().mockResolvedValue(result),
  }
}

describe('PathFinder MCP server-side adapter registry', () => {
  it('exposes governed account and knowledge reads through the existing catalog', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain)
    const tools = registry.listTools().map((tool) => tool.name)
    expect(tools).toEqual(
      expect.arrayContaining([
        'torchiko.account.get_context',
        'torchiko.account.timeline',
        'torchiko.account.meetings',
        'torchiko.account.meeting_get',
        'torchiko.meeting.process',
        'torchiko.account.correspondence',
        'torchiko.knowledge.search',
        'torchiko.knowledge.get',
        'torchiko.quality.list_answer_attributions',
        'torchiko.quality.preview_answer_attribution_agreement',
        'torchiko.customer_access.prepare_invitation',
        'torchiko.integrations.health',
        'torchiko.reports.get_lifecycle',
      ]),
    )
    await registry.callTool(
      'torchiko.account.get_context',
      { clientId: 'client-1', organizationId: 'org-1', recentLimit: 8 },
      { credential },
    )
    await registry.callTool(
      'torchiko.account.timeline',
      { clientId: 'client-1', organizationId: 'org-1', limit: 20 },
      { credential },
    )
    await registry.callTool(
      'torchiko.account.meetings',
      { clientId: 'client-1', organizationId: 'org-1', limit: 20 },
      { credential },
    )
    await registry.callTool(
      'torchiko.account.meeting_get',
      { clientId: 'client-1', meetingId: 'meeting-1' },
      { credential },
    )
    await registry.callTool(
      'torchiko.account.correspondence',
      { clientId: 'client-1', organizationId: 'org-1', limit: 20 },
      { credential },
    )
    await registry.callTool(
      'torchiko.meeting.process',
      {
        clientId: 'client-1',
        venueId: 'venue-1',
        operationId: '11111111-1111-4111-8111-111111111111',
        meetingId: 'meeting-1',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        workerKey: 'worker-1',
        summary: 'Client confirmed the launch plan.',
        extractions: [{ type: 'DECISION', content: 'Launch on September 1.', structuredData: {} }],
      },
      { credential },
    )
    await registry.callTool(
      'torchiko.knowledge.search',
      { clientId: 'client-1', query: 'pricing decision', limit: 5 },
      { credential },
    )
    expect(domain.accountContext).toHaveBeenCalled()
    expect(domain.accountTimeline).toHaveBeenCalled()
    expect(domain.accountMeetings).toHaveBeenCalled()
    expect(domain.accountMeetingGet).toHaveBeenCalled()
    expect(domain.accountCorrespondence).toHaveBeenCalled()
    expect(domain.processMeeting).toHaveBeenCalled()
    expect(domain.knowledgeSearch).toHaveBeenCalled()
  })

  it('binds reviewed answer attribution reads to exact venue review scope', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain)
    const input = {
      clientId: 'client-1',
      venueId: 'venue-1',
      guestChatTurnId: '22222222-2222-4222-8222-222222222222',
      limit: 5,
    }

    await registry.callTool('torchiko.quality.list_answer_attributions', input, {
      credential: { ...credential, capabilities: ['conversations:review'] },
    })

    expect(domain.listGuestAnswerAttributions).toHaveBeenCalledWith(input, expect.anything())
    await expect(
      registry.callTool('torchiko.quality.list_answer_attributions', input, {
        credential: { ...credential, capabilities: [] },
      }),
    ).rejects.toThrow('Capability denied')
  })

  it('binds answer-attribution calibration to exact venue review scope', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain)
    const input = { clientId: 'client-1', venueId: 'venue-1', limit: 20 }

    await registry.callTool('torchiko.quality.preview_answer_attribution_agreement', input, {
      credential: { ...credential, capabilities: ['conversations:review'] },
    })

    expect(domain.previewGuestAnswerAttributionAgreement).toHaveBeenCalledWith(
      input,
      expect.anything(),
    )
    await expect(
      registry.callTool('torchiko.quality.preview_answer_attribution_agreement', input, {
        credential: { ...credential, capabilities: [] },
      }),
    ).rejects.toThrow('Capability denied')
  })

  it('admits provider-dark invitation preparation only with exact venue capability', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain)
    const arguments_ = {
      clientId: 'client-1',
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
    }

    await registry.callTool('torchiko.customer_access.prepare_invitation', arguments_, {
      credential,
    })
    expect(domain.prepareCustomerAccessInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ emailAddress: 'new.member@example.com', requestedRole: 'MEMBER' }),
      expect.objectContaining({ credential }),
    )
    expect(domain.verifyApprovalGrant).not.toHaveBeenCalled()

    await expect(
      registry.callTool('torchiko.customer_access.prepare_invitation', arguments_, {
        credential: { ...credential, capabilities: [] },
      }),
    ).rejects.toThrow('Capability denied')
  })

  it('denies company-brain reads for a different client before the action runs', async () => {
    const domain = actions()
    await expect(
      createPathfinderMcpRegistry(domain).callTool(
        'torchiko.knowledge.search',
        { clientId: 'client-2', query: 'pricing decision' },
        { credential },
      ),
    ).rejects.toThrow('Client scope denied')
    expect(domain.knowledgeSearch).not.toHaveBeenCalled()
  })

  it('requires reports:read and exact venue scope for the report lifecycle tool', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain)
    const input = { clientId: 'client-1', venueId: 'venue-1', reportId: 'report-1' }

    await registry.callTool('torchiko.reports.get_lifecycle', input, {
      credential: { ...credential, capabilities: ['reports:read'] },
    })
    expect(domain.reportLifecycle).toHaveBeenCalledWith(input, expect.anything())

    await expect(
      registry.callTool(
        'torchiko.reports.get_lifecycle',
        { ...input, venueId: 'venue-2' },
        { credential: { ...credential, capabilities: ['reports:read'] } },
      ),
    ).rejects.toThrow('Venue scope denied')
    await expect(
      registry.callTool('torchiko.reports.get_lifecycle', input, {
        credential: { ...credential, capabilities: [] },
      }),
    ).rejects.toThrow('Capability denied')
  })

  it('requires reports:draft, exact venue scope, and a verified grant for report generation', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain, { writeToolsEnabled: true })
    const input = {
      clientId: 'client-1',
      venueId: 'venue-1',
      operationId: '74444444-4444-4444-8444-444444444444',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      weekStart: '2030-01-07T00:00:00.000Z',
      weekEnd: '2030-01-13T23:59:59.000Z',
      title: 'Weekly venue report',
    }

    await registry.callTool('pathfinder.generate_weekly_report_draft', input, {
      credential: { ...credential, capabilities: ['reports:draft'] },
      approvalGrantId: 'grant-report',
    })
    expect(domain.verifyApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalGrantId: 'grant-report',
        toolName: 'pathfinder.generate_weekly_report_draft',
        capability: 'reports:draft',
      }),
      expect.anything(),
    )
    expect(domain.generateWeeklyReportDraft).toHaveBeenCalledWith(input, expect.anything())

    await expect(
      registry.callTool('pathfinder.generate_weekly_report_draft', input, {
        credential: { ...credential, capabilities: ['reports:draft'] },
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(
      registry.callTool('pathfinder.generate_weekly_report_draft', input, {
        credential: { ...credential, capabilities: [] },
        approvalGrantId: 'grant-report',
      }),
    ).rejects.toThrow('Capability denied')
  })

  it('denies cross-client and cross-venue reads before a canonical action is called', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain)
    await expect(
      registry.callTool(
        'pathfinder.read',
        {
          resource: 'content',
          clientId: 'client-2',
          venueId: 'venue-1',
          limit: 25,
        },
        { credential },
      ),
    ).rejects.toThrow('Client scope denied')
    await expect(
      registry.callTool(
        'pathfinder.read',
        {
          resource: 'content',
          clientId: 'client-1',
          venueId: 'venue-2',
          limit: 25,
        },
        { credential },
      ),
    ).rejects.toThrow('Venue scope denied')
    expect(domain.read).not.toHaveBeenCalled()
  })

  it('requires both the generic read grant and the resource-specific capability', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain)
    await expect(
      registry.callTool(
        'pathfinder.read',
        {
          resource: 'jobs',
          clientId: 'client-1',
          venueId: 'venue-1',
          limit: 25,
        },
        { credential },
      ),
    ).rejects.toThrow('Capability denied')
    expect(domain.read).not.toHaveBeenCalled()
  })

  it('requires an explicit capability for expanded operational intelligence', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain)
    await expect(
      registry.callTool(
        'pathfinder.read',
        {
          resource: 'readiness',
          clientId: 'client-1',
          venueId: 'venue-1',
          limit: 25,
        },
        { credential },
      ),
    ).rejects.toThrow('Capability denied')
    await expect(
      registry.callTool(
        'pathfinder.read',
        {
          resource: 'reports',
          clientId: 'client-1',
          venueId: 'venue-1',
          limit: 25,
        },
        { credential },
      ),
    ).rejects.toThrow('Capability denied')
    await expect(
      registry.callTool(
        'pathfinder.read',
        {
          resource: 'agent-run-trace',
          clientId: 'client-1',
          venueId: 'venue-1',
          agentRunId: 'run-1',
          limit: 25,
        },
        { credential },
      ),
    ).rejects.toThrow('Capability denied')
    expect(domain.read).not.toHaveBeenCalled()
  })

  it('admits readiness only with both exact venue scope and readiness capability', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain)
    const readinessCredential: VerifiedMcpCredentialScope = {
      ...credential,
      clientId: 'client-1',
      capabilities: ['resources:read', 'readiness:read'],
    }
    const input = {
      resource: 'readiness' as const,
      clientId: 'client-1',
      venueId: 'venue-1',
      limit: 25,
    }
    await registry.callTool('pathfinder.read', input, { credential: readinessCredential })
    expect(domain.read).toHaveBeenCalledWith(input, expect.anything())

    vi.mocked(domain.read).mockClear()
    await expect(
      registry.callTool(
        'pathfinder.read',
        { ...input, venueId: 'venue-2' },
        { credential: readinessCredential },
      ),
    ).rejects.toThrow('Venue scope denied')
    expect(domain.read).not.toHaveBeenCalled()
  })

  it('keeps every draft/evaluation action default-off and approval-gated', async () => {
    const input = {
      clientId: 'client-1',
      venueId: 'venue-1',
      title: 'Correct a fact',
      changeRequest: 'Prepare a reviewable correction.',
      sourceIds: [],
    }
    await expect(
      createPathfinderMcpRegistry(actions()).callTool('pathfinder.create_package_draft', input, {
        credential,
        approvalGrantId: 'approval-1',
      }),
    ).rejects.toMatchObject({ code: 'WRITE_TOOLS_DISABLED' })
    await expect(
      createPathfinderMcpRegistry(actions(), { writeToolsEnabled: true }).callTool(
        'pathfinder.create_package_draft',
        input,
        { credential },
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
  })

  it('routes package-draft proposals without a grant and verifies application before dispatch', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain, { writeToolsEnabled: true })
    const exact = {
      clientId: 'client-1',
      venueId: 'venue-1',
      operationId: '44444444-4444-4444-8444-444444444444',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      requestId: 'request-1',
      expectedVersion: 4,
      fromStatus: 'IN_REVIEW' as const,
      draftKey: '55555555-5555-4555-8555-555555555555',
      payload: {
        schemaVersion: 3,
        venue: { identity: { name: 'Reviewed venue name' } },
        places: { create: [], update: [], delete: [] },
        knowledgeEntries: { create: [], update: [], delete: [] },
      },
      operationCounts: {
        venuePatch: true,
        placeCreates: 0,
        placeUpdates: 0,
        placeDeletes: 0,
        knowledgeCreates: 0,
        knowledgeUpdates: 0,
        knowledgeDeletes: 0,
        total: 1,
      },
    }
    await registry.callTool(
      'pathfinder.propose_support_package_draft',
      { ...exact, reason: 'The exact reviewed change is ready for one package draft.' },
      { credential },
    )
    expect(domain.proposeSupportPackageDraft).toHaveBeenCalledOnce()
    expect(domain.verifyApprovalGrant).not.toHaveBeenCalled()

    await registry.callTool('pathfinder.apply_support_package_draft', exact, {
      credential,
      approvalGrantId: 'grant-package-1',
    })
    expect(domain.verifyApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalGrantId: 'grant-package-1',
        toolName: 'pathfinder.apply_support_package_draft',
        capability: 'packages:draft',
        clientId: 'client-1',
        venueId: 'venue-1',
      }),
      expect.objectContaining({ credential }),
    )
    expect(domain.applySupportPackageDraft).toHaveBeenCalledOnce()
  })

  it('routes package-approval proposals without a grant and verifies exact execution authority', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain, { writeToolsEnabled: true })
    const common = {
      clientId: 'client-1',
      venueId: 'venue-1',
      operationId: '66666666-6666-4666-8666-666666666666',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      packageId: 'package-1',
      expectedUpdatedAt: '2030-01-01T00:00:00.000Z',
    }
    await registry.callTool(
      'pathfinder.propose_support_package_approval',
      { ...common, reason: 'The exact package is ready for founder approval.' },
      { credential },
    )
    expect(domain.proposeSupportPackageApproval).toHaveBeenCalledOnce()
    expect(domain.verifyApprovalGrant).not.toHaveBeenCalled()

    await registry.callTool(
      'pathfinder.apply_support_package_approval',
      {
        ...common,
        payloadHash: 'a'.repeat(64),
        baseDigest: 'b'.repeat(64),
        warningDigest: 'c'.repeat(64),
        supportHandoff: {
          handoffId: 'handoff-1',
          supportRequestId: 'request-1',
          supportRequestVersion: 5,
        },
      },
      { credential, approvalGrantId: 'grant-package-approval-1' },
    )
    expect(domain.verifyApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalGrantId: 'grant-package-approval-1',
        toolName: 'pathfinder.apply_support_package_approval',
        capability: 'packages:approve',
        clientId: 'client-1',
        venueId: 'venue-1',
      }),
      expect.objectContaining({ credential }),
    )
    expect(domain.applySupportPackageApproval).toHaveBeenCalledOnce()
  })

  it('routes package-application proposals inertly and verifies exact execution authority', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain, { writeToolsEnabled: true })
    const common = {
      clientId: 'client-1',
      venueId: 'venue-1',
      operationId: '88888888-8888-4888-8888-888888888888',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      packageId: 'package-1',
      expectedUpdatedAt: '2030-01-02T00:00:00.000Z',
    }
    await registry.callTool(
      'pathfinder.propose_support_package_application',
      { ...common, reason: 'The approved package is ready for founder application review.' },
      { credential },
    )
    expect(domain.proposeSupportPackageApplication).toHaveBeenCalledOnce()
    expect(domain.verifyApprovalGrant).not.toHaveBeenCalled()
    await registry.callTool(
      'pathfinder.apply_support_package_application',
      {
        ...common,
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
      },
      { credential, approvalGrantId: 'grant-package-application-1' },
    )
    expect(domain.verifyApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalGrantId: 'grant-package-application-1',
        toolName: 'pathfinder.apply_support_package_application',
        capability: 'packages:apply',
        clientId: 'client-1',
        venueId: 'venue-1',
      }),
      expect.objectContaining({ credential }),
    )
    expect(domain.applySupportPackageApplication).toHaveBeenCalledOnce()
  })

  it('routes package-reversion proposals inertly and requires packages:revert execution authority', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain, { writeToolsEnabled: true })
    const common = {
      clientId: 'client-1',
      venueId: 'venue-1',
      operationId: '99999999-9999-4999-8999-999999999999',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      packageId: 'package-1',
      expectedUpdatedAt: '2030-01-02T00:00:00.000Z',
    }
    await registry.callTool(
      'pathfinder.propose_support_package_reversion',
      { ...common, reason: 'The applied package needs exact founder rollback review.' },
      { credential },
    )
    expect(domain.proposeSupportPackageReversion).toHaveBeenCalledOnce()
    expect(domain.verifyApprovalGrant).not.toHaveBeenCalled()
    await registry.callTool(
      'pathfinder.apply_support_package_reversion',
      {
        ...common,
        payloadHash: 'a'.repeat(64),
        baseDigest: 'b'.repeat(64),
        rollbackManifestDigest: 'c'.repeat(64),
        appliedAt: '2030-01-01T00:00:00.000Z',
        appliedBy: 'agent-application-1',
        appliedCommandKey: '88888888-8888-4888-8888-888888888888',
        supportHandoff: {
          handoffId: 'handoff-1',
          supportRequestId: 'request-1',
          supportRequestVersion: 5,
        },
        supportRequestVersion: 7,
        supportRequestStatus: 'IN_REVIEW',
      },
      { credential, approvalGrantId: 'grant-package-reversion-1' },
    )
    expect(domain.verifyApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalGrantId: 'grant-package-reversion-1',
        toolName: 'pathfinder.apply_support_package_reversion',
        capability: 'packages:revert',
        clientId: 'client-1',
        venueId: 'venue-1',
      }),
      expect.objectContaining({ credential }),
    )
    expect(domain.applySupportPackageReversion).toHaveBeenCalledOnce()
  })

  it('routes inert handoff-supersession review and requires packages:reconcile to execute', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain, { writeToolsEnabled: true })
    const base = {
      clientId: 'client-1',
      venueId: 'venue-1',
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      requestId: 'request-1',
      expectedVersion: 8,
    }
    await registry.callTool(
      'pathfinder.propose_support_package_handoff_supersession',
      {
        ...base,
        supersededHandoffId: 'handoff-old',
        replacementHandoffId: 'handoff-new',
        reason: 'The applied replacement should become current fulfillment.',
      },
      { credential },
    )
    expect(domain.proposeSupportPackageHandoffSupersession).toHaveBeenCalledOnce()
    expect(domain.verifyApprovalGrant).not.toHaveBeenCalled()
    await registry.callTool(
      'pathfinder.apply_support_package_handoff_supersession',
      {
        ...base,
        supportRequestStatus: 'IN_REVIEW',
        superseded: {
          handoffId: 'handoff-old',
          packageId: 'package-old',
          handoffRequestVersion: 4,
          packageUpdatedAt: '2030-01-01T00:00:00.000Z',
          payloadHash: 'a'.repeat(64),
          revertedAt: '2030-01-01T00:00:00.000Z',
          revertedBy: 'agent-old',
          revertedCommandKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
        replacement: {
          handoffId: 'handoff-new',
          packageId: 'package-new',
          handoffRequestVersion: 7,
          packageUpdatedAt: '2030-01-02T00:00:00.000Z',
          payloadHash: 'c'.repeat(64),
          appliedAt: '2030-01-02T00:00:00.000Z',
          appliedBy: 'agent-new',
          appliedCommandKey: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      },
      { credential, approvalGrantId: 'grant-reconcile-1' },
    )
    expect(domain.verifyApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalGrantId: 'grant-reconcile-1',
        toolName: 'pathfinder.apply_support_package_handoff_supersession',
        capability: 'packages:reconcile',
      }),
      expect.objectContaining({ credential }),
    )
    expect(domain.applySupportPackageHandoffSupersession).toHaveBeenCalledOnce()
  })

  it('allows a scoped operator question without converting it into an approval or write grant', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain)
    await registry.callTool(
      'pathfinder.ask_operator',
      {
        clientId: 'client-1',
        venueId: 'venue-1',
        operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
        agentIdentityId: 'agent-1',
        question: 'Which source should I treat as authoritative?',
        choices: ['Venue website', 'Operator note'],
        blocking: true,
      },
      { credential },
    )
    expect(domain.askOperator).toHaveBeenCalledOnce()
    expect(domain.verifyApprovalGrant).not.toHaveBeenCalled()
  })

  it('allows an idempotent in-scope specialist delegation without granting domain mutation authority', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain)
    await registry.callTool(
      'pathfinder.delegate_specialist',
      {
        clientId: 'client-1',
        venueId: 'venue-1',
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        parentAgentRunId: 'run-primary',
        requestingAgentIdentityId: 'agent-primary',
        specialistAgentIdentityId: 'agent-research',
        instructions: 'Review the current architecture and return evidence.',
        reason: 'The research specialist owns architecture review.',
      },
      { credential },
    )
    expect(domain.delegateSpecialist).toHaveBeenCalledOnce()
    expect(domain.verifyApprovalGrant).not.toHaveBeenCalled()
  })

  it('validates scope and output around an injected canonical domain action', async () => {
    const domain = actions()
    const registry = createPathfinderMcpRegistry(domain, { writeToolsEnabled: true })
    const result = await registry.callTool(
      'pathfinder.create_package_draft',
      {
        clientId: 'client-1',
        venueId: 'venue-1',
        title: 'Correct a fact',
        changeRequest: 'Prepare a reviewable correction.',
        sourceIds: [],
      },
      { credential, approvalGrantId: 'approval-1' },
    )
    expect(domain.createPackageDraft).toHaveBeenCalledOnce()
    expect(domain.verifyApprovalGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalGrantId: 'approval-1',
        toolName: 'pathfinder.create_package_draft',
        clientId: 'client-1',
        venueId: 'venue-1',
        capability: 'packages:draft',
      }),
      expect.objectContaining({ credential }),
    )
    expect(result.structuredContent.kind).toBe('test')
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
  })

  it('does not execute a draft when the canonical approval verifier rejects its scope', async () => {
    const domain = actions()
    vi.mocked(domain.verifyApprovalGrant).mockRejectedValueOnce(new Error('Approval scope denied'))
    const registry = createPathfinderMcpRegistry(domain, { writeToolsEnabled: true })
    await expect(
      registry.callTool(
        'pathfinder.create_package_draft',
        {
          clientId: 'client-1',
          venueId: 'venue-1',
          title: 'Correct a fact',
          changeRequest: 'Prepare a reviewable correction.',
          sourceIds: [],
        },
        { credential, approvalGrantId: 'approval-for-another-action' },
      ),
    ).rejects.toThrow('Approval scope denied')
    expect(domain.createPackageDraft).not.toHaveBeenCalled()
  })

  it('rejects unknown tools and attacker-supplied tenant authority', async () => {
    const registry = createPathfinderMcpRegistry(actions())
    await expect(
      registry.callTool('pathfinder.delete_venue', {}, { credential }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' })
    await expect(
      registry.callTool(
        'pathfinder.read',
        {
          tenantId: 'tenant-2',
          resource: 'content',
          clientId: 'client-1',
          venueId: 'venue-1',
          limit: 25,
        },
        { credential },
      ),
    ).rejects.toThrow()
  })
})
