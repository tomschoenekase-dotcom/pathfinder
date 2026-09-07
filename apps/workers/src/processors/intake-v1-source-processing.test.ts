import { describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'test' },
  isFeatureEnabled: () => false,
}))

import type { LeasedIntakeV1ProcessingDispatch } from '@pathfinder/db'

import {
  processIntakeV1SourceProcessingJob,
  reconcileIntakeV1SourceProcessingJobs,
  type IntakeV1SourceProcessingDependencies,
} from './intake-v1-source-processing'

const dispatch: LeasedIntakeV1ProcessingDispatch = {
  id: 'dispatch_1',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  revisionId: 'revision_1',
  memberId: 'member_1',
  intakeRunId: 'run_1',
  operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceHash: 'a'.repeat(64),
  policyVersion: 'intake-v1-processing-v1',
  attempts: 1,
  leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}

function dependencies(
  overrides: Partial<IntakeV1SourceProcessingDependencies> = {},
): IntakeV1SourceProcessingDependencies {
  return {
    claim: vi.fn(async () => dispatch),
    preflight: vi.fn(async () => ({ state: 'EXECUTE' as const, dispatch })),
    execute: vi.fn(async () => ({ receiptId: dispatch.operationId, outcome: 'SUCCEEDED' })),
    complete: vi.fn(async () => ({ status: 'COMPLETED' as const })),
    hold: vi.fn(async () => ({ status: 'HELD' as const })),
    fail: vi.fn(async () => ({ status: 'PENDING' as const })),
    listPending: vi.fn(async () => []),
    enqueue: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('V1 source processing', () => {
  it('does not claim or scan durable work while the explicit worker gate is closed', async () => {
    const deps = dependencies()
    await expect(
      processIntakeV1SourceProcessingJob({ dispatchId: dispatch.id }, 'worker_1', deps, {
        enabled: false,
      }),
    ).resolves.toBe('disabled')
    await expect(reconcileIntakeV1SourceProcessingJobs(deps, { enabled: false })).resolves.toEqual({
      discovered: 0,
    })
    expect(deps.claim).not.toHaveBeenCalled()
    expect(deps.listPending).not.toHaveBeenCalled()
  })

  it('revalidates the lease, frozen source, and fixed policy immediately before website execution', async () => {
    const deps = dependencies()
    await expect(
      processIntakeV1SourceProcessingJob({ dispatchId: dispatch.id }, 'worker_1', deps, {
        enabled: true,
      }),
    ).resolves.toBe('completed')
    expect(deps.preflight).toHaveBeenCalledWith({
      id: dispatch.id,
      tenantId: dispatch.tenantId,
      venueId: dispatch.venueId,
      operationId: dispatch.operationId,
      leaseToken: dispatch.leaseToken,
      sourceHash: dispatch.sourceHash,
      policyVersion: 'intake-v1-processing-v1',
    })
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: dispatch.operationId,
        runId: dispatch.intakeRunId,
        maxPages: 4,
        maxDepth: 1,
        maxBytesPerPage: 1_000_000,
        maxDurationMs: 30_000,
        maxCostUnits: 8,
      }),
    )
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({ receiptId: dispatch.operationId, leaseToken: dispatch.leaseToken }),
    )
  })

  it('fails closed before network when the policy is not the fixed server policy', async () => {
    const deps = dependencies({
      claim: vi.fn(async () => ({ ...dispatch, policyVersion: 'unknown' })),
    })
    await expect(
      processIntakeV1SourceProcessingJob({ dispatchId: dispatch.id }, 'worker_1', deps, {
        enabled: true,
      }),
    ).resolves.toBe('retry-pending')
    expect(deps.preflight).not.toHaveBeenCalled()
    expect(deps.execute).not.toHaveBeenCalled()
    expect(deps.fail).toHaveBeenCalledOnce()
  })

  it('holds a persisted inaccessible or failed service receipt instead of retrying it', async () => {
    const deps = dependencies({
      execute: vi.fn(async () => ({ receiptId: dispatch.operationId, outcome: 'INACCESSIBLE' })),
    })
    await expect(
      processIntakeV1SourceProcessingJob({ dispatchId: dispatch.id }, 'worker_1', deps, {
        enabled: true,
      }),
    ).resolves.toBe('held')
    expect(deps.hold).toHaveBeenCalledWith(expect.objectContaining({ reason: 'INACCESSIBLE' }))
    expect(deps.fail).not.toHaveBeenCalled()
  })

  it('returns infrastructure failures to the canonical bounded retry lifecycle without throwing BullMQ work again', async () => {
    const deps = dependencies({
      execute: vi.fn(async () => Promise.reject(new Error('transport'))),
    })
    await expect(
      processIntakeV1SourceProcessingJob({ dispatchId: dispatch.id }, 'worker_1', deps, {
        enabled: true,
      }),
    ).resolves.toBe('retry-pending')
    expect(deps.fail).toHaveBeenCalledOnce()
  })

  it.each([
    ['COMPLETED', 'completed'],
    ['HELD', 'held'],
  ] as const)(
    'does not execute when the fresh database preflight inherits a %s canonical receipt',
    async (status, expected) => {
      const deps = dependencies({
        preflight: vi.fn(async () => ({ state: 'INHERITED' as const, dispatch: { status } })),
      })
      await expect(
        processIntakeV1SourceProcessingJob({ dispatchId: dispatch.id }, 'worker_1', deps, {
          enabled: true,
        }),
      ).resolves.toBe(expected)
      expect(deps.execute).not.toHaveBeenCalled()
    },
  )

  it('reconciles at most 25 durable pending or expired-lease identities without carrying scope in jobs', async () => {
    const deps = dependencies({
      listPending: vi.fn(async () => [{ id: 'dispatch_1' }, { id: 'dispatch_2' }]),
    })
    await expect(reconcileIntakeV1SourceProcessingJobs(deps, { enabled: true })).resolves.toEqual({
      discovered: 2,
    })
    expect(deps.listPending).toHaveBeenCalledWith(25)
    expect(deps.enqueue).toHaveBeenNthCalledWith(1, 'dispatch_1')
    expect(deps.enqueue).toHaveBeenNthCalledWith(2, 'dispatch_2')
  })
})
