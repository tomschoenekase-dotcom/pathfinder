import { describe, expect, it, vi } from 'vitest'

vi.mock('./agent-workflow-run-binding', () => ({
  bindEligibleAgentWorkflows: vi.fn(async () => ({ bindings: [], replayed: false })),
}))

import {
  createAgentRoutineAction,
  dispatchDueAgentRoutineAction,
  setAgentRoutineEnabledAction,
} from './agent-routine-actions'

const input = {
  operationId: 'a9ed8fa0-6089-4dd2-a72c-82785d11b5c6',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  routineKey: 'hermes-health-watch',
  agentIdentityId: 'agent-1',
  prompt: 'Inspect only the assigned operational health evidence. Do not mutate or send.',
  intervalSeconds: 300,
  requiredWorkerRoles: ['operations-monitor'],
  requiredWorkerCapabilities: ['agent-runs:execute'],
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-1' }) },
    agentIdentity: {
      findFirst: vi.fn().mockResolvedValue({ id: 'agent-1' }),
    },
    agentRoutine: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        id: 'routine-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        routineKey: input.routineKey,
        enabled: false,
        intervalSeconds: 300,
      }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentRoutineDispatch: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    agentRun: { create: vi.fn().mockResolvedValue({ id: 'run-1' }) },
    agentTimelineEvent: { create: vi.fn() },
    agentMessage: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRaw: vi.fn(),
    ...overrides,
  }
}

function client(tx: Record<string, unknown>) {
  return {
    agentRoutine: tx.agentRoutine,
    $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(tx)),
  }
}

describe('agent routines', () => {
  it('persists a default-dark monitor definition without materializing a run', async () => {
    const tx = transaction()
    const result = await createAgentRoutineAction(input, 'admin-1', client(tx) as never)

    expect(result.replayed).toBe(false)
    expect(
      (tx.agentRoutine as { findFirst: ReturnType<typeof vi.fn> }).findFirst,
    ).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', venueId: 'venue-1', routineKey: input.routineKey },
    })
    expect((tx.$executeRaw as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!).toBeLessThan(
      (tx.agentRoutine as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mock
        .invocationCallOrder[0]!,
    )
    expect((tx.agentRoutine as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ enabled: false, nextRunAt: null, maxAttempts: 1 }),
      }),
    )
    expect((tx.agentRun as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled()
  })

  it('makes an enabled routine due but does not claim it executed', async () => {
    const routine = {
      id: 'routine-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      enabled: false,
      nextRunAt: null,
    }
    const updatedRoutine = {
      ...routine,
      enabled: true,
      nextRunAt: new Date('2026-09-18T12:00:00.000Z'),
    }
    const findFirst = vi.fn().mockResolvedValueOnce(routine).mockResolvedValueOnce(updatedRoutine)
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const tx = transaction({
      agentRoutine: {
        findFirst,
        updateMany,
      },
    })
    const result = await setAgentRoutineEnabledAction(
      {
        operationId: 'bea37bcb-7d76-44a0-bbd4-0debd19c1c1d',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        routineId: 'routine-1',
        enabled: true,
      },
      'admin-1',
      { now: new Date('2026-09-18T12:00:00.000Z'), client: client(tx) as never },
    )

    expect(result.executionTriggered).toBe(false)
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'routine-1', tenantId: 'tenant-1', venueId: 'venue-1', enabled: false },
      data: {
        enabled: true,
        nextRunAt: new Date('2026-09-18T12:00:00.000Z'),
        lastSkipReason: null,
      },
    })
    expect(findFirst).toHaveBeenLastCalledWith({
      where: { id: 'routine-1', tenantId: 'tenant-1', venueId: 'venue-1' },
    })
    expect((tx.$executeRaw as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!).toBeLessThan(
      findFirst.mock.invocationCallOrder[0]!,
    )
  })

  it('materializes one role- and capability-bound AgentRun per due slot', async () => {
    const now = new Date('2026-09-18T12:00:00.000Z')
    const routine = {
      id: 'routine-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      routineKey: input.routineKey,
      enabled: true,
      nextRunAt: now,
      intervalSeconds: 300,
      maxAttempts: 1,
      maxRunsPerDay: 24,
      perRunBudgetE8Usd: null,
      dailyBudgetE8Usd: null,
      requiredWorkerRoles: input.requiredWorkerRoles,
      requiredWorkerCapabilities: input.requiredWorkerCapabilities,
      requestedOperation: 'routine_monitor',
      prompt: input.prompt,
      agentIdentity: {
        id: 'agent-1',
        agentType: 'OPERATIONS',
        accessScope: 'VENUE',
        accessCapabilities: ['operations.read'],
        autonomyLevel: 'READ_ONLY',
        autonomousActions: [],
        defaultProvider: 'hermes-bridge',
        defaultModel: 'subscription-default',
        enabled: true,
        venueId: 'venue-1',
      },
    }
    const update = vi.fn(async ({ data }: { data: { nextRunAt?: Date | null } }) => {
      if (data.nextRunAt !== undefined) routine.nextRunAt = data.nextRunAt as Date
      return routine
    })
    const tx = transaction({
      agentRoutine: { findUnique: vi.fn().mockResolvedValue(routine), update },
    })
    const api = client(tx)

    const first = await dispatchDueAgentRoutineAction({ routineId: routine.id, now }, api as never)
    const duplicate = await dispatchDueAgentRoutineAction(
      { routineId: routine.id, now },
      api as never,
    )

    expect(first).toMatchObject({ status: 'DISPATCHED', agentRunId: 'run-1' })
    expect(duplicate).toEqual({ routineId: 'routine-1', status: 'SKIPPED', reason: 'NOT_DUE' })
    expect((tx.agentRun as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledTimes(1)
    expect((tx.agentRun as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          maxAttempts: 1,
          scopeSnapshot: expect.objectContaining({
            requiredWorkerRoles: ['operations-monitor'],
            requiredWorkerCapabilities: ['agent-runs:execute'],
          }),
        }),
      }),
    )
  })

  it('leaves a legacy/manual budget-bearing routine inert until pre-call enforcement exists', async () => {
    const now = new Date('2026-09-18T12:00:00.000Z')
    const tx = transaction({
      agentRoutine: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'routine-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          enabled: true,
          nextRunAt: now,
          intervalSeconds: 300,
          maxAttempts: 1,
          maxRunsPerDay: 24,
          perRunBudgetE8Usd: 1n,
          dailyBudgetE8Usd: 10n,
          agentIdentity: { enabled: true, venueId: 'venue-1' },
        }),
        update: vi.fn(),
      },
    })
    const result = await dispatchDueAgentRoutineAction(
      { routineId: 'routine-1', now },
      client(tx) as never,
    )

    expect(result).toEqual({
      routineId: 'routine-1',
      status: 'SKIPPED',
      reason: 'UNSUPPORTED_BUDGET_ENFORCEMENT',
    })
    expect((tx.agentRun as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled()
  })

  it('fences a second queued or running slot before it can create a backlog', async () => {
    const now = new Date('2026-09-18T12:00:00.000Z')
    const tx = transaction({
      agentRoutine: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'routine-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          enabled: true,
          nextRunAt: now,
          intervalSeconds: 300,
          maxAttempts: 1,
          maxRunsPerDay: 24,
          perRunBudgetE8Usd: null,
          dailyBudgetE8Usd: null,
          agentIdentity: { enabled: true, venueId: 'venue-1' },
        }),
        update: vi.fn(),
      },
      agentRoutineDispatch: {
        findFirst: vi.fn().mockResolvedValue({ id: 'active-dispatch' }),
        findMany: vi.fn(),
        create: vi.fn(),
      },
    })

    await expect(
      dispatchDueAgentRoutineAction({ routineId: 'routine-1', now }, client(tx) as never),
    ).resolves.toEqual({ routineId: 'routine-1', status: 'SKIPPED', reason: 'ACTIVE_RUN_EXISTS' })
    expect(
      (tx.agentRoutineDispatch as { findMany: ReturnType<typeof vi.fn> }).findMany,
    ).not.toHaveBeenCalled()
    expect((tx.agentRun as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled()
  })

  it('fails closed for a legacy routine that requests more than one metered attempt', async () => {
    const now = new Date('2026-09-18T12:00:00.000Z')
    const update = vi.fn()
    const tx = transaction({
      agentRoutine: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'routine-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          enabled: true,
          nextRunAt: now,
          intervalSeconds: 300,
          maxAttempts: 2,
          agentIdentity: { enabled: true, venueId: 'venue-1' },
        }),
        update,
      },
    })

    await expect(
      dispatchDueAgentRoutineAction({ routineId: 'routine-1', now }, client(tx) as never),
    ).resolves.toEqual({
      routineId: 'routine-1',
      status: 'SKIPPED',
      reason: 'UNSUPPORTED_MAX_ATTEMPTS',
    })
    expect((tx.agentRun as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSkipReason: 'UNSUPPORTED_MAX_ATTEMPTS' }),
      }),
    )
  })
})
