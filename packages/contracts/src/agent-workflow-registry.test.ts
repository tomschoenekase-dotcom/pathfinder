import { describe, expect, it } from 'vitest'

import {
  AgentWorkflowPortableManifestSchema,
  AgentWorkflowProvenanceSchema,
} from './agent-workflow-registry'

const manifest = {
  schemaVersion: 1 as const,
  registryKey: 'grounded-review',
  version: 1,
  kind: 'WORKFLOW' as const,
  description: 'Review a recommendation against retained evidence.',
  examples: ['Review source A.'],
  requiredTools: [{ capability: 'resources:read', reason: 'Read the source.' }],
  testedCases: ['Missing sources are rejected.'],
  rollback: null,
  license: null,
}

describe('agent workflow registry contracts', () => {
  it('accepts a bounded portable manifest and explicit provenance', () => {
    expect(AgentWorkflowPortableManifestSchema.parse(manifest)).toEqual(manifest)
    expect(
      AgentWorkflowProvenanceSchema.parse({
        sourceType: 'HUMAN_AUTHORED',
        sourceReferences: ['review:1'],
        capturedAt: null,
      }),
    ).toMatchObject({ capturedAt: null })
  })

  it('rejects duplicate capabilities and unbounded portable metadata', () => {
    expect(() =>
      AgentWorkflowPortableManifestSchema.parse({
        ...manifest,
        requiredTools: [...manifest.requiredTools, ...manifest.requiredTools],
      }),
    ).toThrow(/unique/u)
    expect(() =>
      AgentWorkflowPortableManifestSchema.parse({
        ...manifest,
        examples: Array.from({ length: 11 }, () => 'case'),
      }),
    ).toThrow()
  })
})
