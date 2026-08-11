import { describe, expect, it } from 'vitest'

import {
  AgentIdentityConfigurationFields,
  agentConfigurationCoherenceIssue,
} from './agent-identity'

describe('agent identity configuration contracts', () => {
  it('rejects free-form identity and authority values', () => {
    expect(
      AgentIdentityConfigurationFields.safeParse({
        identityKey: 'content.primary',
        name: 'Content agent',
        description: null,
        agentType: 'ROOT',
        accessCapabilities: ['database.write'],
        autonomyLevel: 'READ_ONLY',
        autonomousActions: [],
      }).success,
    ).toBe(false)
  })

  it('keeps read-only, draft, and capability/action authority coherent', () => {
    expect(
      agentConfigurationCoherenceIssue({
        accessCapabilities: ['content.draft'],
        autonomyLevel: 'READ_ONLY',
        autonomousActions: ['content.prepare-draft'],
      }),
    ).toMatch(/Read-only/)
    expect(
      agentConfigurationCoherenceIssue({
        accessCapabilities: ['content.read'],
        autonomyLevel: 'DRAFT',
        autonomousActions: ['content.prepare-draft'],
      }),
    ).toMatch(/requires capability/)
    expect(
      agentConfigurationCoherenceIssue({
        accessCapabilities: ['content.draft'],
        autonomyLevel: 'DRAFT',
        autonomousActions: ['content.prepare-draft'],
      }),
    ).toBeNull()
  })
})
