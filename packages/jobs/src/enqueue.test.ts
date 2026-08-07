import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ add: vi.fn(), queue: vi.fn() }))

vi.mock('bullmq', () => ({
  Queue: mocks.queue.mockImplementation(() => ({ add: mocks.add })),
}))
vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'test', REDIS_URL: 'redis://unused' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('./connection', () => ({ getBullMQConnection: vi.fn(() => ({})) }))

import { enqueueEmbedKnowledgeEntry, enqueueEmbedPlace, enqueueMediaIngestion } from './enqueue'

describe('mutable embedding enqueues', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.add.mockResolvedValue({ id: 'generated' })
  })

  it('does not suppress repeated place revisions with a retained entity job id', async () => {
    const payload = {
      tenantId: 'tenant_1',
      placeId: 'place_1',
      contentUpdatedAt: '2026-08-07T18:00:00.123Z',
    }
    await enqueueEmbedPlace(payload)
    await enqueueEmbedPlace(payload)

    expect(mocks.add).toHaveBeenCalledTimes(2)
    for (const call of mocks.add.mock.calls) {
      expect(call[2]).not.toHaveProperty('jobId')
    }
  })

  it('does not suppress repeated knowledge revisions with a retained entity job id', async () => {
    const payload = {
      tenantId: 'tenant_1',
      entryId: 'entry_1',
      contentUpdatedAt: '2026-08-07T18:00:00.123Z',
    }
    await enqueueEmbedKnowledgeEntry(payload)
    await enqueueEmbedKnowledgeEntry(payload)

    expect(mocks.add).toHaveBeenCalledTimes(2)
    for (const call of mocks.add.mock.calls) {
      expect(call[2]).not.toHaveProperty('jobId')
    }
  })

  it('does not suppress a media project re-upload with a retained project job id', async () => {
    const payload = { tenantId: 'tenant_1', venueId: 'venue_1', projectId: 'project_1' }
    await enqueueMediaIngestion(payload)
    await enqueueMediaIngestion(payload)

    expect(mocks.add).toHaveBeenCalledTimes(2)
    for (const call of mocks.add.mock.calls) {
      expect(call[2]).not.toHaveProperty('jobId')
    }
  })
})
