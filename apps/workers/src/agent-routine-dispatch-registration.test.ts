import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('agent routine dispatch registration', () => {
  it('keeps the recurring dispatcher behind both scheduler and routine gates', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/index.ts'), 'utf8')
    const scheduler = source.indexOf('agentRoutineMaintenanceQueue.upsertJobScheduler(')
    const gate = source.lastIndexOf(
      'await applySchedulerState(env.WORKER_SCHEDULERS_ENABLED && env.AGENT_ROUTINES_ENABLED, [',
      scheduler,
    )

    expect(scheduler).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(0)
    expect(source.slice(gate, scheduler + 500)).toContain('AGENT_ROUTINE_DISPATCH_SCHEDULER_JOB')
    expect(source.slice(scheduler, scheduler + 700)).toContain('{ every: 60_000 }')
  })

  it('uses a maintenance worker rather than an executor directly', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/index.ts'), 'utf8')
    const workerStart = source.indexOf('const agentRoutineMaintenanceWorker =')
    const workerEnd = source.indexOf('const answerAnalysisWorker =', workerStart)

    expect(workerStart).toBeGreaterThan(0)
    expect(source.slice(workerStart, workerEnd)).toContain('AGENT_ROUTINE_MAINTENANCE_QUEUE')
    expect(source.slice(workerStart, workerEnd)).toContain('handleAgentRoutineMaintenanceQueueJob')
    expect(source.slice(workerStart, workerEnd)).not.toContain('processAgentRunJob')
  })
})
