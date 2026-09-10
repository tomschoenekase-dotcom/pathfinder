import { describe, expect, it, vi } from 'vitest'
import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import { createPathfinderMcpRegistry, type PathfinderMcpDomainActions } from './registry'

const executionClaim = {
  agentRunId: 'run-1',
  bridgeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workerId: 'worker-1',
  executionLeaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}
const credential: VerifiedMcpCredentialScope = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueIds: ['venue-1'],
  capabilities: ['resources:read', 'intake-source:read', 'agent-runs:execute'],
}
const input = {
  clientId: 'tenant-1',
  venueId: 'venue-1',
  resource: 'question-source',
  agentRunId: 'run-1',
  questionId: 'question-1',
}

describe('MCP execution claim transport', () => {
  it('retains validated lookup keys for canonical action admission', async () => {
    const read = vi.fn().mockResolvedValue({ kind: 'test', summary: 'Fixture', data: {} })
    const registry = createPathfinderMcpRegistry({ read } as unknown as PathfinderMcpDomainActions)
    await registry.callTool('pathfinder.read', input, { credential, executionClaim })
    expect(read).toHaveBeenCalledWith(expect.objectContaining(input), {
      credential,
      executionClaim,
    })
  })

  it('rejects malformed execution tokens before invoking the action', async () => {
    const read = vi.fn()
    const registry = createPathfinderMcpRegistry({ read } as unknown as PathfinderMcpDomainActions)
    await expect(
      registry.callTool('pathfinder.read', input, {
        credential,
        executionClaim: { ...executionClaim, executionLeaseToken: 'not-a-token' },
      }),
    ).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })

  it('does not substitute the question grant for the explicit source grant', async () => {
    const read = vi.fn()
    const registry = createPathfinderMcpRegistry({ read } as unknown as PathfinderMcpDomainActions)
    await expect(
      registry.callTool('pathfinder.read', input, {
        credential: {
          ...credential,
          capabilities: ['resources:read', 'questions:read', 'agent-runs:execute'],
        },
        executionClaim,
      }),
    ).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })
})
