import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminIntakeOperationsRouter } from './intake-operations'

const venueFindFirst = vi.fn()
const runFindMany = vi.fn()
const runFindFirst = vi.fn()
const runCreate = vi.fn()
const eventCreate = vi.fn()
const db = {
  venue: { findFirst: venueFindFirst },
  intakeRun: { findMany: runFindMany, findFirst: runFindFirst, create: runCreate },
  intakeRunEvent: { create: eventCreate },
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
} as unknown as TRPCContext['db']

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId: 'platform-admin', activeTenantId: null, role: null, isPlatformAdmin },
  }
}

const testRouter = router({ operations: adminIntakeOperationsRouter })

describe('platform admin intake operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    venueFindFirst.mockResolvedValue({ id: 'venue-a' })
    runFindMany.mockResolvedValue([])
    runFindFirst.mockResolvedValue({ id: 'run-1' })
    runCreate.mockResolvedValue({
      id: 'run-1',
      venueId: 'venue-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      displayName: 'Site',
      createdAt: new Date(),
    })
  })

  it('blocks non-admin callers before database access', async () => {
    await expect(
      testRouter
        .createCaller(context(false))
        .operations.listIntakeProposals({ tenantId: 'tenant-a', venueId: 'venue-a' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(venueFindFirst).not.toHaveBeenCalled()
  })

  it('rejects a cross-tenant venue before reading intake rows', async () => {
    venueFindFirst.mockResolvedValue(null)
    await expect(
      testRouter
        .createCaller(context())
        .operations.listIntakeProposals({ tenantId: 'tenant-a', venueId: 'venue-b' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue-b', tenantId: 'tenant-a' },
      select: { id: true },
    })
    expect(runFindMany).not.toHaveBeenCalled()
  })

  it('uses the canonical action with exact scope and remains draft-only', async () => {
    const result = await testRouter.createCaller(context()).operations.createIntakeProposal({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      kind: 'WEBSITE',
      displayName: 'Site',
      websiteUri: 'https://example.com',
    })
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          status: 'AWAITING_REVIEW',
          requestedBy: 'platform-admin',
        }),
      }),
    )
    expect(result).toMatchObject({ autoApprove: false, autoApply: false })
  })

  it('exposes private onboarding payload only through exact platform review scope', async () => {
    runFindMany.mockResolvedValue([
      {
        id: 'run-1',
        venueId: 'venue-a',
        status: 'AWAITING_REVIEW',
        displayName: 'Museum onboarding information',
        structuredBootstrap: { version: 1, content: { kind: 'knowledge' } },
        createdAt: new Date(),
      },
    ])
    const result = await testRouter
      .createCaller(context())
      .operations.listOnboardingBootstrapDetails({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        limit: 10,
      })
    expect(runFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          sourceKind: 'STRUCTURED_BOOTSTRAP',
        },
      }),
    )
    expect(result[0]?.structuredBootstrap).toEqual({
      version: 1,
      content: { kind: 'knowledge' },
    })
  })
})
