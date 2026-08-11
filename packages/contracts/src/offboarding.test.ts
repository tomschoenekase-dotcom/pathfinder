import { describe, expect, it } from 'vitest'

import { OffboardingPlan, OffboardingStep, isOffboardingComplete } from './offboarding'

describe('offboarding contract', () => {
  it('requires evidence before a revocation is complete', () => {
    expect(OffboardingStep.safeParse({ target: 'GUEST_LINKS', status: 'COMPLETE' }).success).toBe(
      false,
    )
  })

  it('does not permit offboarding to become a deletion policy', () => {
    expect(
      OffboardingPlan.safeParse({
        id: 'plan-1',
        tenantId: 'tenant-1',
        venueIds: ['venue-1'],
        status: 'REQUESTED',
        revocations: [{ target: 'CLIENT_ACCESS', status: 'PENDING' }],
        requestedAt: '2026-08-11T20:00:00.000Z',
        deletionRequested: true,
      }).success,
    ).toBe(false)
  })

  it('only reports completion after every target is resolved', () => {
    const plan = OffboardingPlan.parse({
      id: 'plan-1',
      tenantId: 'tenant-1',
      venueIds: ['venue-1'],
      status: 'COMPLETED',
      revocations: [
        {
          target: 'GUEST_LINKS',
          status: 'COMPLETE',
          completedAt: '2026-08-11T20:30:00.000Z',
          evidenceId: 'audit-1',
        },
        { target: 'PARTNER_API_KEYS', status: 'SKIPPED' },
      ],
      requestedAt: '2026-08-11T20:00:00.000Z',
    })
    expect(isOffboardingComplete(plan)).toBe(true)
  })
})
