import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  instances: new Map<string, { add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>(),
  queue: vi.fn(),
}))

vi.mock('bullmq', () => ({
  Queue: mocks.queue.mockImplementation((name: string) => {
    const instance = { add: mocks.add, close: vi.fn(async () => undefined) }
    mocks.instances.set(name, instance)
    return instance
  }),
}))
vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'test', REDIS_URL: 'redis://unused' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('./connection', () => ({ getBullMQConnection: vi.fn(() => ({})) }))

import {
  closeJobQueues,
  enqueueEmbedKnowledgeEntry,
  enqueueEmbedPlace,
  enqueueMediaIngestion,
} from './enqueue'

describe('mutable embedding enqueues', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.add.mockResolvedValue({ id: 'generated' })
  })

  afterEach(async () => {
    for (const instance of mocks.instances.values()) instance.close.mockResolvedValue(undefined)
    await closeJobQueues()
    mocks.instances.clear()
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

  it('closes every cached queue and retains only failures for retry', async () => {
    await enqueueEmbedPlace({
      tenantId: 'tenant_1',
      placeId: 'place_1',
      contentUpdatedAt: '2026-08-07T18:00:00.123Z',
    })
    await enqueueEmbedKnowledgeEntry({
      tenantId: 'tenant_1',
      entryId: 'entry_1',
      contentUpdatedAt: '2026-08-07T18:00:00.123Z',
    })
    const placeQueue = Array.from(mocks.instances.entries()).find(([name]) =>
      name.endsWith('embed-place'),
    )![1]
    const knowledgeQueue = Array.from(mocks.instances.entries()).find(([name]) =>
      name.endsWith('embed-knowledge-entry'),
    )![1]
    knowledgeQueue.close.mockRejectedValueOnce(new Error('redis unavailable'))

    const error = await closeJobQueues().catch((failure: unknown) => failure)
    expect(placeQueue.close).toHaveBeenCalledOnce()
    expect(knowledgeQueue.close).toHaveBeenCalledOnce()
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toMatchObject([
      { message: expect.stringMatching(/embed-knowledge-entry: redis unavailable$/u) },
    ])

    await closeJobQueues()
    expect(placeQueue.close).toHaveBeenCalledOnce()
    expect(knowledgeQueue.close).toHaveBeenCalledTimes(2)
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
