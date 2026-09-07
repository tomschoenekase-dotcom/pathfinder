import { describe, expect, it, vi } from 'vitest'

import {
  agentWorkflowManifestHash,
  agentWorkflowTextHash,
  isAgentWorkflowArtifactIntact,
  readCompatibleAgentWorkflowVersions,
} from './agent-workflow-registry-actions'

const manifest = {
  schemaVersion: 1,
  registryKey: 'grounded-review',
  version: 1,
  kind: 'WORKFLOW',
  description: 'Read retained evidence.',
  examples: [],
  requiredTools: [{ capability: 'resources:read', reason: 'Read evidence.' }],
  testedCases: ['Reject missing evidence.'],
  rollback: null,
  license: null,
}
const artifact = {
  id: 'version-1',
  registryKey: manifest.registryKey,
  version: 1,
  kind: 'WORKFLOW',
  manifest,
  manifestHash: agentWorkflowManifestHash(manifest),
  portableText: 'Read the retained source.',
  contentHash: agentWorkflowTextHash('Read the retained source.'),
  requiredToolCapabilities: ['resources:read'],
}

describe('registered workflow artifact integrity', () => {
  it('accepts an intact manifest and rejects independently corrupted executable metadata', () => {
    expect(isAgentWorkflowArtifactIntact(artifact)).toBe(true)
    for (const change of [
      { requiredToolCapabilities: [] },
      { registryKey: 'another-workflow' },
      { kind: 'SKILL' },
      { version: 2 },
      { portableText: 'Do something else.' },
      { manifestHash: '0'.repeat(64) },
    ])
      expect(isAgentWorkflowArtifactIntact({ ...artifact, ...change })).toBe(false)
  })

  it('returns missing tools for retired capabilities and fails closed on metadata corruption', async () => {
    const findFirst = vi.fn().mockResolvedValue(artifact)
    const client = { agentWorkflowVersion: { findFirst } }
    const scope = { tenantId: 'tenant-1', venueId: 'venue-1', registryKeys: ['grounded-review'] }
    await expect(
      readCompatibleAgentWorkflowVersions(scope, new Set(), client as never),
    ).resolves.toMatchObject([
      { compatibility: 'MISSING_TOOLS', missingCapabilities: ['resources:read'] },
    ])
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', venueId: 'venue-1', registryKey: 'grounded-review' },
        orderBy: [{ version: 'desc' }, { id: 'desc' }],
      }),
    )
    findFirst.mockResolvedValue({ ...artifact, requiredToolCapabilities: [] })
    await expect(
      readCompatibleAgentWorkflowVersions(scope, new Set(), client as never),
    ).resolves.toMatchObject([{ compatibility: 'INVALID_ARTIFACT', version: null }])
  })
})
