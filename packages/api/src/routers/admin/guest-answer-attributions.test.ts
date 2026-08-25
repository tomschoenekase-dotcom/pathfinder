import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  findMany: vi.fn(),
  bypass: vi.fn(async (callback: () => unknown) => callback()),
}))

vi.mock('@pathfinder/db', () => ({
  db: { guestAnswerAttribution: { findMany: mocks.findMany } },
  GuestAnswerAttributionActionError: class GuestAnswerAttributionActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  recordHumanReviewedGuestAnswerAttributionAction: mocks.record,
  withTenantIsolationBypass: mocks.bypass,
}))

import { adminGuestAnswerAttributionsRouter } from './guest-answer-attributions'

const caller = adminGuestAnswerAttributionsRouter.createCaller({
  session: {
    userId: 'admin-1',
    role: 'PLATFORM_ADMIN',
    activeTenantId: null,
    isPlatformAdmin: true,
  },
} as never)

describe('admin guest answer attributions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.record.mockResolvedValue({ attribution: { id: 'attribution-1' }, replayed: false })
    mocks.findMany.mockResolvedValue([])
  })

  it('binds human review identity and exact scope to the canonical action', async () => {
    await caller.recordHumanReviewedGuestAnswerAttribution({
      operationId: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      guestChatTurnId: '22222222-2222-4222-8222-222222222222',
      evaluator: {
        provider: 'human-review',
        model: 'platform-admin',
        configurationVersion: 'review-form-v1',
        promptVersion: 'claim-rubric-v1',
      },
      claims: [],
    })

    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        guestChatTurnId: '22222222-2222-4222-8222-222222222222',
        actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
      }),
      expect.anything(),
    )
  })

  it('returns a bounded tenant-and-venue scoped evidence list', async () => {
    await caller.listGuestAnswerAttributions({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      guestChatTurnId: '22222222-2222-4222-8222-222222222222',
      limit: 10,
    })

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          guestChatTurnId: '22222222-2222-4222-8222-222222222222',
        },
        take: 10,
      }),
    )
  })
})
