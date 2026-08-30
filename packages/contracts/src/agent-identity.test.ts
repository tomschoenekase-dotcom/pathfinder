import { describe, expect, it } from 'vitest'

import {
  AGENT_DIRECT_EXECUTION_ROUTE,
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

  it('separates centrally governed direct routing from explicit bridge targets', () => {
    const authority = {
      accessCapabilities: ['content.read'] as const,
      autonomyLevel: 'READ_ONLY' as const,
      autonomousActions: [] as const,
    }
    expect(
      agentConfigurationCoherenceIssue({
        ...authority,
        accessCapabilities: [...authority.accessCapabilities],
        autonomousActions: [],
        defaultProvider: 'anthropic',
        defaultModel: AGENT_DIRECT_EXECUTION_ROUTE,
      }),
    ).toBeNull()
    expect(
      agentConfigurationCoherenceIssue({
        ...authority,
        accessCapabilities: [...authority.accessCapabilities],
        autonomousActions: [],
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
      }),
    ).toMatch(/centrally governed/)
    expect(
      agentConfigurationCoherenceIssue({
        ...authority,
        accessCapabilities: [...authority.accessCapabilities],
        autonomousActions: [],
        defaultProvider: 'codex-bridge',
        defaultModel: AGENT_DIRECT_EXECUTION_ROUTE,
      }),
    ).toMatch(/explicit bridge model target/)
  })
})
