import { describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { AGENT_RUNNER_ENABLED: false },
  isFeatureEnabled: vi.fn(() => false),
}))
vi.mock('@pathfinder/db', () => ({
  dispatchIntakeSourceAgentTask: vi.fn(),
  listPendingIntakeSourceAgentDispatches: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueAgentRun: vi.fn() }))

import {
  reconcileIntakeSourceAgentDispatches,
  type IntakeSourceAgentDispatchDependencies,
} from './intake-source-agent-dispatch'

function dependencies(
  overrides: Partial<IntakeSourceAgentDispatchDependencies> = {},
): IntakeSourceAgentDispatchDependencies {
  return {
    listPending: vi.fn(async () => []),
    dispatch: vi.fn(async () => ({ status: 'COMPLETED' as const, runId: 'run-1' })),
    enqueue: vi.fn(async () => ({ enqueued: true })),
    ...overrides,
  }
}

describe('intake source agent dispatch reconciliation', () => {
  it('does no database work while disabled', async () => {
    const deps = dependencies()
    await expect(reconcileIntakeSourceAgentDispatches(deps, { enabled: false })).resolves.toEqual({
      discovered: 0,
      completed: 0,
      held: 0,
      cancelled: 0,
      enqueued: 0,
      failed: 0,
    })
    expect(deps.listPending).not.toHaveBeenCalled()
    expect(deps.dispatch).not.toHaveBeenCalled()
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it('dispatches exact scope and publishes a completed run', async () => {
    const dispatch = vi.fn(async () => ({ status: 'COMPLETED' as const, runId: 'run-1' }))
    const enqueue = vi.fn(async () => ({ enqueued: true }))
    const deps = dependencies({
      listPending: vi.fn(async () => [
        { id: 'dispatch-1', tenantId: 'tenant-1', venueId: 'venue-1' },
      ]),
      dispatch,
      enqueue,
    })

    await expect(reconcileIntakeSourceAgentDispatches(deps, { enabled: true })).resolves.toEqual({
      discovered: 1,
      completed: 1,
      held: 0,
      cancelled: 0,
      enqueued: 1,
      failed: 0,
    })
    expect(deps.listPending).toHaveBeenCalledWith(25)
    expect(dispatch).toHaveBeenCalledWith({
      id: 'dispatch-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })
    expect(enqueue).toHaveBeenCalledWith('tenant-1', 'run-1')
  })

  it('does not enqueue a held dispatch', async () => {
    const enqueue = vi.fn(async () => ({ enqueued: true }))
    const deps = dependencies({
      listPending: vi.fn(async () => [
        { id: 'dispatch-1', tenantId: 'tenant-1', venueId: 'venue-1' },
      ]),
      dispatch: vi.fn(async () => ({ status: 'HELD' as const })),
      enqueue,
    })

    const result = await reconcileIntakeSourceAgentDispatches(deps, { enabled: true })
    expect(result).toMatchObject({ discovered: 1, completed: 0, held: 1, enqueued: 0, failed: 0 })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('keeps durable completion and continues after one enqueue fails', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ status: 'COMPLETED', runId: 'run-1' })
      .mockResolvedValueOnce({ status: 'COMPLETED', runId: 'run-2' })
    const enqueue = vi
      .fn()
      .mockRejectedValueOnce(new Error('enqueue failed'))
      .mockResolvedValueOnce({ enqueued: true })
    const deps = dependencies({
      listPending: vi.fn(async () => [
        { id: 'dispatch-1', tenantId: 'tenant-1', venueId: 'venue-1' },
        { id: 'dispatch-2', tenantId: 'tenant-2', venueId: 'venue-2' },
      ]),
      dispatch,
      enqueue,
    })

    await expect(
      reconcileIntakeSourceAgentDispatches(deps, { enabled: true }),
    ).resolves.toMatchObject({
      discovered: 2,
      completed: 2,
      enqueued: 1,
      failed: 1,
    })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(enqueue).toHaveBeenCalledWith('tenant-1', 'run-1')
    expect(enqueue).toHaveBeenCalledWith('tenant-2', 'run-2')
  })

  it('recovers the same completed run on the next eligible sweep', async () => {
    const candidate = { id: 'dispatch-1', tenantId: 'tenant-1', venueId: 'venue-1' }
    const listPending = vi.fn(async () => [candidate])
    const dispatch = vi.fn(async () => ({
      status: 'COMPLETED' as const,
      runId: 'run-1',
      replayed: true,
    }))
    const enqueue = vi
      .fn()
      .mockRejectedValueOnce(new Error('enqueue failed'))
      .mockResolvedValueOnce({ enqueued: true })
    const deps = dependencies({ listPending, dispatch, enqueue })

    await expect(
      reconcileIntakeSourceAgentDispatches(deps, { enabled: true }),
    ).resolves.toMatchObject({ discovered: 1, completed: 1, enqueued: 0, failed: 1 })
    await expect(
      reconcileIntakeSourceAgentDispatches(deps, { enabled: true }),
    ).resolves.toMatchObject({ discovered: 1, completed: 1, enqueued: 1, failed: 0 })
    expect(listPending).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenNthCalledWith(2, candidate)
    expect(enqueue).toHaveBeenNthCalledWith(2, 'tenant-1', 'run-1')
  })
})
