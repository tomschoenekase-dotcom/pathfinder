import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  record: vi.fn(),
}))

vi.mock('@pathfinder/db', () => {
  class OperatingCostEvidenceActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  }
  return {
    db: {
      aiUsageEvent: { groupBy: vi.fn() },
      operatingCostEvidence: { findMany: vi.fn() },
      operationalUsageEvidence: { findMany: vi.fn(), findFirst: vi.fn() },
    },
    withTenantIsolationBypass: mocks.bypass,
    recordOperatingCostEvidenceAction: mocks.record,
    OperatingCostEvidenceActionError,
  }
})

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminUnitEconomicsRouter } from './unit-economics'

const testRouter = router({ admin: adminUnitEconomicsRouter })

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator-1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

const input = {
  operationId: '11111111-1111-4111-8111-111111111111',
  category: 'INFRASTRUCTURE' as const,
  evidenceKind: 'OBSERVED' as const,
  amountUsd: '12.00',
  periodStart: new Date('2026-08-01T00:00:00.000Z'),
  periodEnd: new Date('2026-08-02T00:00:00.000Z'),
  sourceSystem: 'fixture',
  sourceReference: 'fixture-line',
  description: 'Synthetic cost evidence.',
}

describe('admin unit economics router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.record.mockResolvedValue({ id: 'evidence-1', replayed: false })
  })

  it('rejects non-admin mutation callers before entering the global bypass', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.recordOperatingCostEvidence(input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })

  it('binds accepted evidence to the authenticated platform administrator', async () => {
    await expect(
      testRouter.createCaller(context(true)).admin.recordOperatingCostEvidence(input),
    ).resolves.toEqual({ id: 'evidence-1', replayed: false })
    expect(mocks.record).toHaveBeenCalledWith({
      ...input,
      actor: { type: 'HUMAN', id: 'operator-1', role: 'PLATFORM_ADMIN' },
    })
  })
})
