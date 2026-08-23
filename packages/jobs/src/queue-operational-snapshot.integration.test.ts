import { Queue, QueueEvents, Worker } from 'bullmq'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'preview', REDIS_URL: process.env.REDIS_URL },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { closeBullMQConnection, getBullMQConnection } from './connection'
import { closeJobQueues, inspectQueueOperationalSnapshot } from './enqueue'
import {
  ACCOUNT_SUMMARY_REFRESH_QUEUE,
  BILLING_RECONCILIATION_QUEUE,
  OPERATIONAL_QUEUE_NAMES,
  PROSPECT_IMPORT_QUEUE,
  WEEKLY_REPORT_PROCESS_JOB,
  WEEKLY_REPORT_QUEUE,
} from './queues'

const enabled =
  process.env.RUN_QUEUE_OBSERVABILITY_REDIS_INTEGRATION === '1' &&
  process.env.PATHFINDER_DISPOSABLE_REDIS_CONFIRMATION ===
    'pathfinder_disposable_queue_observability'

describe.skipIf(!enabled)('live queue operational snapshot on disposable Redis', () => {
  const resources: Array<{ close(): Promise<void> }> = []

  beforeEach(async () => {
    const connection = getBullMQConnection()
    for (const name of OPERATIONAL_QUEUE_NAMES) {
      const queue = new Queue(name, { connection })
      await queue.obliterate({ force: true })
      await queue.close()
    }
  })

  afterEach(async () => {
    await Promise.allSettled(resources.splice(0).map((resource) => resource.close()))
    await closeJobQueues()
    await closeBullMQConnection()
  })

  it('observes every canonical queue and aggregate pending state without private job material', async () => {
    const connection = getBullMQConnection()
    const prospect = new Queue(PROSPECT_IMPORT_QUEUE, { connection })
    const billing = new Queue(BILLING_RECONCILIATION_QUEUE, { connection })
    const summary = new Queue(ACCOUNT_SUMMARY_REFRESH_QUEUE, { connection })
    resources.push(prospect, billing, summary)
    await prospect.add('prospect-import-inspect', {
      tenantId: 'tenant-private',
      venueId: 'venue-private',
      secret: 'PRIVATE_QUEUE_PAYLOAD_SENTINEL',
    })
    await billing.add(
      'billing-reconciliation-process',
      { tenantId: 'tenant-private', secret: 'PRIVATE_BILLING_SENTINEL' },
      { delay: 60_000 },
    )
    await summary.add('account-summary-refresh-scheduler', {
      tenantId: 'tenant-private',
      secret: 'PRIVATE_SUMMARY_SENTINEL',
    })

    const snapshot = await inspectQueueOperationalSnapshot()

    expect(snapshot.coverage).toEqual({
      expectedQueues: OPERATIONAL_QUEUE_NAMES.length,
      observedQueues: OPERATIONAL_QUEUE_NAMES.length,
      complete: true,
    })
    expect(snapshot.queues.map((queue) => queue.name)).toEqual(OPERATIONAL_QUEUE_NAMES)
    expect(snapshot.totalDepth).toBe(3)
    expect(
      snapshot.queues.find((queue) => queue.name === PROSPECT_IMPORT_QUEUE)?.counts.waiting,
    ).toBe(1)
    expect(
      snapshot.queues.find((queue) => queue.name === BILLING_RECONCILIATION_QUEUE)?.counts.delayed,
    ).toBe(1)
    expect(
      snapshot.queues.find((queue) => queue.name === ACCOUNT_SUMMARY_REFRESH_QUEUE)?.counts.waiting,
    ).toBe(1)
    expect(JSON.stringify(snapshot)).not.toContain('tenant-private')
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_')
  })

  it('reports retained failed pressure without returning the failure or job identity', async () => {
    const connection = getBullMQConnection()
    const queue = new Queue(WEEKLY_REPORT_QUEUE, { connection })
    const events = new QueueEvents(WEEKLY_REPORT_QUEUE, { connection })
    const worker = new Worker(
      WEEKLY_REPORT_QUEUE,
      async () => {
        throw new Error('PRIVATE_FAILURE_SENTINEL')
      },
      { connection },
    )
    resources.push(queue, events, worker)
    await Promise.all([events.waitUntilReady(), worker.waitUntilReady()])
    const job = await queue.add(
      WEEKLY_REPORT_PROCESS_JOB,
      { tenantId: 'tenant-private', venueId: 'venue-private' },
      { attempts: 1, removeOnFail: false, jobId: 'private-job-identity-sentinel' },
    )
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow('PRIVATE_FAILURE_SENTINEL')

    const snapshot = await inspectQueueOperationalSnapshot()
    const report = snapshot.queues.find((entry) => entry.name === WEEKLY_REPORT_QUEUE)

    expect(report).toMatchObject({ depth: 0, failed: 1, counts: { failed: 1 } })
    expect(snapshot.totalFailed).toBe(1)
    const serialized = JSON.stringify(snapshot)
    expect(job.id).toBe('private-job-identity-sentinel')
    expect(serialized).not.toContain('private-job-identity-sentinel')
    expect(serialized).not.toContain('tenant-private')
    expect(serialized).not.toContain('PRIVATE_FAILURE_SENTINEL')
  })
})
