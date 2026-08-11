import { describe, expect, it, vi } from 'vitest'

import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'

import { createPathfinderMcpRegistry, type PathfinderMcpDomainActions } from './registry'

const credential: VerifiedMcpCredentialScope = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  venueIds: ['venue-1'],
  capabilities: ['resources:read', 'content:read', 'packages:draft', 'evaluations:request'],
}

function actions(): PathfinderMcpDomainActions {
  const result = {
    kind: 'test',
    summary: 'Canonical action result',
    data: { id: 'result-1' },
  } as const
  return {
    verifyApprovalGrant: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(result),
    createPackageDraft: vi.fn().mockResolvedValue(result),
    createUpdateDraft: vi.fn().mockResolvedValue(result),
    createSupportDraft: vi.fn().mockResolvedValue(result),
    requestEvaluation: vi.fn().mockResolvedValue(result),
  }
}

describe('PathFinder MCP server-side adapter registry', () => {
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
