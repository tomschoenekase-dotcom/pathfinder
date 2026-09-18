import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  info: vi.fn(),
  routinesEnabled: true,
  schedulersEnabled: true,
}))

vi.mock('@pathfinder/config', () => ({
  env: {
    get AGENT_ROUTINES_ENABLED() {
      return mocks.routinesEnabled
    },
    get WORKER_SCHEDULERS_ENABLED() {
      return mocks.schedulersEnabled
    },
  },
  logger: { info: mocks.info },
}))
vi.mock('@pathfinder/db', () => ({ dispatchDueAgentRoutinesAction: mocks.dispatch }))
import { processAgentRoutineDispatch } from './agent-routine-dispatch'

describe('processAgentRoutineDispatch', () => {
  it('fails closed when a stale scheduler job reaches a disabled runtime', async () => {
    mocks.routinesEnabled = false

    await expect(processAgentRoutineDispatch()).rejects.toThrow('AGENT_ROUTINES_ENABLED')
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('fails closed when a retained job reaches a scheduler-disabled runtime', async () => {
    mocks.routinesEnabled = true
    mocks.schedulersEnabled = false

    await expect(processAgentRoutineDispatch()).rejects.toThrow('WORKER_SCHEDULERS_ENABLED')
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('materializes bridge-only runs without enqueueing a managed worker', async () => {
    mocks.routinesEnabled = true
    mocks.schedulersEnabled = true
    mocks.dispatch.mockResolvedValue([
      { status: 'DISPATCHED', tenantId: 'tenant-1', routineId: 'routine-1', agentRunId: 'run-1' },
      { status: 'SKIPPED', routineId: 'routine-2', reason: 'NOT_DUE' },
    ])

    const result = await processAgentRoutineDispatch()

    expect(result).toEqual({ outcomes: expect.any(Array) })
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workers.agent-routine-dispatch.completed',
        dispatched: 1,
        delivery: 'bridge-only',
      }),
    )
  })
})
