import { describe, expect, it } from 'vitest'

import {
  assertMcpScope,
  McpReadInput,
  McpEvaluationRequestInput,
  McpPackageDraftInput,
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
