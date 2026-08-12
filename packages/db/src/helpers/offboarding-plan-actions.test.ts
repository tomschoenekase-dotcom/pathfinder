import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createOffboardingDraftAction,
  type CreateOffboardingDraftInput,
  offboardingDraftRequestHash,
  OffboardingPlanActionError,
} from './offboarding-plan-actions'

const venueFindMany = vi.fn()
const planCreate = vi.fn()
const planFindFirst = vi.fn()
const auditCreate = vi.fn()
const tx = {
  venue: { findMany: venueFindMany },
  offboardingPlan: { create: planCreate, findFirst: planFindFirst },
  auditLog: { create: auditCreate },
  $executeRaw: vi.fn().mockResolvedValue(0),
}
const transaction = vi.fn(async (callback: (transactionClient: typeof tx) => unknown) =>
  callback(tx),
)
const client = { $transaction: transaction }
const actor = { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' } as const
const requestedAt = new Date('2030-01-01T00:00:00.000Z')

function input(): CreateOffboardingDraftInput {
  return {
    tenantId: 'tenant-1',
    requestId: '11111111-1111-4111-8111-111111111111',
    venueIds: ['venue-b', 'venue-a'],
    revocationTargets: ['GUEST_LINKS', 'CLIENT_ACCESS'],
    exportKinds: ['APPROVED_CONTENT'],
    actor,
  }
}

describe('createOffboardingDraftAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    planFindFirst.mockResolvedValue(null)
    venueFindMany.mockResolvedValue([{ id: 'venue-a' }, { id: 'venue-b' }])
    planCreate.mockResolvedValue({
      id: 'plan-1',
      tenantId: 'tenant-1',
      status: 'REQUESTED',
      requestId: '11111111-1111-4111-8111-111111111111',
      requestedAt,
      _count: { venueTargets: 2 },
    })
    auditCreate.mockResolvedValue({ id: 'audit-1' })
  })

  it('creates only requested intent after every venue passes exact tenant scope', async () => {
    await createOffboardingDraftAction(input(), client as never)

    expect(venueFindMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', id: { in: ['venue-a', 'venue-b'] } },
      select: { id: true },
    })
    expect(planCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          tenantId: 'tenant-1',
          requestId: '11111111-1111-4111-8111-111111111111',
          requestHash: offboardingDraftRequestHash(input()),
          status: 'REQUESTED',
          revocationTargets: ['CLIENT_ACCESS', 'GUEST_LINKS'],
          exportKinds: ['APPROVED_CONTENT'],
          requestedBy: 'admin-1',
          venueTargets: {
            create: [
              { tenantId: 'tenant-1', venueId: 'venue-a' },
              { tenantId: 'tenant-1', venueId: 'venue-b' },
            ],
          },
        },
      }),
    )
    expect(planCreate.mock.calls[0]?.[0]?.data).not.toHaveProperty('deletionRequested')
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        actorId: 'admin-1',
        actorRole: 'PLATFORM_ADMIN',
        action: 'offboarding-plan.draft-created',
        targetType: 'OffboardingPlan',
        targetId: 'plan-1',
        afterState: {
          status: 'REQUESTED',
          requestId: '11111111-1111-4111-8111-111111111111',
          venueCount: 2,
          revocationTargets: ['CLIENT_ACCESS', 'GUEST_LINKS'],
          exportKinds: ['APPROVED_CONTENT'],
        },
      },
    })
  })

  it('hashes normalized planning input independently of caller array order', () => {
    const first = input()
    const second = {
      ...input(),
      venueIds: [...first.venueIds].reverse(),
      revocationTargets: [...first.revocationTargets].reverse(),
    }
    expect(offboardingDraftRequestHash(first)).toMatch(/^[0-9a-f]{64}$/u)
    expect(offboardingDraftRequestHash(second)).toBe(offboardingDraftRequestHash(first))
  })

  it('replays the exact request without venue, create, or duplicate audit work', async () => {
    planFindFirst.mockResolvedValue({
      id: 'plan-1',
      tenantId: 'tenant-1',
      requestId: input().requestId,
      requestHash: offboardingDraftRequestHash(input()),
      requestedBy: 'admin-1',
      status: 'REQUESTED',
      requestedAt,
      _count: { venueTargets: 2 },
    })
    await expect(createOffboardingDraftAction(input(), client as never)).resolves.toMatchObject({
      id: 'plan-1',
      replayed: true,
    })
    expect(venueFindMany).not.toHaveBeenCalled()
    expect(planCreate).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it('rejects request-key reuse for different intent or actor', async () => {
    planFindFirst.mockResolvedValue({
      id: 'plan-1',
      tenantId: 'tenant-1',
      requestId: input().requestId,
      requestHash: 'a'.repeat(64),
      requestedBy: 'another-admin',
      status: 'REQUESTED',
      requestedAt,
      _count: { venueTargets: 2 },
    })
    await expect(createOffboardingDraftAction(input(), client as never)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(planCreate).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it('accepts exact venue scope regardless of database return order or collation', async () => {
    venueFindMany.mockResolvedValue([{ id: 'venue-b' }, { id: 'venue-a' }])
    await expect(createOffboardingDraftAction(input(), client as never)).resolves.toMatchObject({
      id: 'plan-1',
    })
  })

  it('rejects a venue from another tenant before creating or auditing', async () => {
    venueFindMany.mockResolvedValue([{ id: 'venue-a' }])
    await expect(createOffboardingDraftAction(input(), client as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<OffboardingPlanActionError>)
    expect(planCreate).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it.each([
    ['venue IDs', { venueIds: ['venue-a', 'venue-a'] }],
    ['revocation targets', { revocationTargets: ['GUEST_LINKS', 'GUEST_LINKS'] }],
    ['export kinds', { exportKinds: ['CONFIGURATION', 'CONFIGURATION'] }],
  ])(
    'rejects duplicate %s deterministically before opening a transaction',
    async (_name, patch) => {
      await expect(
        createOffboardingDraftAction({ ...input(), ...patch } as never, client as never),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(transaction).not.toHaveBeenCalled()
    },
  )

  it('rejects a forged actor and invalid date before data access', async () => {
    await expect(
      createOffboardingDraftAction(
        {
          ...input(),
          actor: { type: 'HUMAN', id: 'tenant-owner', role: 'OWNER' } as never,
          effectiveAt: new Date(Number.NaN),
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('rejects forged enum values at the neutral action boundary', async () => {
    await expect(
      createOffboardingDraftAction(
        { ...input(), revocationTargets: ['DELETE_EVERYTHING'] } as never,
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('propagates strict audit failure so the containing transaction cannot succeed', async () => {
    auditCreate.mockRejectedValue(new Error('audit unavailable'))
    await expect(createOffboardingDraftAction(input(), client as never)).rejects.toThrow(
      'audit unavailable',
    )
  })
})
