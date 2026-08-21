import { describe, expect, it } from 'vitest'

import { parseVerifiedActorContext, VerifiedActorContext } from './actor'

describe('VerifiedActorContext', () => {
  it('requires full machine lineage instead of a human-shaped actor', () => {
    expect(
      VerifiedActorContext.safeParse({ type: 'AGENT', actorId: 'agent_1', role: 'AGENT' }).success,
    ).toBe(false)
  })

  it('accepts a fully attributed machine worker', () => {
    expect(
      parseVerifiedActorContext({
        type: 'AGENT',
        actorId: 'agent_1',
        role: 'AGENT',
        agentIdentityId: 'agent_1',
        agentRunId: 'run_1',
        workerId: 'worker_1',
        credentialId: 'credential_1',
        capability: 'operational-updates:draft',
        modelProvider: 'hermes',
        modelName: 'worker-default',
      }),
    ).toMatchObject({ type: 'AGENT', workerId: 'worker_1' })
  })

  it('rejects incomplete model attribution', () => {
    expect(() =>
      parseVerifiedActorContext({
        type: 'AGENT',
        actorId: 'agent_1',
        role: 'AGENT',
        agentIdentityId: 'agent_1',
        agentRunId: 'run_1',
        workerId: 'worker_1',
        credentialId: 'credential_1',
        capability: 'operational-updates:draft',
        modelProvider: 'hermes',
      }),
    ).toThrow()
  })
})
