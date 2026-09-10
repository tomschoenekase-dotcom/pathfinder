import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('agent question expiration worker registration', () => {
  it('keeps maintenance independent of agent execution and scheduler-gated', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/index.ts'), 'utf8')
    const queueStart = source.indexOf('const agentQuestionMaintenanceQueue =')
    const queueEnd = source.indexOf('const evaluationRunQueue =', queueStart)
    const schedulerStart = source.indexOf('agentQuestionMaintenanceQueue.upsertJobScheduler(')
    const schedulerGate = source.lastIndexOf(
      'await applySchedulerState(env.WORKER_SCHEDULERS_ENABLED, [',
      schedulerStart,
    )
    const schedulerEnd = source.indexOf(
      'await applySchedulerState(env.WORKER_SCHEDULERS_ENABLED, [',
      schedulerStart,
    )
    const workerStart = source.indexOf('const agentQuestionMaintenanceWorker =')
    const workerEnd = source.indexOf('const answerAnalysisWorker =', workerStart)

    expect(queueStart).toBeGreaterThanOrEqual(0)
    expect(source.slice(queueStart, queueEnd)).toContain(
      'new Queue(AGENT_QUESTION_MAINTENANCE_QUEUE,',
    )
    expect(source.slice(queueStart, queueEnd)).not.toContain('AGENT_RUNNER_ENABLED')
    expect(schedulerStart).toBeGreaterThan(queueEnd)
    expect(schedulerGate).toBeGreaterThan(queueEnd)
    expect(source.slice(schedulerGate, schedulerEnd)).toContain(
      'applySchedulerState(env.WORKER_SCHEDULERS_ENABLED,',
    )
    expect(source.slice(schedulerStart, schedulerEnd)).toContain('{ every: 60_000 }')
    expect(source.slice(schedulerStart, schedulerEnd)).toContain(
      'AGENT_QUESTION_EXPIRATION_SCHEDULER_JOB',
    )
    expect(workerStart).toBeGreaterThan(schedulerStart)
    expect(source.slice(workerStart, workerEnd)).toMatch(
      /new Worker\(\s+AGENT_QUESTION_MAINTENANCE_QUEUE,/u,
    )
    expect(source.slice(workerStart, workerEnd)).toContain('queueSafeJobProcessor')
    expect(source.slice(workerStart, workerEnd)).not.toContain('AGENT_RUNNER_ENABLED')
  })

  it('accepts only the recurring maintenance job and keeps it visible for lifecycle shutdown', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/index.ts'), 'utf8')

    expect(source).toContain('Unsupported agent question maintenance job: ${job.name}')
    expect(source).toContain('processAgentQuestionExpiration()')
    expect(source).toContain(
      '{ name: AGENT_QUESTION_MAINTENANCE_QUEUE, worker: agentQuestionMaintenanceWorker }',
    )
    expect(source).toContain('close: () => agentQuestionMaintenanceQueue.close()')
    expect(source).toContain('AGENT_QUESTION_MAINTENANCE_QUEUE,')
  })
})
