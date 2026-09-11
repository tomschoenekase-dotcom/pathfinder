import { describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'test' },
  isFeatureEnabled: () => false,
}))

import {
  processIntakeV1FileExtractionJob,
  reconcileIntakeV1FileExtractionJobs,
  type IntakeV1FileExtractionDependencies,
} from './intake-v1-file-extraction'

const dispatch = {
  id: 'dispatch_1',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  revisionId: 'revision_1',
  memberId: 'member_1',
  intakeRunId: 'run_1',
  uploadId: 'upload_1',
  operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceHash: 'a'.repeat(64),
  policyVersion: 'intake-v1-file-extraction-v1',
  attempts: 1,
  leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}

function dependencies(
  overrides: Partial<IntakeV1FileExtractionDependencies> = {},
): IntakeV1FileExtractionDependencies {
  return {
    claim: vi.fn(async () => dispatch),
    preflight: vi.fn(async () => ({ state: 'EXECUTE' as const, dispatch })),
    execute: vi.fn(async () => ({
      receiptId: dispatch.operationId,
      outcome: 'SUCCEEDED' as const,
      createdAt: new Date('2026-09-08T12:00:00Z'),
      replayed: false,
      reviewRequired: true,
      packageDraftCreated: false as const,
      autoApproved: false as const,
      autoApplied: false as const,
      autoPublished: false as const,
    })),
    complete: vi.fn(async () => ({ status: 'COMPLETED' as const })),
    fail: vi.fn(async () => ({ status: 'PENDING' as const })),
    listPending: vi.fn(async () => []),
    enqueue: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('V1 file extraction processor', () => {
  it('does no durable or storage work while disabled', async () => {
    const deps = dependencies()
    await expect(
      processIntakeV1FileExtractionJob({ dispatchId: dispatch.id }, 'worker_1', deps, {
        enabled: false,
      }),
    ).resolves.toBe('disabled')
    await expect(reconcileIntakeV1FileExtractionJobs(deps, { enabled: false })).resolves.toEqual({
      discovered: 0,
    })
    expect(deps.claim).not.toHaveBeenCalled()
    expect(deps.listPending).not.toHaveBeenCalled()
  })

  it('preflights exact authority immediately before fixed-operation extraction', async () => {
    const deps = dependencies()
    await expect(
      processIntakeV1FileExtractionJob({ dispatchId: dispatch.id }, 'worker_1', deps, {
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
      policyVersion: 'intake-v1-file-extraction-v1',
    })
    expect(deps.execute).toHaveBeenCalledWith({
      tenantId: dispatch.tenantId,
      venueId: dispatch.venueId,
      runId: dispatch.intakeRunId,
      operationId: dispatch.operationId,
      createdBy: `intake-v1-file:${dispatch.id}`,
      fileDispatchLease: {
        id: dispatch.id,
        tenantId: dispatch.tenantId,
        venueId: dispatch.venueId,
        operationId: dispatch.operationId,
        leaseToken: dispatch.leaseToken,
        sourceHash: dispatch.sourceHash,
      },
    })
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({ receiptId: dispatch.operationId, leaseToken: dispatch.leaseToken }),
    )
  })

  it('fails closed before storage for an unknown policy', async () => {
    const deps = dependencies({
      claim: vi.fn(async () => ({ ...dispatch, policyVersion: 'unknown' })),
    })
    await expect(
      processIntakeV1FileExtractionJob({ dispatchId: dispatch.id }, 'worker_1', deps, {
        enabled: true,
      }),
    ).resolves.toBe('retry-pending')
    expect(deps.preflight).not.toHaveBeenCalled()
    expect(deps.execute).not.toHaveBeenCalled()
  })

  it('recovers an inherited canonical receipt without reading storage again', async () => {
    const deps = dependencies({
      preflight: vi.fn(async () => ({
        state: 'INHERITED' as const,
        dispatch: { status: 'COMPLETED' },
      })),
    })
    await expect(
      processIntakeV1FileExtractionJob({ dispatchId: dispatch.id }, 'worker_1', deps, {
        enabled: true,
      }),
    ).resolves.toBe('completed')
    expect(deps.execute).not.toHaveBeenCalled()
  })

  it('returns uncertain service failure to the bounded durable retry lifecycle', async () => {
    const deps = dependencies({ execute: vi.fn(async () => Promise.reject(new Error('storage'))) })
    await expect(
      processIntakeV1FileExtractionJob({ dispatchId: dispatch.id }, 'worker_1', deps, {
        enabled: true,
      }),
    ).resolves.toBe('retry-pending')
    expect(deps.fail).toHaveBeenCalledOnce()
  })

  it.each([
    ['COMPLETED', 'completed'],
    ['HELD', 'held'],
  ] as const)(
    'recovers a canonical %s receipt when final-attempt execution throws after commit',
    async (status, expected) => {
      const finalAttempt = { ...dispatch, attempts: 3 }
      const deps = dependencies({
        claim: vi.fn(async () => finalAttempt),
        preflight: vi.fn(async () => ({ state: 'EXECUTE' as const, dispatch: finalAttempt })),
        execute: vi.fn(async () => Promise.reject(new Error('result lost after commit'))),
        fail: vi.fn(async () => ({ status })),
      })
      await expect(
        processIntakeV1FileExtractionJob({ dispatchId: dispatch.id }, 'worker_1', deps, {
          enabled: true,
        }),
      ).resolves.toBe(expected)
      expect(deps.fail).toHaveBeenCalledOnce()
    },
  )

  it('reconciles only opaque pending dispatch identities', async () => {
    const deps = dependencies({
      listPending: vi.fn(async () => [{ id: 'dispatch_1' }, { id: 'dispatch_2' }]),
    })
    await expect(reconcileIntakeV1FileExtractionJobs(deps, { enabled: true })).resolves.toEqual({
      discovered: 2,
    })
    expect(deps.listPending).toHaveBeenCalledWith(25)
    expect(deps.enqueue).toHaveBeenNthCalledWith(1, 'dispatch_1')
    expect(deps.enqueue).toHaveBeenNthCalledWith(2, 'dispatch_2')
  })
})
