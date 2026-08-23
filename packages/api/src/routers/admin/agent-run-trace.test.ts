import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  actions: vi.fn(),
  events: vi.fn(),
  approvals: vi.fn(),
  outcomes: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  db: {
    agentRun: { findFirst: mocks.run },
    agentAction: { findMany: mocks.actions },
    agentTimelineEvent: { findMany: mocks.events },
    approvalRequest: { findMany: mocks.approvals },
    agentOutcomeObservation: { findMany: mocks.outcomes },
  },
}))

import type { TRPCContext } from '../../context'
import { adminAgentRunTraceRouter } from './agent-run-trace'

const context: TRPCContext = {
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: { userId: 'operator_1', activeTenantId: null, role: null, isPlatformAdmin: true },
}

describe('unified agent run trace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.run.mockResolvedValue({ id: 'run_1' })
    mocks.actions.mockResolvedValue([])
    mocks.events.mockResolvedValue([])
    mocks.approvals.mockResolvedValue([])
    mocks.outcomes.mockResolvedValue([])
  })

  it('merges safe evidence in exact reverse chronology and reports the bounded exclusions', async () => {
    const at = (value: string) => new Date(value)
    mocks.actions.mockResolvedValue([
      {
        id: 'action_1',
        createdAt: at('2026-08-23T12:00:00.000Z'),
        actionName: 'support.draft',
      },
    ])
    mocks.events.mockResolvedValue([
      {
        id: 'event_1',
        createdAt: at('2026-08-23T12:03:00.000Z'),
        eventType: 'RUN_COMPLETED',
      },
    ])
    mocks.approvals.mockResolvedValue([
      {
        id: 'approval_1',
        createdAt: at('2026-08-23T12:01:00.000Z'),
        expiresAt: null,
        decision: { decision: 'APPROVED' },
        proposedAction: 'support.publish',
      },
    ])
    mocks.outcomes.mockResolvedValue([
      {
        id: 'outcome_1',
        createdAt: at('2026-08-23T12:02:00.000Z'),
        verdict: 'POSITIVE',
      },
    ])

    const result = await adminAgentRunTraceRouter.createCaller(context).listAgentRunTrace({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentRunId: 'run_1',
      limit: 3,
    })

    expect(result.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'EVENT:event_1',
      'OUTCOME:outcome_1',
      'APPROVAL:approval_1',
    ])
    expect(result.nextCursor).toEqual({
      createdAt: '2026-08-23T12:01:00.000Z',
      kind: 'APPROVAL',
      id: 'approval_1',
    })
    expect(result.excludes).toEqual([
      'RAW_ACTION_OUTPUT',
      'RAW_ACTION_INPUT_REFERENCE',
      'SCOPE_SNAPSHOT',
      'EXECUTION_LEASE',
    ])
    expect(mocks.actions.mock.calls[0]![0].select).not.toHaveProperty('output')
    expect(mocks.actions.mock.calls[0]![0].select).not.toHaveProperty('inputReference')
  })

  it('applies the heterogeneous cursor without skipping equal-time lower trace keys', async () => {
    await adminAgentRunTraceRouter.createCaller(context).listAgentRunTrace({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      agentRunId: 'run_1',
      cursor: {
        createdAt: '2026-08-23T12:00:00.000Z',
        kind: 'EVENT',
        id: 'event_2',
      },
      limit: 10,
    })

    expect(mocks.events.mock.calls[0]![0].where.OR).toEqual([
      { createdAt: { lt: new Date('2026-08-23T12:00:00.000Z') } },
      {
        createdAt: new Date('2026-08-23T12:00:00.000Z'),
        id: { lt: 'event_2' },
      },
    ])
    expect(mocks.actions.mock.calls[0]![0].where.OR).toEqual([
      { createdAt: { lt: new Date('2026-08-23T12:00:00.000Z') } },
      { createdAt: new Date('2026-08-23T12:00:00.000Z') },
    ])
    expect(mocks.outcomes.mock.calls[0]![0].where.OR).toEqual([
      { createdAt: { lt: new Date('2026-08-23T12:00:00.000Z') } },
    ])
  })
})
