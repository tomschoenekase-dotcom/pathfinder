import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  externalFind: vi.fn(),
  sessionFind: vi.fn(),
  sessionUpsert: vi.fn(),
  sessionUpdate: vi.fn(),
  runFindMany: vi.fn(),
  runUpdate: vi.fn(),
  workerFind: vi.fn(),
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
    agentRun: { findMany: mocks.runFindMany, update: mocks.runUpdate },
    agentWorker: { findFirst: mocks.workerFind },
  },
}))
vi.mock('./agent-run-execution-actions', () => ({
  AgentRunExecutionError: class AgentRunExecutionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  claimAgentRunExecution: mocks.claim,
  completeAgentRunExecution: mocks.complete,
  failAgentRunExecution: mocks.fail,
  heartbeatAgentRunExecution: mocks.heartbeatRun,
}))

import { claimAgentBridgeTask, registerAgentBridgeSession } from './agent-bridge-actions'
import { AgentRunExecutionError } from './agent-run-execution-actions'

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
    mocks.runFindMany.mockResolvedValue([{ id: 'run-1', scopeSnapshot: {} }])
    mocks.claim.mockResolvedValue({
      id: 'run-1',
      operationId: null,
      venueId: 'venue-1',
      runType: 'PRIMARY',
      requestedOperation: 'operator_task',
      requestPrompt: 'Build it',
      modelProvider: 'codex-bridge',
      modelName: 'subscription-default',
      leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      leaseExpiresAt: new Date(),
      attemptNumber: 1,
      scopeSnapshot: {},
      initiatedByType: 'HUMAN',
      initiatedById: 'operator-1',
      agentIdentity: {
        identityKey: 'edith.primary',
        name: 'EDITH',
        description: null,
        accessCapabilities: ['operations.read'],
        autonomyLevel: 'READ_ONLY',
        autonomousActions: [],
      },
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
    expect(mocks.runFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          modelProvider: 'codex-bridge',
          AND: [
            {
              OR: [
                { status: 'QUEUED' },
                { status: 'RUNNING', executionLeaseExpiresAt: { lt: expect.any(Date) } },
              ],
            },
            {
              OR: [
                { modelName: { in: ['subscription-default'] } },
                { modelName: 'subscription-default' },
              ],
            },
          ],
        }),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 25,
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

  it('skips incompatible role-bound work and claims the first compatible task', async () => {
    mocks.sessionFind.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      provider: 'CODEX_SUBSCRIPTION',
      supportedModels: ['subscription-default'],
    })
    mocks.workerFind.mockResolvedValue({
      id: 'worker-1',
      capabilities: ['agent-runs:execute', 'research.read'],
      agentRoles: ['researcher'],
    })
    mocks.runFindMany.mockResolvedValue([
      { id: 'builder-run', scopeSnapshot: { requiredWorkerRoles: ['builder'] } },
      {
        id: 'research-run',
        scopeSnapshot: {
          requiredWorkerRoles: ['researcher'],
          requiredWorkerCapabilities: ['research.read'],
        },
      },
    ])
    mocks.claim.mockResolvedValue({
      id: 'research-run',
      operationId: null,
      venueId: 'venue-1',
      runType: 'RESEARCH',
      requestedOperation: 'review_sources',
      requestPrompt: null,
      modelProvider: 'codex-bridge',
      modelName: 'subscription-default',
      leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      leaseExpiresAt: new Date(),
      attemptNumber: 1,
      scopeSnapshot: {},
      initiatedByType: 'SYSTEM',
      initiatedById: 'scheduler',
      agentIdentity: {
        identityKey: 'researcher',
        name: 'Researcher',
        description: null,
        accessCapabilities: ['research.read'],
        autonomyLevel: 'READ_ONLY',
        autonomousActions: [],
      },
    })
    const result = await claimAgentBridgeTask({
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      venueId: 'venue-1',
      workerKey: 'researcher-1',
      credential: credential as never,
    })
    expect(mocks.claim).toHaveBeenCalledTimes(1)
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ runId: 'research-run' }))
    expect(result.task?.id).toBe('research-run')
  })

  it('continues to the next candidate when another worker wins the first claim race', async () => {
    mocks.sessionFind.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      provider: 'CODEX_SUBSCRIPTION',
      supportedModels: ['subscription-default'],
    })
    mocks.runFindMany.mockResolvedValue([
      { id: 'contended-run', scopeSnapshot: {} },
      { id: 'available-run', scopeSnapshot: {} },
    ])
    mocks.claim
      .mockRejectedValueOnce(
        new AgentRunExecutionError('NOT_CLAIMABLE', 'Another worker claimed this run'),
      )
      .mockResolvedValueOnce({
        id: 'available-run',
        operationId: null,
        venueId: 'venue-1',
        runType: 'PRIMARY',
        requestedOperation: 'operator_task',
        requestPrompt: 'Build it',
        modelProvider: 'codex-bridge',
        modelName: 'subscription-default',
        leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        leaseExpiresAt: new Date(),
        attemptNumber: 1,
        scopeSnapshot: {},
        initiatedByType: 'SYSTEM',
        initiatedById: 'scheduler',
        agentIdentity: {
          identityKey: 'edith.primary',
          name: 'EDITH',
          description: null,
          accessCapabilities: ['operations.read'],
          autonomyLevel: 'READ_ONLY',
          autonomousActions: [],
        },
      })

    const result = await claimAgentBridgeTask({
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      venueId: 'venue-1',
      credential: credential as never,
    })

    expect(mocks.claim).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runId: 'contended-run' }),
    )
    expect(mocks.claim).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runId: 'available-run' }),
    )
    expect(result.task?.id).toBe('available-run')
  })
})
