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
    expect(screen.getAllByText('$85.00')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Harbor Museum' }).getAttribute('href')).toBe(
      '/admin/clients/tenant-1/billing',
    )
    expect(
      screen.getByRole('link', { name: 'CRM: Harbor Museum Foundation' }).getAttribute('href'),
    ).toBe('/admin/prospects/prospect-1')
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
})
