import { Queue, Worker } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'preview', REDIS_URL: process.env.REDIS_URL },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  closeBullMQConnection,
  getBullMQConnection,
  inspectTerminalJobRedrive,
  inspectTerminalJobRedriveRuntime,
  redriveTerminalJob,
  WEEKLY_REPORT_PROCESS_JOB,
  WEEKLY_REPORT_QUEUE,
} from './index'
import type { TerminalJobRecordEvidence } from './terminal-redrive'

function isExplicitDisposableRedis(): boolean {
  if (process.env.RUN_TERMINAL_REDRIVE_REDIS_INTEGRATION !== '1') return false
  if (
    process.env.PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION !==
    'pathfinder_disposable_terminal_redrive'
  ) {
    return false
  }
  try {
    const url = new URL(process.env.REDIS_URL ?? '')
    const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
    return (
      (url.protocol === 'redis:' || url.protocol === 'rediss:') &&
      ['127.0.0.1', '::1', 'localhost'].includes(host) &&
      url.port.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    )
  } catch {
    return false
  }
}

async function waitForState(queue: Queue, jobId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await queue.getJob(jobId)
    if (job && (await job.getState()) === expected) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Job ${jobId} did not reach ${expected}`)
}

function terminalEvidence(jobId: string, attemptsMade: number): TerminalJobRecordEvidence {
  return {
    id: `record-${jobId}`,
    queue: WEEKLY_REPORT_QUEUE,
    jobName: WEEKLY_REPORT_PROCESS_JOB,
    bullJobId: jobId,
    tenantId: 'tenant_1',
    payload: { tenantId: 'tenant_1' },
    status: 'FAILED',
    attemptNumber: attemptsMade,
    maxAttempts: attemptsMade,
    failureDisposition: 'ATTEMPTS_EXHAUSTED',
    terminalAt: new Date('2026-08-08T12:00:00.000Z'),
  }
}

const integrationDescribe = isExplicitDisposableRedis() ? describe : describe.skip

integrationDescribe('terminal redrive (disposable Redis integration)', () => {
  let queue!: Queue

  beforeAll(async () => {
    queue = new Queue(WEEKLY_REPORT_QUEUE, { connection: getBullMQConnection() })
    await queue.obliterate({ force: true })
  })

  afterAll(async () => {
    await queue.obliterate({ force: true })
    await queue.close()
    await closeBullMQConnection()
  })

  it('reprocesses an exact exhausted failed job after resetting its attempt counters', async () => {
    const jobId = 'terminal-redrive-success'
    let executions = 0
    const firstWorker = new Worker(
      WEEKLY_REPORT_QUEUE,
      async () => {
        executions += 1
        throw new Error('synthetic first execution failure')
      },
      { connection: getBullMQConnection() },
    )
    await queue.add(
      WEEKLY_REPORT_PROCESS_JOB,
      { tenantId: 'tenant_1' },
      { jobId, attempts: 1, removeOnFail: false },
    )
    await waitForState(queue, jobId, 'failed')
    await firstWorker.close()

    const failedJob = await queue.getJob(jobId)
    const record = terminalEvidence(jobId, failedJob!.attemptsMade)
    const { preview } = await inspectTerminalJobRedrive({
      queue,
      bullJobId: jobId,
      evidence: record,
    })
    await expect(inspectTerminalJobRedriveRuntime({ evidence: record })).resolves.toEqual(preview)
    await redriveTerminalJob({
      queue,
      bullJobId: jobId,
      evidence: record,
      confirmationToken: preview.confirmationToken,
    })
    expect((await queue.getJob(jobId))!.attemptsMade).toBe(0)

    const secondWorker = new Worker(
      WEEKLY_REPORT_QUEUE,
      async () => {
        executions += 1
        return 'recovered'
      },
      { connection: getBullMQConnection() },
    )
    await waitForState(queue, jobId, 'completed')
    await secondWorker.close()
    expect(executions).toBe(2)
    expect((await queue.getJob(jobId))!.returnvalue).toBe('recovered')
  })

  it('allows only one of two concurrent redrive attempts to mutate the failed job', async () => {
    const jobId = 'terminal-redrive-concurrent'
    const worker = new Worker(
      WEEKLY_REPORT_QUEUE,
      async () => {
        throw new Error('synthetic terminal failure')
      },
      { connection: getBullMQConnection() },
    )
    await queue.add(
      WEEKLY_REPORT_PROCESS_JOB,
      { tenantId: 'tenant_1' },
      { jobId, attempts: 1, removeOnFail: false },
    )
    await waitForState(queue, jobId, 'failed')
    await worker.close()
    const failedJob = await queue.getJob(jobId)
    const record = terminalEvidence(jobId, failedJob!.attemptsMade)
    const { preview } = await inspectTerminalJobRedrive({
      queue,
      bullJobId: jobId,
      evidence: record,
    })

    const outcomes = await Promise.allSettled([
      redriveTerminalJob({
        queue,
        bullJobId: jobId,
        evidence: record,
        confirmationToken: preview.confirmationToken,
      }),
      redriveTerminalJob({
        queue,
        bullJobId: jobId,
        evidence: record,
        confirmationToken: preview.confirmationToken,
      }),
    ])
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(await (await queue.getJob(jobId))!.getState()).toBe('waiting')
  })
})
