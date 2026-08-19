import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  heartbeatSession: vi.fn(),
  claim: vi.fn(),
  heartbeatTask: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}))
vi.mock('@pathfinder/db', () => ({
  registerAgentBridgeSession: mocks.register,
  heartbeatAgentBridgeSession: mocks.heartbeatSession,
  claimAgentBridgeTask: mocks.claim,
  heartbeatAgentBridgeTask: mocks.heartbeatTask,
  completeAgentBridgeTask: mocks.complete,
  failAgentBridgeTask: mocks.fail,
}))

import { createAgentBridgeRegistry } from './registry'

const credential = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueIds: ['venue-1'],
  capabilities: ['agent-runs:execute'],
} as const

describe('agent bridge registry', () => {
  beforeEach(() => vi.clearAllMocks())

  it('validates bounded runner metadata before registering a session', async () => {
    mocks.register.mockResolvedValue({ id: 'session' })
    const registry = createAgentBridgeRegistry()
    await registry.register(
      {
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        venueId: 'venue-1',
        provider: 'CODEX_SUBSCRIPTION',
        label: 'Tom desktop Codex',
        runnerVersion: '1.0.0',
        supportedModels: ['subscription-default'],
      },
      { credential },
    )
    expect(mocks.register).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'CODEX_SUBSCRIPTION',
        credential,
      }),
    )
    expect(() =>
      registry.register(
        {
          sessionId: 'not-a-uuid',
          venueId: 'venue-1',
          provider: 'CODEX_SUBSCRIPTION',
          label: 'runner',
          runnerVersion: '1',
          supportedModels: [],
        },
        { credential },
      ),
    ).toThrow()
  })

  it('parses decimal cost units to bigint and bounds bridge artifacts', async () => {
    mocks.complete.mockResolvedValue({ status: 'COMPLETED' })
    await createAgentBridgeRegistry().completeTask(
      {
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        venueId: 'venue-1',
        runId: 'run-1',
        leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        summary: 'Done',
        artifacts: [{ type: 'markdown', title: 'Result', content: 'Evidence' }],
        modelName: 'subscription-default',
        costE8Usd: '1250',
      },
      { credential },
    )
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ costE8Usd: 1250n }))
  })
})
