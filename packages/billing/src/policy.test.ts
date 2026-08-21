import { describe, expect, it } from 'vitest'

import { customerPortalPolicy, evaluateBillingAccess } from './policy'

const now = new Date('2026-08-20T12:00:00.000Z')

describe('evaluateBillingAccess', () => {
  it.each([
    [
      'pending checkout',
      { billingMode: 'STRIPE_SUBSCRIPTION', arrangementStatus: 'PENDING' },
      'PENDING',
      false,
    ],
    [
      'active subscription',
      {
        billingMode: 'STRIPE_SUBSCRIPTION',
        arrangementStatus: 'ACTIVE',
        providerSubscriptionStatus: 'ACTIVE',
      },
      'ACTIVE',
      true,
    ],
    [
      'failed payment in grace',
      {
        billingMode: 'STRIPE_SUBSCRIPTION',
        arrangementStatus: 'PAST_DUE',
        providerSubscriptionStatus: 'PAST_DUE',
        graceEndsAt: new Date('2026-08-25T00:00:00.000Z'),
      },
      'GRACE_PERIOD',
      true,
    ],
    [
      'failed payment after grace',
      {
        billingMode: 'STRIPE_SUBSCRIPTION',
        arrangementStatus: 'PAST_DUE',
        providerSubscriptionStatus: 'PAST_DUE',
        graceEndsAt: new Date('2026-08-19T00:00:00.000Z'),
      },
      'SUSPENDED',
      false,
    ],
    [
      'canceled but paid through',
      {
        billingMode: 'STRIPE_SUBSCRIPTION',
        arrangementStatus: 'ACTIVE',
        cancelAtPeriodEnd: true,
        paidThrough: new Date('2026-09-01T00:00:00.000Z'),
      },
      'PAID_THROUGH',
      true,
    ],
    [
      'manual invoice current',
      { billingMode: 'MANUAL_INVOICE', arrangementStatus: 'ACTIVE' },
      'ACTIVE',
      true,
    ],
    [
      'complimentary expired',
      {
        billingMode: 'COMPLIMENTARY',
        arrangementStatus: 'ACTIVE',
        accessEndsAt: new Date('2026-08-19T00:00:00.000Z'),
      },
      'ENDED',
      false,
    ],
  ] as const)('%s', (_name, input, state, enabled) => {
    expect(evaluateBillingAccess({ ...input, now })).toMatchObject({
      state,
      entitlementsActive: enabled,
    })
  })

  it('uses only a reasoned, unexpired override', () => {
    expect(
      evaluateBillingAccess({
        billingMode: 'STRIPE_SUBSCRIPTION',
        arrangementStatus: 'UNPAID',
        override: {
          grantsAccess: true,
          reason: 'Approved recovery window',
          expiresAt: new Date('2026-08-21T00:00:00Z'),
        },
        now,
      }),
    ).toMatchObject({ state: 'ACTIVE', source: 'OVERRIDE', entitlementsActive: true })
  })

  it('suspends disputed access for manual review', () => {
    expect(
      evaluateBillingAccess({
        billingMode: 'STRIPE_SUBSCRIPTION',
        arrangementStatus: 'ACTIVE',
        disputeOpen: true,
        now,
      }),
    ).toMatchObject({ state: 'MANUAL_REVIEW', entitlementsActive: false })
  })
})

describe('customerPortalPolicy', () => {
  it('requires support while a minimum commitment is active', () => {
    expect(
      customerPortalPolicy({
        minimumCommitmentEndsAt: new Date('2027-01-01T00:00:00.000Z'),
        planChangesEnabled: true,
        now,
      }),
    ).toEqual({
      minimumTermActive: true,
      allowPortal: true,
      allowCancellation: false,
      allowPlanChanges: false,
      supportRequired: true,
    })
  })
})
