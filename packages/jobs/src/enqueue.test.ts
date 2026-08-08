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
  enqueueWelcomeEmail,
} from './enqueue'

describe('job enqueues', () => {
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

  it('deduplicates only the exact opaque media-ingestion generation', async () => {
    const payload = {
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
      uploadAttemptId: '11111111-1111-4111-8111-111111111111',
    }
    await enqueueMediaIngestion(payload)
    await enqueueMediaIngestion(payload)
    await enqueueMediaIngestion({
      ...payload,
      uploadAttemptId: '22222222-2222-4222-8222-222222222222',
    })

    expect(mocks.add).toHaveBeenCalledTimes(3)
    const [first, replay, nextGeneration] = mocks.add.mock.calls
    expect(replay![2].jobId).toBe(first![2].jobId)
    expect(nextGeneration![2].jobId).not.toBe(first![2].jobId)
    expect(first![2].jobId).toMatch(/^media-ingestion-[a-f0-9]{64}$/u)
    expect(first![2].jobId).not.toContain(payload.tenantId)
    expect(first![2].jobId).not.toContain(payload.projectId)
    expect(first![2].jobId).not.toContain(payload.uploadAttemptId)
    expect(first![1]).toEqual(payload)
  })

  it('scopes welcome-email deduplication to the tenant and recipient without leaking user ID', async () => {
    const payload = {
      tenantId: 'tenant_1',
      to: 'recipient@example.com',
      recipientName: 'Recipient',
      orgName: 'Test Org',
    }

    await enqueueWelcomeEmail(payload, 'user_1')
    await enqueueWelcomeEmail(payload, 'user_2')
    await enqueueWelcomeEmail(payload, 'user_1')
    await enqueueWelcomeEmail({ ...payload, tenantId: 'tenant_2' }, 'user_1')

    expect(mocks.add).toHaveBeenCalledTimes(4)
    const [first, second, retry, otherTenant] = mocks.add.mock.calls
    expect(first![2].jobId).not.toBe(second![2].jobId)
    expect(retry![2].jobId).toBe(first![2].jobId)
    expect(otherTenant![2].jobId).not.toBe(first![2].jobId)
    expect(first![2].jobId).toMatch(/^send-welcome-email-[a-f0-9]{64}$/u)
    expect(JSON.stringify(mocks.add.mock.calls)).not.toContain('user_1')
    expect(JSON.stringify(mocks.add.mock.calls)).not.toContain('user_2')
    expect(first![1]).toEqual(payload)
  })

  it('rejects a missing welcome recipient identity before touching the queue', async () => {
    await expect(
      enqueueWelcomeEmail(
        {
          tenantId: 'tenant_1',
          to: 'recipient@example.com',
          recipientName: null,
          orgName: 'Test Org',
        },
        '',
      ),
    ).rejects.toThrow('recipient user ID is required')
    expect(mocks.add).not.toHaveBeenCalled()
  })
})
