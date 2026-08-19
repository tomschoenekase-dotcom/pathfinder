import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  heartbeat: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  generateText: vi.fn(),
  assertVenue: vi.fn(),
}))

vi.mock('@pathfinder/ai', () => ({
  AI_MODEL_KEYS: { AGENT_RUN: 'agent-run' },
  AiGatewayError: class AiGatewayError extends Error {
    code = 'gateway'
  },
  generateText: mocks.generateText,
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
  })

  it('executes Anthropic work through admission and budgeted generation then stores a text artifact', async () => {
    mocks.generateText.mockResolvedValue({
      text: 'Assign research to the architecture specialist.',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      estimatedCostUsd: 0.001,
    })
    await processAgentRunJob({ tenantId: 'tenant-1', runId: 'run-1' })
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        modelKey: 'agent-run',
        maxAttempts: 1,
        messages: [{ role: 'user', content: 'Coordinate this work.' }],
      }),
    )
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        costE8Usd: 100000n,
        artifacts: [expect.objectContaining({ type: 'markdown' })],
      }),
    )
  })

  it('fails a subscription provider truthfully when its local bridge is not connected', async () => {
    mocks.claim.mockResolvedValue({ ...run, modelProvider: 'codex-bridge' })
    await expect(
      processAgentRunJob({ tenantId: 'tenant-1', runId: 'run-1' }),
    ).resolves.toMatchObject({ status: 'FAILED' })
    expect(mocks.generateText).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'PROVIDER_CONFIGURATION_REQUIRED',
        retryable: false,
      }),
    )
  })
})
