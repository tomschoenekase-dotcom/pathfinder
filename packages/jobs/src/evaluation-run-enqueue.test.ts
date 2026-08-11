import { describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'test' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { enqueueEvaluationRun } from './enqueue'

describe('enqueueEvaluationRun admission', () => {
  it('is default-off without opening a queue connection', async () => {
    await expect(
      enqueueEvaluationRun({
        tenantId: 'tenant',
        venueId: 'venue',
        runId: '11111111-1111-4111-8111-111111111111',
        runIdentityHash: 'a'.repeat(64),
      }),
    ).resolves.toEqual({ enqueued: false })
  })

  it('rejects malformed frozen identity before opening a queue connection', async () => {
    await expect(
      enqueueEvaluationRun(
        { tenantId: 'tenant', venueId: 'venue', runId: 'bad', runIdentityHash: 'bad' },
        { enabled: true },
      ),
    ).rejects.toThrow('lowercase identity hash')
  })
})
