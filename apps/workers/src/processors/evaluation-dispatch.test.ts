import { describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'test' },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import {
  dispatchStagedEvaluationRuns,
  type EvaluationDispatchDependencies,
} from './evaluation-dispatch'

const staged = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  runId: '11111111-1111-4111-8111-111111111111',
  runIdentityHash: 'a'.repeat(64),
  status: 'STAGED' as const,
  attemptNumber: 0,
  executionLeaseToken: null,
}

function dependencies(
  overrides: Partial<EvaluationDispatchDependencies> = {},
): EvaluationDispatchDependencies {
  return {
    globalEnabled: async () => true,
    listCandidates: async () => [staged],
    tenantEnabled: async () => true,
    markQueued: vi.fn(async () => true),
    enqueue: vi.fn(async () => ({ enqueued: true })),
    ...overrides,
  }
}

describe('evaluation durable dispatcher', () => {
  it('marks STAGED durable state before deterministic publication', async () => {
    const order: string[] = []
    const deps = dependencies({
      markQueued: vi.fn(async () => {
        order.push('queued')
        return true
      }),
      enqueue: vi.fn(async () => {
        order.push('published')
        return { enqueued: true }
      }),
    })
    await expect(dispatchStagedEvaluationRuns(deps)).resolves.toEqual({
      scanned: 1,
      published: 1,
      failed: 0,
    })
    expect(order).toEqual(['queued', 'published'])
  })

  it('reconciles QUEUED state after a publication crash without another transition', async () => {
    const enqueue = vi.fn(async () => ({ enqueued: true }))
    const markQueued = vi.fn()
    await dispatchStagedEvaluationRuns(
      dependencies({
        listCandidates: async () => [{ ...staged, status: 'QUEUED' }],
        enqueue,
        markQueued,
      }),
    )
    expect(markQueued).not.toHaveBeenCalled()
    expect(enqueue).toHaveBeenCalledOnce()
  })

  it('re-publishes an expired RUNNING lease for fenced takeover without re-queue transition', async () => {
    const enqueue = vi.fn(async () => ({ enqueued: true }))
    const markQueued = vi.fn()
    const running = {
      ...staged,
      status: 'RUNNING' as const,
      attemptNumber: 1,
      executionLeaseToken: staged.runId,
    }
    await expect(
      dispatchStagedEvaluationRuns(
        dependencies({
          listCandidates: async () => [running],
          enqueue,
          markQueued,
        }),
      ),
    ).resolves.toEqual({ scanned: 1, published: 1, failed: 0 })
    expect(markQueued).not.toHaveBeenCalled()
    expect(enqueue).toHaveBeenCalledWith(running)
  })

  it('re-publishes RETRY_SCHEDULED from durable state for its next durable attempt', async () => {
    const enqueue = vi.fn(async () => ({ enqueued: true }))
    const retry = { ...staged, status: 'RETRY_SCHEDULED' as const, attemptNumber: 1 }
    await dispatchStagedEvaluationRuns(
      dependencies({ listCandidates: async () => [retry], enqueue }),
    )
    expect(enqueue).toHaveBeenCalledWith(retry)
  })

  it('fails closed without durable global and tenant admission', async () => {
    const listCandidates = vi.fn(async () => [staged])
    await expect(
      dispatchStagedEvaluationRuns(
        dependencies({ globalEnabled: async () => false, listCandidates }),
      ),
    ).resolves.toEqual({ scanned: 0, published: 0, failed: 0 })
    expect(listCandidates).not.toHaveBeenCalled()

    const enqueue = vi.fn()
    await dispatchStagedEvaluationRuns(dependencies({ tenantEnabled: async () => false, enqueue }))
    expect(enqueue).not.toHaveBeenCalled()
  })
})
