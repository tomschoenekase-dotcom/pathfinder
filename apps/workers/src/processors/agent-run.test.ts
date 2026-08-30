import { beforeEach, describe, expect, it, vi } from 'vitest'

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
}))

vi.mock('@pathfinder/ai', () => ({
  AiGatewayError: class AiGatewayError extends Error {
    code = 'gateway'
  },
  AiRequestBudgetCeilingExceededError: class AiRequestBudgetCeilingExceededError extends Error {},
  AiRoutingError: class AiRoutingError extends Error {},
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
  createWorkerAiBudgetGate: vi.fn(() => ({})),
  createWorkerAiUsageSink: vi.fn(() => vi.fn()),
}))

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
}

describe('agent run processor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
        messages: [{ role: 'user', content: 'Coordinate this work.' }],
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
})
