import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  readAgreement: vi.fn(),
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
  readGuestAnswerAttributionAgreement: mocks.readAgreement,
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
    mocks.readAgreement.mockResolvedValue({
      target: 'HUMAN_CLAIM_REVIEW_CALIBRATION',
      reportHash: 'f'.repeat(64),
      invalidRecordCount: 0,
      truncated: false,
      report: {
        independentPairCount: 1,
        metrics: { supportAgreementRate: 1 },
      },
      interpretation: {
        establishesCorrectness: false,
        appliesQualityThreshold: false,
        authorizesRelease: false,
      },
    })
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

  it('returns hashed descriptive agreement for independent human reviewers without a quality verdict', async () => {
    const result = await caller.previewGuestAnswerAttributionAgreement({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })

    expect(result.report.independentPairCount).toBe(1)
    expect(result.report.metrics.supportAgreementRate).toBe(1)
    expect(result.reportHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.interpretation).toEqual({
      establishesCorrectness: false,
      appliesQualityThreshold: false,
      authorizesRelease: false,
    })
    expect(result).not.toHaveProperty('passed')
    expect(mocks.readAgreement).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', venueId: 'venue-1', limit: 100 },
      expect.anything(),
    )
  })

  it('fails closed on malformed snapshots while preserving bounded calibration evidence', async () => {
    mocks.readAgreement.mockResolvedValue({
      target: 'HUMAN_CLAIM_REVIEW_CALIBRATION',
      reportHash: 'f'.repeat(64),
      invalidRecordCount: 1,
      truncated: false,
      report: { inputRecordCount: 0, independentPairCount: 0 },
      interpretation: {
        establishesCorrectness: false,
        appliesQualityThreshold: false,
        authorizesRelease: false,
      },
    })

    const result = await caller.previewGuestAnswerAttributionAgreement({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      limit: 2,
    })

    expect(result.invalidRecordCount).toBe(1)
    expect(result.report.inputRecordCount).toBe(0)
    expect(result.report.independentPairCount).toBe(0)
  })
})
