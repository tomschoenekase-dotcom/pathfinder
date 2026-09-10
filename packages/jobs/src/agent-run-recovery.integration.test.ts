import { Queue, Worker } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'preview', REDIS_URL: process.env.REDIS_URL },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  AGENT_RUN_PROCESS_JOB,
  AGENT_RUN_QUEUE,
  closeBullMQConnection,
  closeJobQueues,
  enqueueAgentRun,
  getBullMQConnection,
} from './index'

function isExplicitDisposableRedis(): boolean {
  if (process.env.RUN_AGENT_RUN_RECOVERY_REDIS_INTEGRATION !== '1') return false
  if (
    process.env.PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION !==
    'pathfinder_disposable_agent_run_recovery'
  ) {
    return false
  }
  try {
    const url = new URL(process.env.REDIS_URL ?? '')
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return (
      url.protocol === 'redis:' &&
      ['127.0.0.1', '::1', 'localhost'].includes(host) &&
      url.port.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    )
  } catch {
    return false
  }
}

async function waitForState(queue: Queue, jobId: string, expected: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId)
    if (job && (await job.getState()) === expected) return job
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${jobId} to become ${expected}`)
}

const integrationDescribe = isExplicitDisposableRedis() ? describe : describe.skip

integrationDescribe('AgentRun retained failure recovery (disposable Redis integration)', () => {
  let queue!: Queue
  const workers: Array<{ close(): Promise<void> }> = []

  beforeAll(async () => {
    queue = new Queue(AGENT_RUN_QUEUE, { connection: getBullMQConnection() })
    await queue.obliterate({ force: true })
  })

  afterAll(async () => {
    await Promise.allSettled(workers.map((worker) => worker.close()))
    try {
      await queue.obliterate({ force: true })
      await queue.close()
      await closeJobQueues()
    } finally {
      await closeBullMQConnection()
    }
  })

  it('redrives a retained pre-claim failure once and preserves completed replay', async () => {
    const payload = { tenantId: 'tenant_recovery', runId: 'run_recovery' }
    const jobId = `agent-run-${payload.runId}`
    let syntheticPreClaimFailures = 0
    const failingWorker = new Worker(
      AGENT_RUN_QUEUE,
      async () => {
        syntheticPreClaimFailures += 1
        throw new Error('synthetic failure before database claim')
      },
      {
        connection: getBullMQConnection(),
        concurrency: 1,
        settings: { backoffStrategy: () => 1 },
      },
    )
    workers.push(failingWorker)
    failingWorker.on('error', () => undefined)

    await expect(enqueueAgentRun(payload, { enabled: true })).resolves.toEqual({ enqueued: true })
    await waitForState(queue, jobId, 'failed')
    expect(syntheticPreClaimFailures).toBe(3)
    await failingWorker.close()

    await expect(
      Promise.all([
        enqueueAgentRun(payload, { enabled: true }),
        enqueueAgentRun(payload, { enabled: true }),
      ]),
    ).resolves.toEqual([{ enqueued: true }, { enqueued: true }])
    await waitForState(queue, jobId, 'waiting')

    let recoveredExecutions = 0
    const recoveryWorker = new Worker(
      AGENT_RUN_QUEUE,
      async (job) => {
        expect(job.name).toBe(AGENT_RUN_PROCESS_JOB)
        expect(job.data).toEqual(payload)
        recoveredExecutions += 1
        return { recovered: true }
      },
      { connection: getBullMQConnection(), concurrency: 1 },
    )
    workers.push(recoveryWorker)
    recoveryWorker.on('error', () => undefined)
    await waitForState(queue, jobId, 'completed')
    await recoveryWorker.close()
    expect(recoveredExecutions).toBe(1)

    await expect(enqueueAgentRun(payload, { enabled: true })).resolves.toEqual({ enqueued: false })
    expect(
      await queue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed']),
    ).toHaveLength(1)
    expect(await (await queue.getJob(jobId))?.getState()).toBe('completed')
    expect(recoveredExecutions).toBe(1)
  })
})
