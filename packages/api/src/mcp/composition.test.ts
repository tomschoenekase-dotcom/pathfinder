import { describe, expect, it } from 'vitest'

import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'

import { PathfinderMcpRegistryError } from './registry'
import { createSafeOperationalMcpRegistry } from './composition'

const credential = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueIds: ['venue-1'],
  capabilities: ['packages:draft'],
} satisfies VerifiedMcpCredentialScope

describe('safe operational MCP composition', () => {
  it('exposes the canonical catalog while write tools remain default-dark', async () => {
    const registry = createSafeOperationalMcpRegistry({} as never)
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
      code: 'WRITE_TOOLS_DISABLED',
    } satisfies Partial<PathfinderMcpRegistryError>)
  })
})
