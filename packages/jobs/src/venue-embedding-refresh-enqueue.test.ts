import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ add: vi.fn(), retry: vi.fn(), getJob: vi.fn() }))
vi.mock('bullmq', () => ({ Queue: vi.fn(() => ({ add: mocks.add, getJob: mocks.getJob })) }))
vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'test' },
  logger: { info: vi.fn() },
}))
vi.mock('./connection', () => ({ getBullMQConnection: vi.fn(() => ({})) }))
import { enqueueVenueEmbeddingRefresh } from './enqueue'
const payload = { tenantId: 'tenant-a', venueId: 'harbor-gallery', refreshId: 'refresh-a' }
describe('venue embedding refresh delivery', () => {
  beforeEach(() => vi.clearAllMocks())
  it('reuses one scoped ID without retrying retained terminal jobs', async () => {
    mocks.getJob.mockResolvedValue({ retry: mocks.retry })
    await enqueueVenueEmbeddingRefresh(payload)
    await enqueueVenueEmbeddingRefresh(payload)
    const first = mocks.add.mock.calls[0]!
    expect(first[0]).toBe('venue-embedding-refresh-process')
    expect(first[2]).toEqual({
      jobId: expect.stringMatching(/^venue-embedding-refresh-[a-f0-9]{64}$/),
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    })
    expect(mocks.add.mock.calls[1]).toEqual(first)
    expect(mocks.retry).not.toHaveBeenCalled()
    expect(mocks.getJob).not.toHaveBeenCalled()
  })
  it.each(['tenantId', 'venueId', 'refreshId'] as const)(
    'separates %s in deterministic identity',
    async (key) => {
      await enqueueVenueEmbeddingRefresh(payload)
      await enqueueVenueEmbeddingRefresh({ ...payload, [key]: 'different' })
      expect(mocks.add.mock.calls[0]![2].jobId).not.toBe(mocks.add.mock.calls[1]![2].jobId)
    },
  )
  it.each(['', ' ', 'x'.repeat(201)])('rejects invalid scope before Redis', async (venueId) => {
    await expect(enqueueVenueEmbeddingRefresh({ ...payload, venueId })).rejects.toThrow()
    expect(mocks.add).not.toHaveBeenCalled()
  })
})
