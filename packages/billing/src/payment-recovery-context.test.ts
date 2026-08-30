import { describe, expect, it } from 'vitest'

import { buildPaymentRecoveryContext } from './payment-recovery-context'

const now = new Date('2026-08-23T12:00:00.000Z')

describe('payment recovery context', () => {
  it('preserves relationship and receivable evidence without inventing a cutoff or loss total', () => {
    const result = buildPaymentRecoveryContext({
      accountStatus: 'PAST_DUE',
      gracePeriodEndsAt: new Date('2026-08-27T12:00:00.000Z'),
      agreement: {
        agreedAmountMinor: 5000n,
        currency: 'USD',
        billingInterval: 'MONTH',
        billingIntervalCount: 1,
      },
      invoices: [
        {
          status: 'OPEN',
          amountRemainingMinor: 5000n,
          currency: 'USD',
          failedAt: new Date('2026-08-20T12:00:00.000Z'),
          nextRetryAt: new Date('2026-08-24T12:00:00.000Z'),
        },
      ],
      relationship: {
        organizationId: 'organization-1',
        organizationName: 'Harbor Museum',
        relationshipTier: 'STRATEGIC',
        relationshipStartedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      now,
    })

    expect(result).toMatchObject({
      schemaVersion: 'torchiko-payment-recovery-context-v1',
      state: 'PAYMENT_RECOVERY',
      reviewRequired: true,
      policy: {
        relationshipPreserving: true,
        automaticRestrictionAuthorized: false,
        automaticCustomerContactAuthorized: false,
        graceAndCutoffPolicy: 'UNRESOLVED',
      },
      timing: { daysDelinquent: 3, graceState: 'ACTIVE' },
      accountValue: {
        amountMinor: 5000n,
        currency: 'usd',
        interval: 'MONTH',
      },
      financialExposure: {
        receivableAtRiskByCurrency: [{ currency: 'usd', amountMinor: 5000n }],
        ongoingVariableCost: null,
        complete: false,
      },
      missingEvidence: ['ONGOING_VARIABLE_COST', 'PRIOR_COMMUNICATION'],
    })
    expect(result).not.toHaveProperty('automaticCutoffAt')
    expect(result).not.toHaveProperty('riskScore')
  })

  it('groups only unpaid receivables and keeps unknown evidence explicit', () => {
    const result = buildPaymentRecoveryContext({
      accountStatus: 'UNPAID',
      agreement: null,
      invoices: [
        {
          status: 'OPEN',
          amountRemainingMinor: 3000n,
          currency: 'usd',
          dueAt: new Date('2026-08-18T12:00:00.000Z'),
        },
        {
          status: 'UNCOLLECTIBLE',
          amountRemainingMinor: 2000n,
          currency: 'USD',
          failedAt: new Date('2026-08-19T12:00:00.000Z'),
        },
        {
          status: 'PAID',
          amountRemainingMinor: 0n,
          currency: 'usd',
        },
      ],
      relationship: null,
      now,
    })

    expect(result.state).toBe('UNPAID_REVIEW')
    expect(result.timing).toMatchObject({ daysDelinquent: 5, graceState: 'NOT_RECORDED' })
    expect(result.financialExposure.receivableAtRiskByCurrency).toEqual([
      { currency: 'usd', amountMinor: 5000n },
    ])
    expect(result.missingEvidence).toEqual([
      'ACCOUNT_VALUE',
      'ONGOING_VARIABLE_COST',
      'RELATIONSHIP_CONTEXT',
      'PRIOR_COMMUNICATION',
    ])
  })

  it('does not fabricate a recovery case for a current account', () => {
    const result = buildPaymentRecoveryContext({
      accountStatus: 'ACTIVE',
      agreement: null,
      invoices: [],
      relationship: null,
      now,
    })

    expect(result.state).toBe('NOT_REQUIRED')
    expect(result.reviewRequired).toBe(false)
    expect(result.timing.graceState).toBe('NOT_APPLICABLE')
  })
})
