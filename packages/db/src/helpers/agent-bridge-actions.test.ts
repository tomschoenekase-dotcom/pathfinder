import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  externalFind: vi.fn(),
  sessionFind: vi.fn(),
  sessionUpsert: vi.fn(),
  sessionUpdate: vi.fn(),
  runFind: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  heartbeatRun: vi.fn(),
}))
vi.mock('../client', () => ({
  db: {
    externalAccessCredential: { findFirst: mocks.externalFind },
    agentBridgeSession: {
      findFirst: mocks.sessionFind,
      upsert: mocks.sessionUpsert,
      updateMany: mocks.sessionUpdate,
    },
    agentRun: { findFirst: mocks.runFind },
  },
}))
vi.mock('./agent-run-execution-actions', () => ({
  claimAgentRunExecution: mocks.claim,
  completeAgentRunExecution: mocks.complete,
  failAgentRunExecution: mocks.fail,
  heartbeatAgentRunExecution: mocks.heartbeatRun,
}))

import { claimAgentBridgeTask, registerAgentBridgeSession } from './agent-bridge-actions'

const credential = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueIds: ['venue-1'],
  capabilities: ['agent-runs:execute'],
} as const

describe('agent bridge actions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('registers only against an active exact-scope machine credential and stores no secret material', async () => {
    mocks.externalFind.mockResolvedValue({ id: 'credential-1', scopeKey: 'venue-1' })
    mocks.sessionFind.mockResolvedValue(null)
    mocks.sessionUpsert.mockResolvedValue({ id: 'session-1', status: 'ONLINE' })
    await registerAgentBridgeSession({
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      venueId: 'venue-1',
      provider: 'HERMES',
      label: 'Hermes desktop',
      runnerVersion: '1.0',
      supportedModels: ['qwen'],
      credential: credential as never,
    })
    const call = mocks.sessionUpsert.mock.calls[0]![0]
    expect(call.create).toMatchObject({ credentialId: 'credential-1', provider: 'HERMES' })
    expect(JSON.stringify(call)).not.toMatch(/secret|token|browser/i)
  })

  it('claims only the provider-matched oldest task and binds the execution lease to the session', async () => {
    mocks.sessionFind.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      provider: 'CODEX_SUBSCRIPTION',
      supportedModels: ['subscription-default'],
    })
    mocks.runFind.mockResolvedValue({ id: 'run-1' })
    mocks.claim.mockResolvedValue({
      id: 'run-1',
      venueId: 'venue-1',
      runType: 'PRIMARY',
      requestedOperation: 'operator_task',
      requestPrompt: 'Build it',
      modelProvider: 'codex-bridge',
      modelName: 'subscription-default',
      leaseToken: 'lease',
      leaseExpiresAt: new Date(),
      attemptNumber: 1,
      scopeSnapshot: {},
      agentIdentity: { name: 'EDITH' },
    })
    const result = await claimAgentBridgeTask({
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      venueId: 'venue-1',
      credential: credential as never,
    })
    expect(mocks.sessionFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          credential: expect.objectContaining({
            enabled: true,
            revokedAt: null,
            capabilities: { has: 'agent-runs:execute' },
          }),
        }),
      }),
    )
    expect(mocks.runFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ modelProvider: 'codex-bridge', status: 'QUEUED' }),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    )
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        bridgeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    )
    expect(result.task?.id).toBe('run-1')
  })
})
