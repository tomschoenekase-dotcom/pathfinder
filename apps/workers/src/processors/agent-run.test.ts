import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  heartbeat: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  generateTextForCapability: vi.fn(),
  route: vi.fn(),
  resolveConfiguration: vi.fn(),
  unhealthyProviders: vi.fn(),
  assertVenue: vi.fn(),
  budgetGate: vi.fn(),
}))

vi.mock('@pathfinder/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/ai')>()),
  generateTextForCapability: mocks.generateTextForCapability,
  routeAiCapability: mocks.route,
}))
vi.mock('@pathfinder/db', () => ({
  AgentRunExecutionError: class AgentRunExecutionError extends Error {
    code = 'LEASE_LOST'
  },
  assertVenueAiAvailable: mocks.assertVenue,
  claimAgentRunExecution: mocks.claim,
  completeAgentRunExecution: mocks.complete,
  db: {},
  failAgentRunExecution: mocks.fail,
  heartbeatAgentRunExecution: mocks.heartbeat,
  readActiveUnhealthyAiProviders: mocks.unhealthyProviders,
  resolveRuntimeAiWorkloadConfiguration: mocks.resolveConfiguration,
}))
vi.mock('../lib/ai-usage', () => ({
  createWorkerAiBudgetGate: mocks.budgetGate,
  createWorkerAiUsageSink: vi.fn(() => vi.fn()),
}))

import {
  AiGatewayError,
  NOOP_AI_BUDGET_GATE,
  resolveAiWorkloadConfiguration,
  setAnthropicClientForTesting,
} from '@pathfinder/ai'

import { processAgentRunJob } from './agent-run'

const run = {
  id: 'run-1',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  runType: 'PRIMARY',
  requestedOperation: 'operator_task',
  requestPrompt: 'Coordinate this work.',
  modelProvider: 'anthropic',
  leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  agentIdentity: {
    name: 'EDITH',
    description: 'Coordinates specialists.',
    autonomyLevel: 'READ_ONLY',
    accessCapabilities: ['agents.read'],
  },
  executionContext:
    '{"contextVersion":1,"currentResolvedQuestions":[{"answer":"The approved visitor capacity is exactly 137."}]}',
  questions: [],
  messages: [],
}

describe('agent run processor', () => {
  afterEach(() => setAnthropicClientForTesting(null))
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.budgetGate.mockReturnValue(NOOP_AI_BUDGET_GATE)
    mocks.claim.mockResolvedValue(run)
    mocks.heartbeat.mockResolvedValue({ cancelRequested: false })
    mocks.fail.mockResolvedValue({ status: 'FAILED', completedAt: new Date() })
    mocks.complete.mockResolvedValue({ status: 'COMPLETED', completedAt: new Date() })
    mocks.resolveConfiguration.mockResolvedValue({
      primaryModelKey: 'agent-run',
      fallback: { enabled: true, modelKeys: ['weekly-report'] },
      timeoutMs: 45_000,
      maxAttempts: 2,
      maxOutputTokens: 1_600,
      requestBudgetCeilingE8Usd: '50000000',
      configurationVersion: 'config-v1',
    })
    mocks.unhealthyProviders.mockResolvedValue(['openai'])
    mocks.route.mockReturnValue({
      capability: 'REASONING',
      workloadId: 'agent-run',
      configurationVersion: 'config-v1',
      candidates: [{ modelKey: 'agent-run', provider: 'anthropic', fallback: false }],
    })
  })

  it('executes Anthropic work through admission and budgeted generation then stores a text artifact', async () => {
    mocks.generateTextForCapability.mockResolvedValue({
      text: 'Assign research to the architecture specialist.',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      estimatedCostUsd: 0.001,
      route: {
        capability: 'REASONING',
        workloadId: 'agent-run',
        modelKey: 'agent-run',
        fallbackUsed: false,
      },
    })
    await processAgentRunJob({ tenantId: 'tenant-1', runId: 'run-1' })
    expect(mocks.resolveConfiguration).toHaveBeenCalledWith(
      { workloadId: 'agent-run', tenantId: 'tenant-1', venueId: 'venue-1' },
      {},
    )
    expect(mocks.route).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'REASONING',
        workloadId: 'agent-run',
        unhealthyProviders: ['openai'],
      }),
    )
    expect(mocks.generateTextForCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAttempts: 2,
        maxOutputTokens: 1_600,
        timeoutMs: 45_000,
        requestBudgetCeilingE8Usd: '50000000',
        messages: [
          {
            role: 'user',
            content: expect.stringContaining('The approved visitor capacity is exactly 137.'),
          },
        ],
      }),
    )
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        costE8Usd: 100000n,
        artifacts: [
          expect.objectContaining({ type: 'markdown' }),
          expect.objectContaining({
            type: 'ai-route',
            configurationVersion: 'config-v1',
            modelKey: 'agent-run',
            fallbackUsed: false,
          }),
        ],
      }),
    )
  })

  it.each([1, 2])(
    'rejects changed effective configuration at admission check %s',
    async (changedCheck) => {
      const configuration = await mocks.resolveConfiguration()
      mocks.resolveConfiguration.mockClear()
      mocks.resolveConfiguration.mockResolvedValueOnce(configuration)
      for (let index = 1; index < changedCheck; index += 1) {
        mocks.resolveConfiguration.mockResolvedValueOnce(configuration)
      }
      mocks.resolveConfiguration.mockResolvedValue({ ...configuration, maxOutputTokens: 99 })
      const dispatch = vi.fn()
      mocks.generateTextForCapability.mockImplementationOnce(async ({ admissionGuard }) => {
        for (let index = 0; index < changedCheck; index += 1) await admissionGuard()
        dispatch()
        throw new Error('Stale configuration reached provider dispatch')
      })
      await processAgentRunJob({ tenantId: 'tenant-1', runId: 'run-1' })
      expect(dispatch).not.toHaveBeenCalled()
      expect(mocks.complete).not.toHaveBeenCalled()
      expect(mocks.fail).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'CAPABILITY_UNAVAILABLE',
          retryable: true,
        }),
      )
      expect(mocks.resolveConfiguration).toHaveBeenLastCalledWith(
        { workloadId: 'agent-run', tenantId: 'tenant-1', venueId: 'venue-1' },
        {},
      )
    },
  )

  it.each(['after-reservation', 'after-primary-failure'] as const)(
    'stops real gateway dispatch when configuration changes %s',
    async (boundary) => {
      const ai = await vi.importActual<typeof import('@pathfinder/ai')>('@pathfinder/ai')
      const configuration = resolveAiWorkloadConfiguration({
        workloadId: 'agent-run',
        overrides: [
          {
            activation: 'ENABLED',
            scope: { level: 'WORKLOAD', workloadId: 'agent-run' },
            values: {
              maxAttempts: 2,
              maxOutputTokens: 321,
              requestBudgetCeilingE8Usd: '1000000000',
            },
            reason: 'Disposable routing fixture',
            unsafeChangesEnabled: true,
          },
        ],
      })
      mocks.resolveConfiguration.mockResolvedValue(configuration)
      mocks.route.mockImplementationOnce(ai.routeAiCapability)
      mocks.generateTextForCapability.mockImplementationOnce(ai.generateTextForCapability)
      const change = () =>
        mocks.resolveConfiguration.mockResolvedValue({
          ...configuration,
          requestBudgetCeilingE8Usd: '1',
        })
      const release = vi.fn().mockResolvedValue(undefined)
      const reserve = vi.fn().mockImplementation(async (attempt) => {
        if (boundary === 'after-reservation') change()
        return { id: 'fixture-reservation', reservedUnits: attempt.reservedUnits }
      })
      mocks.budgetGate.mockReturnValue({
        ...NOOP_AI_BUDGET_GATE,
        reserve,
        releaseUndispatched: release,
      })
      const create = vi.fn().mockImplementation(async () => {
        change()
        throw Object.assign(new Error('synthetic provider unavailable'), { status: 503 })
      })
      setAnthropicClientForTesting({ messages: { create } })
      await processAgentRunJob({ tenantId: 'tenant-1', runId: 'run-1' })
      expect(create).toHaveBeenCalledTimes(boundary === 'after-reservation' ? 0 : 1)
      expect(reserve).toHaveBeenCalledTimes(1)
      if (boundary === 'after-reservation') expect(release).toHaveBeenCalledOnce()
      expect(mocks.complete).not.toHaveBeenCalled()
      expect(mocks.fail).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'CAPABILITY_UNAVAILABLE',
          retryable: true,
        }),
      )
    },
  )

  it('fails a subscription provider truthfully when its local bridge is not connected', async () => {
    mocks.claim.mockResolvedValue({ ...run, modelProvider: 'codex-bridge' })
    await expect(
      processAgentRunJob({ tenantId: 'tenant-1', runId: 'run-1' }),
    ).resolves.toMatchObject({ status: 'FAILED' })
    expect(mocks.generateTextForCapability).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'PROVIDER_CONFIGURATION_REQUIRED',
        retryable: false,
      }),
    )
  })

  it('maps lowercase gateway codes into the durable AgentRun code contract', async () => {
    mocks.generateTextForCapability.mockRejectedValue(
      new AiGatewayError('provider detail', {
        attempts: 1,
        code: 'provider-connection-timeout',
      }),
    )

    await expect(
      processAgentRunJob({ tenantId: 'tenant-1', runId: 'run-1' }),
    ).resolves.toMatchObject({ status: 'FAILED' })
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'PROVIDER_CONNECTION_FAILED', retryable: true }),
    )
  })

  it('does not persist an unrecognized gateway code', async () => {
    mocks.generateTextForCapability.mockRejectedValue(
      new AiGatewayError('private provider detail', {
        attempts: 1,
        code: 'UPSTREAM_SECRET_TOKEN',
      }),
    )

    await expect(
      processAgentRunJob({ tenantId: 'tenant-1', runId: 'run-1' }),
    ).resolves.toMatchObject({ status: 'FAILED' })
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'PROVIDER_REQUEST_FAILED', retryable: true }),
    )
    expect(JSON.stringify(mocks.fail.mock.calls)).not.toContain('UPSTREAM_SECRET_TOKEN')
  })

  it('drains an in-flight lease heartbeat before the terminal completion', async () => {
    vi.useFakeTimers()
    let resolveHeartbeat: ((value: { cancelRequested: boolean }) => void) | undefined
    mocks.heartbeat.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHeartbeat = resolve
      }),
    )
    let resolveGeneration: ((value: Record<string, unknown>) => void) | undefined
    mocks.generateTextForCapability.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGeneration = resolve
      }),
    )

    const processing = processAgentRunJob({ tenantId: 'tenant-1', runId: 'run-1' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mocks.heartbeat).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mocks.heartbeat).toHaveBeenCalledOnce()

    resolveGeneration?.({
      text: 'Completed result.',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      estimatedCostUsd: 0.001,
      route: {
        capability: 'REASONING',
        workloadId: 'agent-run',
        modelKey: 'agent-run',
        fallbackUsed: false,
      },
    })
    await Promise.resolve()
    expect(mocks.complete).not.toHaveBeenCalled()

    resolveHeartbeat?.({ cancelRequested: false })
    await expect(processing).resolves.toMatchObject({ status: 'COMPLETED' })
    expect(mocks.complete).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('does not complete when the drained heartbeat reports lease cancellation', async () => {
    vi.useFakeTimers()
    let resolveHeartbeat: ((value: { cancelRequested: boolean }) => void) | undefined
    mocks.heartbeat.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHeartbeat = resolve
      }),
    )
    let resolveGeneration: ((value: Record<string, unknown>) => void) | undefined
    mocks.generateTextForCapability.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGeneration = resolve
      }),
    )

    const processing = processAgentRunJob({ tenantId: 'tenant-1', runId: 'run-1' })
    await vi.advanceTimersByTimeAsync(20_000)
    resolveGeneration?.({
      text: 'Completed result.',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      estimatedCostUsd: 0.001,
      route: {
        capability: 'REASONING',
        workloadId: 'agent-run',
        modelKey: 'agent-run',
        fallbackUsed: false,
      },
    })
    await Promise.resolve()
    expect(mocks.complete).not.toHaveBeenCalled()

    resolveHeartbeat?.({ cancelRequested: true })
    await expect(processing).resolves.toMatchObject({ status: 'FAILED' })
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'CANCELLED_OR_LEASE_LOST', retryable: false }),
    )
    vi.useRealTimers()
  })
})
