import { describe, expect, it } from 'vitest'

import {
  assertMcpScope,
  McpReadInput,
  McpEvaluationRequestInput,
  McpPackageDraftInput,
  McpSupportInformationRequestApplyInput,
  McpSupportCompletionApplyInput,
  McpSupportPackageDraftApplyInput,
  McpSupportPackageDraftProposalInput,
  McpSupportPackageApprovalApplyInput,
  McpSupportPackageApprovalProposalInput,
  McpSupportPackageApplicationApplyInput,
  McpSupportPackageApplicationProposalInput,
  McpSupportPackageHandoffSupersessionApplyInput,
  McpSupportPackageHandoffSupersessionProposalInput,
  McpScopeError,
  PATHFINDER_MCP_RESOURCES,
  PATHFINDER_MCP_TOOLS,
  toMcpStructuredResult,
  validatePathfinderMcpCatalog,
  type VerifiedMcpCredentialScope,
} from './mcp-v0'

const credential: VerifiedMcpCredentialScope = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  venueIds: ['venue-1'],
  capabilities: ['resources:read', 'content:read', 'packages:draft'],
}

describe('Torchiko MCP v0 contracts', () => {
  it('publishes a valid deterministic resource and tool catalog with explicit security metadata', () => {
    expect(() => validatePathfinderMcpCatalog()).not.toThrow()
    expect(PATHFINDER_MCP_RESOURCES.map(({ name }) => name)).toEqual([
      'pathfinder.clients',
      'pathfinder.billing',
      'pathfinder.venues',
      'pathfinder.configuration',
      'pathfinder.content',
      'pathfinder.history',
      'pathfinder.packages',
      'pathfinder.support',
      'pathfinder.updates',
      'pathfinder.ai-usage',
      'pathfinder.jobs',
      'pathfinder.evaluations',
      'pathfinder.reports',
      'pathfinder.conversations',
      'pathfinder.integrations',
      'pathfinder.agent-runs',
      'pathfinder.agent-run-trace',
      'pathfinder.events',
      'pathfinder.deployments',
      'pathfinder.feature-flags',
      'pathfinder.onboarding-summary',
      'pathfinder.readiness',
      'pathfinder.questions',
      'pathfinder.outcomes',
      'pathfinder.agent-improvements',
    ])
    for (const definition of [...PATHFINDER_MCP_RESOURCES, ...PATHFINDER_MCP_TOOLS]) {
      const security = definition._meta['com.pathfinder/security']
      expect(security.tenantBound).toBe(true)
      expect(security.clientBound).toBe(true)
      expect(security.capability).toBeTruthy()
      expect(security.scope).toBeTruthy()
    }
    for (const tool of PATHFINDER_MCP_TOOLS.filter(
      (tool) => tool._meta['com.pathfinder/security'].approvalRequired,
    )) {
      const security = tool._meta['com.pathfinder/security']
      expect(security.defaultEnabled).toBe(false)
      expect(security.approvalRequired).toBe(true)
      expect(tool.annotations.destructiveHint).toBe(false)
    }
    const askOperator = PATHFINDER_MCP_TOOLS.find(({ name }) => name === 'pathfinder.ask_operator')!
    expect(askOperator._meta['com.pathfinder/security']).toMatchObject({
      effect: 'interaction',
      risk: 'low',
      defaultEnabled: true,
      approvalRequired: false,
    })
    const customerAccess = PATHFINDER_MCP_TOOLS.find(
      ({ name }) => name === 'torchiko.customer_access.prepare_invitation',
    )!
    expect(customerAccess._meta['com.pathfinder/security']).toMatchObject({
      scope: 'venue',
      capability: 'customer-access:prepare',
      effect: 'interaction',
      risk: 'moderate',
      defaultEnabled: true,
      approvalRequired: false,
    })
    expect(customerAccess.description).toContain('never contacts Clerk')
  })

  it('requires an exact run id only for the bounded agent run trace resource', () => {
    const read = PATHFINDER_MCP_TOOLS.find(({ name }) => name === 'pathfinder.read')!
    expect(read.inputSchema).toMatchObject({
      properties: { agentRunId: { type: 'string', maxLength: 120 } },
    })
    expect(() =>
      McpReadInput.parse({
        resource: 'agent-run-trace',
        clientId: 'client-1',
        venueId: 'venue-1',
      }),
    ).toThrow()
    expect(() =>
      McpReadInput.parse({
        resource: 'agent-runs',
        clientId: 'client-1',
        venueId: 'venue-1',
        agentRunId: 'run-1',
      }),
    ).toThrow()
  })

  it('rejects cross-client, cross-venue, and missing-capability scope attempts', () => {
    expect(() =>
      assertMcpScope(
        credential,
        { clientId: 'client-2', venueId: 'venue-1' },
        'content:read',
        'venue',
      ),
    ).toThrow(McpScopeError)
    expect(() =>
      assertMcpScope(
        credential,
        { clientId: 'client-1', venueId: 'venue-2' },
        'content:read',
        'venue',
      ),
    ).toThrow(McpScopeError)
    expect(() =>
      assertMcpScope(
        credential,
        { clientId: 'client-1', venueId: 'venue-1' },
        'jobs:read',
        'venue',
      ),
    ).toThrow(McpScopeError)
  })

  it('strictly validates bounded draft and evaluation inputs', () => {
    expect(() =>
      McpPackageDraftInput.parse({
        tenantId: 'attacker-controlled',
        clientId: 'client-1',
        venueId: 'venue-1',
        title: 'Draft',
        changeRequest: 'Change one fact',
        sourceIds: [],
      }),
    ).toThrow()
    expect(() =>
      McpEvaluationRequestInput.parse({
        clientId: 'client-1',
        venueId: 'venue-1',
        suiteId: 'suite-1',
        caseIds: ['one', 'two'],
        maximumCases: 1,
      }),
    ).toThrow()
  })

  it('requires exact bounded fields for support information-request application', () => {
    const input = {
      clientId: 'client-1',
      venueId: 'venue-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      requestId: 'request-1',
      expectedVersion: 2,
      fromStatus: 'OPEN' as const,
      body: 'Please provide the current source document.',
      missingInformation: ['Current source document'],
    }
    expect(McpSupportInformationRequestApplyInput.parse(input)).toEqual(input)
    expect(() => McpSupportInformationRequestApplyInput.parse({ ...input, email: true })).toThrow()
    expect(
      PATHFINDER_MCP_TOOLS.find(
        ({ name }) => name === 'pathfinder.apply_support_information_request',
      )?._meta['com.pathfinder/security'],
    ).toMatchObject({
      capability: 'support:request-information',
      approvalRequired: true,
      defaultEnabled: false,
    })
  })

  it('requires exact bounded fields and approval for support completion', () => {
    const input = {
      clientId: 'client-1',
      venueId: 'venue-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      requestId: 'request-1',
      expectedVersion: 3,
      fromStatus: 'IN_REVIEW' as const,
      body: 'Your requested update is complete.',
    }
    expect(McpSupportCompletionApplyInput.parse(input)).toEqual(input)
    expect(() => McpSupportCompletionApplyInput.parse({ ...input, email: true })).toThrow()
    expect(
      PATHFINDER_MCP_TOOLS.find(({ name }) => name === 'pathfinder.apply_support_completion')
        ?._meta['com.pathfinder/security'],
    ).toMatchObject({
      capability: 'support:complete',
      approvalRequired: true,
      defaultEnabled: false,
    })
  })

  it('separates support package proposal from exact DRAFT-only application', () => {
    const input = {
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
    expect(McpSupportPackageDraftApplyInput.parse(input)).toEqual(input)
    expect(
      McpSupportPackageDraftProposalInput.parse({
        ...input,
        reason: 'The exact reviewed change is ready for a package draft.',
      }),
    ).toMatchObject({ reason: 'The exact reviewed change is ready for a package draft.' })
    expect(() => McpSupportPackageDraftApplyInput.parse({ ...input, publish: true })).toThrow()
    expect(
      PATHFINDER_MCP_TOOLS.find(({ name }) => name === 'pathfinder.propose_support_package_draft')
        ?._meta['com.pathfinder/security'],
    ).toMatchObject({ capability: 'packages:draft', approvalRequired: false })
    expect(
      PATHFINDER_MCP_TOOLS.find(({ name }) => name === 'pathfinder.apply_support_package_draft')
        ?._meta['com.pathfinder/security'],
    ).toMatchObject({
      capability: 'packages:draft',
      effect: 'approved-transition',
      approvalRequired: true,
      defaultEnabled: false,
    })
  })

  it('separates exact support package approval preparation from one-shot execution', () => {
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
    expect(
      McpSupportPackageApprovalProposalInput.parse({
        ...common,
        reason: 'The exact evaluated package is ready for founder review.',
      }),
    ).toMatchObject({ packageId: 'package-1' })
    const apply = {
      ...common,
      payloadHash: 'a'.repeat(64),
      baseDigest: 'b'.repeat(64),
      warningDigest: 'c'.repeat(64),
      supportHandoff: {
        handoffId: 'handoff-1',
        supportRequestId: 'request-1',
        supportRequestVersion: 5,
      },
    }
    expect(McpSupportPackageApprovalApplyInput.parse(apply)).toEqual(apply)
    expect(() => McpSupportPackageApprovalApplyInput.parse({ ...apply, publish: true })).toThrow()
    expect(
      PATHFINDER_MCP_TOOLS.find(
        ({ name }) => name === 'pathfinder.propose_support_package_approval',
      )?._meta['com.pathfinder/security'],
    ).toMatchObject({ capability: 'packages:approve', approvalRequired: false })
    expect(
      PATHFINDER_MCP_TOOLS.find(({ name }) => name === 'pathfinder.apply_support_package_approval')
        ?._meta['com.pathfinder/security'],
    ).toMatchObject({
      capability: 'packages:approve',
      effect: 'approved-transition',
      approvalRequired: true,
      defaultEnabled: false,
    })
  })

  it('separates inert package-application review from current-content execution', () => {
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
    expect(
      McpSupportPackageApplicationProposalInput.parse({
        ...common,
        reason: 'The approved package is ready for founder application review.',
      }),
    ).toMatchObject({ packageId: 'package-1' })
    const apply = {
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
    }
    expect(McpSupportPackageApplicationApplyInput.parse(apply)).toEqual(apply)
    expect(() =>
      McpSupportPackageApplicationApplyInput.parse({ ...apply, completeSupport: true }),
    ).toThrow()
    expect(
      PATHFINDER_MCP_TOOLS.find(
        ({ name }) => name === 'pathfinder.propose_support_package_application',
      )?._meta['com.pathfinder/security'],
    ).toMatchObject({ capability: 'packages:apply', approvalRequired: false })
    expect(
      PATHFINDER_MCP_TOOLS.find(
        ({ name }) => name === 'pathfinder.apply_support_package_application',
      )?._meta['com.pathfinder/security'],
    ).toMatchObject({
      capability: 'packages:apply',
      effect: 'approved-transition',
      approvalRequired: true,
      defaultEnabled: false,
    })
  })

  it('separates inert handoff-supersession review from exact approved execution', () => {
    const common = {
      clientId: 'client-1',
      venueId: 'venue-1',
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      workerKey: 'worker-1',
      requestId: 'request-1',
      expectedVersion: 8,
    }
    expect(
      McpSupportPackageHandoffSupersessionProposalInput.parse({
        ...common,
        supersededHandoffId: 'handoff-old',
        replacementHandoffId: 'handoff-new',
        reason: 'The applied replacement should become current fulfillment.',
      }),
    ).toMatchObject({ requestId: 'request-1' })
    const apply = {
      ...common,
      supportRequestStatus: 'IN_REVIEW' as const,
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
    }
    expect(McpSupportPackageHandoffSupersessionApplyInput.parse(apply)).toEqual(apply)
    expect(() =>
      McpSupportPackageHandoffSupersessionApplyInput.parse({ ...apply, contactCustomer: true }),
    ).toThrow()
    expect(
      PATHFINDER_MCP_TOOLS.find(
        ({ name }) => name === 'pathfinder.propose_support_package_handoff_supersession',
      )?._meta['com.pathfinder/security'],
    ).toMatchObject({ capability: 'packages:reconcile', approvalRequired: false })
    expect(
      PATHFINDER_MCP_TOOLS.find(
        ({ name }) => name === 'pathfinder.apply_support_package_handoff_supersession',
      )?._meta['com.pathfinder/security'],
    ).toMatchObject({
      capability: 'packages:reconcile',
      approvalRequired: true,
      defaultEnabled: false,
    })
  })

  it('returns structured output with the recommended backwards-compatible JSON text block', () => {
    const result = toMcpStructuredResult({
      kind: 'content',
      summary: 'One item',
      data: [{ id: 'item-1' }],
    })
    expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text))
    expect(result.resultType).toBe('complete')
  })
})
