import { readFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'test', REDIS_URL: 'redis://unused' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('./connection', () => ({ getBullMQConnection: vi.fn(() => ({})) }))

import { inspectQueueOperationalSnapshot } from './enqueue'
import {
  ACCOUNT_SUMMARY_REFRESH_QUEUE,
  BILLING_RECONCILIATION_QUEUE,
  OPERATIONAL_QUEUE_NAMES,
  PROSPECT_IMPORT_QUEUE,
  WEEKLY_REPORT_QUEUE,
} from './queues'

describe('live queue operational snapshot', () => {
  it('keeps the observed inventory equal to every exported queue', async () => {
    const source = await readFile(new URL('./queues.ts', import.meta.url), 'utf8')
    const exportedQueueConstants = [...source.matchAll(/export const ([A-Z0-9_]+_QUEUE) =/gu)].map(
      (match) => match[1],
    )

    expect(new Set(OPERATIONAL_QUEUE_NAMES).size).toBe(exportedQueueConstants.length)
    expect(OPERATIONAL_QUEUE_NAMES).toHaveLength(exportedQueueConstants.length)
    expect(OPERATIONAL_QUEUE_NAMES).toEqual(
      expect.arrayContaining([
        PROSPECT_IMPORT_QUEUE,
        BILLING_RECONCILIATION_QUEUE,
        ACCOUNT_SUMMARY_REFRESH_QUEUE,
      ]),
    )
  })

  it('returns bounded aggregate state without job identity, payload, or failure details', async () => {
    const now = new Date('2026-08-23T16:00:00.000Z')
    const privateSentinel = 'PRIVATE_QUEUE_PAYLOAD_SENTINEL'
    const failureSentinel = 'PRIVATE_FAILURE_SENTINEL'
    const resolver = vi.fn((name: string) => ({
      getJobCounts: vi.fn().mockResolvedValue({
        wait: name === PROSPECT_IMPORT_QUEUE ? 1 : 0,
        active: name === ACCOUNT_SUMMARY_REFRESH_QUEUE ? 1 : 0,
        delayed: name === BILLING_RECONCILIATION_QUEUE ? 2 : 0,
        prioritized: 0,
        'waiting-children': 0,
        failed: name === WEEKLY_REPORT_QUEUE ? 3 : 0,
      }),
      getJobs: vi.fn().mockResolvedValue(
        name === BILLING_RECONCILIATION_QUEUE
          ? [
              {
                id: 'private-job-id',
                data: { value: privateSentinel },
                failedReason: failureSentinel,
                timestamp: now.getTime() - 120_000,
              },
            ]
          : [],
      ),
      isPaused: vi.fn().mockResolvedValue(name === BILLING_RECONCILIATION_QUEUE),
      getJobSchedulersCount: vi.fn().mockResolvedValue(name === WEEKLY_REPORT_QUEUE ? 2 : 0),
    }))

    const snapshot = await inspectQueueOperationalSnapshot(now, resolver)

    expect(snapshot).toMatchObject({
      observedAt: now,
      coverage: {
        expectedQueues: OPERATIONAL_QUEUE_NAMES.length,
        observedQueues: OPERATIONAL_QUEUE_NAMES.length,
        complete: true,
      },
      totalDepth: 4,
      totalFailed: 3,
      pausedQueues: 1,
      jobSchedulers: 2,
      oldestAgeMs: 120_000,
    })
    expect(
      snapshot.queues.find((queue) => queue.name === BILLING_RECONCILIATION_QUEUE),
    ).toMatchObject({
      depth: 2,
      paused: true,
      oldestAgeMs: 120_000,
      counts: { delayed: 2, failed: 0 },
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('private-job-id')
    expect(serialized).not.toContain(privateSentinel)
    expect(serialized).not.toContain(failureSentinel)
  })
})
