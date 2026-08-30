/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

import { AdminBillingPortfolio } from './AdminBillingPortfolio'

const row = {
  id: 'account-1',
  tenantId: 'tenant-1',
  displayNameSnapshot: 'Harbor Museum',
  billingEmail: 'billing@example.test',
  billingMode: 'STRIPE_SUBSCRIPTION',
  currency: 'usd',
  status: 'ACTIVE',
  paidThroughAt: new Date('2026-09-20T00:00:00.000Z'),
  gracePeriodEndsAt: null,
  reconciliationHealth: 'CURRENT',
  lastReconciledAt: new Date('2026-08-20T12:00:00.000Z'),
  updatedAt: new Date('2026-08-20T12:00:00.000Z'),
  tenant: { id: 'tenant-1', name: 'Harbor Museum', status: 'ACTIVE' },
  crmOrganization: { id: 'prospect-1', canonicalName: 'Harbor Museum Foundation' },
  needsAttention: false,
  paymentRecovery: {
    state: 'NOT_REQUIRED',
    reviewRequired: false,
    policy: {
      relationshipPreserving: true as const,
      automaticRestrictionAuthorized: false as const,
      automaticCustomerContactAuthorized: false as const,
      graceAndCutoffPolicy: 'UNRESOLVED' as const,
    },
    timing: {
      delinquentSince: null,
      daysDelinquent: null,
      nextRetryAt: null,
      gracePeriodEndsAt: null,
      graceState: 'NOT_APPLICABLE',
    },
    financialExposure: {
      receivableAtRiskByCurrency: [],
      ongoingVariableCost: null,
      complete: false,
    },
    relationship: {
      organizationId: 'prospect-1',
      organizationName: 'Harbor Museum Foundation',
      relationshipTier: 'HIGH_TOUCH',
      relationshipStartedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    missingEvidence: ['ONGOING_VARIABLE_COST', 'PRIOR_COMMUNICATION'],
    recommendedNextStep: 'No payment-recovery action is indicated by the current billing state.',
  },
  agreement: {
    id: 'agreement-1',
    internalPlanKey: 'negotiated',
    status: 'ACTIVE',
    billingMode: 'STRIPE_SUBSCRIPTION',
    billingInterval: 'MONTH',
    agreedAmountMinor: 8500n,
    currency: 'usd',
    currentPeriodEndsAt: new Date('2026-09-20T00:00:00.000Z'),
    cancelAtPeriodEnd: false,
    coveredVenueCount: 1,
  },
  latestInvoices: [
    {
      id: 'invoice-1',
      status: 'PAID',
      amountDueMinor: 8500n,
      amountPaidMinor: 8500n,
      currency: 'usd',
      dueAt: null,
      paidAt: new Date('2026-08-20T12:00:00.000Z'),
      failedAt: null,
      failureSummary: null,
    },
  ],
}

describe('AdminBillingPortfolio', () => {
  afterEach(cleanup)

  it('joins payment health to both the customer workspace and CRM organization', () => {
    render(
      <AdminBillingPortfolio
        data={{
          rows: [row],
          bounded: false,
          summary: {
            customers: 1,
            attention: 0,
            pastDue: 0,
            unhealthy: 0,
          },
        }}
      />,
    )
    expect(screen.getAllByText('$85.00')).toHaveLength(4)
    expect(
      screen
        .getAllByRole('link', { name: 'Harbor Museum' })
        .every((link) => link.getAttribute('href') === '/admin/clients/tenant-1/billing'),
    ).toBe(true)
    expect(
      screen
        .getAllByRole('link', { name: 'CRM: Harbor Museum Foundation' })
        .every((link) => link.getAttribute('href') === '/admin/prospects/prospect-1'),
    ).toBe(true)
    expect(document.body.textContent).not.toContain('cus_')
    expect(document.body.textContent).not.toContain('sk_')
  })

  it('renders a useful empty filtered state', () => {
    render(
      <AdminBillingPortfolio
        data={{
          rows: [],
          bounded: false,
          summary: {
            customers: 0,
            attention: 0,
            pastDue: 0,
            unhealthy: 0,
          },
        }}
        attentionOnly
      />,
    )
    expect(screen.getByText('No matching billing accounts')).toBeTruthy()
  })

  it('has no automated accessibility violations in the dense CRM-linked state', async () => {
    const { container } = render(
      <AdminBillingPortfolio
        data={{
          rows: [row],
          bounded: false,
          summary: { customers: 1, attention: 0, pastDue: 0, unhealthy: 0 },
        }}
      />,
    )
    document.documentElement.lang = 'en'
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])
  })

  it('shows relationship-preserving recovery evidence without claiming an automatic cutoff', () => {
    render(
      <AdminBillingPortfolio
        data={{
          rows: [
            {
              ...row,
              status: 'PAST_DUE',
              needsAttention: true,
              paymentRecovery: {
                ...row.paymentRecovery,
                state: 'PAYMENT_RECOVERY',
                reviewRequired: true,
                timing: {
                  ...row.paymentRecovery.timing,
                  daysDelinquent: 3,
                  nextRetryAt: new Date('2026-08-24T00:00:00.000Z'),
                  gracePeriodEndsAt: new Date('2026-08-27T00:00:00.000Z'),
                  graceState: 'ACTIVE',
                },
                financialExposure: {
                  ...row.paymentRecovery.financialExposure,
                  receivableAtRiskByCurrency: [{ currency: 'usd', amountMinor: 8500n }],
                },
              },
            },
          ],
          bounded: false,
          summary: { customers: 1, attention: 1, pastDue: 1, unhealthy: 0 },
        }}
      />,
    )
    expect(screen.getAllByText('Relationship-preserving review').length).toBeGreaterThan(0)
    expect(screen.getAllByText('3 days').length).toBeGreaterThan(0)
    expect(
      screen.getAllByText('No automatic cutoff or customer contact is authorized.').length,
    ).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('risk score')
  })
})
