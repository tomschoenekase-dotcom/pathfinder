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
    'evaluations:request',
    'questions:ask',
    'delegations:create',
    'accounts:read',
    'knowledge:read',
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
    knowledgeSearch: vi.fn().mockResolvedValue(result),
    knowledgeGet: vi.fn().mockResolvedValue(result),
    askOperator: vi.fn().mockResolvedValue(result),
    delegateSpecialist: vi.fn().mockResolvedValue(result),
    createPackageDraft: vi.fn().mockResolvedValue(result),
    createUpdateDraft: vi.fn().mockResolvedValue(result),
    createSupportDraft: vi.fn().mockResolvedValue(result),
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
        'torchiko.knowledge.search',
        'torchiko.knowledge.get',
      ]),
    )
    await registry.callTool(
      'torchiko.account.get_context',
      { clientId: 'client-1', organizationId: 'org-1', recentLimit: 8 },
      { credential },
    )
    await registry.callTool(
      'torchiko.knowledge.search',
      { clientId: 'client-1', query: 'pricing decision', limit: 5 },
      { credential },
    )
    expect(domain.accountContext).toHaveBeenCalled()
    expect(domain.knowledgeSearch).toHaveBeenCalled()
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
          resource: 'reports',
          clientId: 'client-1',
          venueId: 'venue-1',
          limit: 25,
        },
        { credential },
      ),
    ).rejects.toThrow('Capability denied')
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
