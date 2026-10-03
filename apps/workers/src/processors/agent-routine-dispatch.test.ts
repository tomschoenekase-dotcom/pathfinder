import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  writeJobRecord: vi.fn(),
  updateJobRecord: vi.fn(),
  recordJobFailure: vi.fn(),
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
  logger: { info: mocks.info, error: mocks.error },
}))
vi.mock('@pathfinder/db', () => ({
  dispatchDueAgentRoutinesAction: mocks.dispatch,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))
vi.mock('../lib/job-execution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/job-execution')>()),
  recordJobFailure: mocks.recordJobFailure,
}))
import { processAgentRoutineDispatch } from './agent-routine-dispatch'

describe('processAgentRoutineDispatch', () => {
  it('fails closed when a stale scheduler job reaches a disabled runtime', async () => {
    mocks.routinesEnabled = false

    await expect(processAgentRoutineDispatch()).rejects.toThrow('AGENT_ROUTINES_ENABLED')
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(mocks.writeJobRecord).not.toHaveBeenCalled()
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
      { status: 'STOPPED', routineId: 'routine-3', reason: 'TARGET_REPLIED' },
      { status: 'SKIPPED', routineId: 'routine-4', reason: 'BUDGET_EXCEEDED' },
    ])
    mocks.writeJobRecord.mockResolvedValue('job-record-1')

    const result = await processAgentRoutineDispatch({
      bullJobId: 'bull-1',
      attemptNumber: 1,
      maxAttempts: 3,
    })

    expect(result).toEqual({ outcomes: expect.any(Array) })
    expect(mocks.writeJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: 'agent-routine-dispatch-scheduler',
        bullJobId: 'bull-1',
        tenantId: null,
        status: 'RUNNING',
      }),
    )
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job-record-1', { status: 'COMPLETE' })
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workers.agent-routine-dispatch.completed',
        dispatched: 1,
        stopped: 1,
        budgetRefused: 1,
        delivery: 'bridge-only',
      }),
    )
  })

  it('records a failed JobRecord and rethrows a queue-safe error when dispatch fails', async () => {
    mocks.routinesEnabled = true
    mocks.schedulersEnabled = true
    mocks.writeJobRecord.mockResolvedValue('job-record-2')
    mocks.dispatch.mockRejectedValue(new Error('database exploded with private detail'))

    await expect(processAgentRoutineDispatch()).rejects.toThrow('AGENT_ROUTINE_DISPATCH_FAILED')
    expect(mocks.recordJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({ jobRecordId: 'job-record-2' }),
    )
    expect(mocks.updateJobRecord).not.toHaveBeenCalledWith('job-record-2', expect.anything())
  })
})
