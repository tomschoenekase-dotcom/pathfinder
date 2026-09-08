import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ askQuestion: vi.fn() }))

vi.mock('@pathfinder/db', () => ({
  askAgentQuestionAction: mocks.askQuestion,
  delegateAgentTaskAction: vi.fn(),
  db: {},
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueAgentRun: vi.fn() }))
vi.mock('@pathfinder/billing', () => ({ proposeBillingAgentCommand: vi.fn() }))
vi.mock('@pathfinder/config', () => ({ env: { AGENT_RUNNER_ENABLED: false } }))

import { createPathfinderMcpAgentActions } from './agent-actions'

const context = {
  credential: { tenantId: 'tenant-1' },
}
const baseInput = {
  clientId: 'tenant-1',
  venueId: 'venue-1',
  operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  agentIdentityId: 'agent-1',
  question: 'Which source is authoritative?',
  choices: [],
  blocking: true,
}

describe('MCP operator question action', () => {
  beforeEach(() => vi.clearAllMocks())

  it('converts an explicit ISO expiry to Date and returns its canonical ISO value', async () => {
    const expiresAt = new Date('2030-01-01T18:00:00.000Z')
    mocks.askQuestion.mockResolvedValue({
      question: {
        id: 'question-1',
        agentRunId: 'run-1',
        status: 'PENDING',
        blocking: true,
        updatedAt: new Date('2030-01-01T12:00:00.000Z'),
        expiresAt,
      },
      replayed: false,
      consolidated: true,
    })
    const actions = createPathfinderMcpAgentActions({} as never, {} as never)

    const result = await actions.askOperator(
      { ...baseInput, expiresAt: '2030-01-01T18:00:00.000Z' },
      context as never,
    )

    expect(mocks.askQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt }),
      expect.anything(),
    )
    expect(result.data).toMatchObject({
      expiresAt: '2030-01-01T18:00:00.000Z',
      consolidated: true,
    })
  })

  it('keeps legacy omitted expiry compatible and exposes canonical null', async () => {
    mocks.askQuestion.mockResolvedValue({
      question: {
        id: 'question-1',
        agentRunId: null,
        status: 'PENDING',
        blocking: true,
        updatedAt: new Date('2030-01-01T12:00:00.000Z'),
        expiresAt: null,
      },
      replayed: false,
    })
    const actions = createPathfinderMcpAgentActions({} as never, {} as never)

    const result = await actions.askOperator(baseInput, context as never)

    expect(mocks.askQuestion.mock.calls[0]?.[0]).not.toHaveProperty('expiresAt')
    expect(result.data).toMatchObject({ expiresAt: null })
  })
})
