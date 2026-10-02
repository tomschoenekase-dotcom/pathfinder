import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ add: vi.fn(), queue: vi.fn() }))

vi.mock('bullmq', () => ({
  Queue: mocks.queue.mockImplementation(() => ({
    add: mocks.add,
    close: vi.fn(async () => undefined),
  })),
}))
vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'test', REDIS_URL: 'redis://unused' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('./connection', () => ({ getBullMQConnection: vi.fn(() => ({})) }))

import { enqueueLiveDataPoll } from './enqueue'
import { LIVE_DATA_POLL_PROCESS_JOB, OPERATIONAL_QUEUE_NAMES, LIVE_DATA_POLL_QUEUE } from './queues'

const payload = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  connectorId: 'conn_1',
  mode: 'scheduled' as const,
}

describe('enqueueLiveDataPoll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.add.mockResolvedValue({ id: 'generated' })
  })

  it('carries only opaque identities and is observable as an operational queue', async () => {
    await enqueueLiveDataPoll(payload, new Date('2026-10-02T18:00:00Z'))
    const [name, data, options] = mocks.add.mock.calls[0]!
    expect(name).toBe(LIVE_DATA_POLL_PROCESS_JOB)
    expect(data).toEqual(payload)
    expect(Object.keys(data).sort()).toEqual(['connectorId', 'mode', 'tenantId', 'venueId'])
    expect(options).toMatchObject({ attempts: 2 })
    expect(OPERATIONAL_QUEUE_NAMES).toContain(LIVE_DATA_POLL_QUEUE)
  })

  it('de-duplicates repeated scheduler ticks inside one 15 second bucket', async () => {
    await enqueueLiveDataPoll(payload, new Date('2026-10-02T18:00:01Z'))
    await enqueueLiveDataPoll(payload, new Date('2026-10-02T18:00:14Z'))
    await enqueueLiveDataPoll(payload, new Date('2026-10-02T18:00:16Z'))
    const ids = mocks.add.mock.calls.map((call) => call[2].jobId)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
    expect(ids[0]).not.toContain(':')
  })

  it('keeps test jobs separate from scheduled jobs', async () => {
    const now = new Date('2026-10-02T18:00:01Z')
    await enqueueLiveDataPoll(payload, now)
    await enqueueLiveDataPoll({ ...payload, mode: 'test' }, now)
    expect(mocks.add.mock.calls[0]![2].jobId).not.toBe(mocks.add.mock.calls[1]![2].jobId)
  })

  it.each([
    ['tenantId', 'tenant:1'],
    ['venueId', ''],
    ['connectorId', 'x'.repeat(200)],
  ])('rejects a malformed %s before opening the queue', async (key, value) => {
    await expect(enqueueLiveDataPoll({ ...payload, [key]: value })).rejects.toThrow()
    expect(mocks.add).not.toHaveBeenCalled()
  })
})
