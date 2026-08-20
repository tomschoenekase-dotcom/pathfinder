import { describe, expect, it } from 'vitest'

import { createProspectAgentRegistry, ProspectAgentRegistryError } from './registry'

describe('prospect agent registry', () => {
  it('exposes read and draft tools but no approval or send authority', () => {
    const names = createProspectAgentRegistry()
      .listTools()
      .map((tool) => tool.name)
    expect(names).toContain('torchiko.prospects.save_outreach_draft')
    expect(names.some((name) => /approve|send|queue/u.test(name))).toBe(false)
  })

  it('rejects a draft call without the verified draft capability before database access', async () => {
    await expect(
      createProspectAgentRegistry().callTool(
        'torchiko.prospects.save_outreach_draft',
        {},
        {
          actorId: 'agent-1',
          capabilities: ['prospects:read'],
        },
      ),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    } satisfies Partial<ProspectAgentRegistryError>)
  })

  it('rejects unknown tools', async () => {
    await expect(
      createProspectAgentRegistry().callTool(
        'torchiko.prospects.send',
        {},
        {
          actorId: 'agent-1',
          capabilities: ['prospects:read', 'prospects:draft'],
        },
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' } satisfies Partial<ProspectAgentRegistryError>)
  })
})
