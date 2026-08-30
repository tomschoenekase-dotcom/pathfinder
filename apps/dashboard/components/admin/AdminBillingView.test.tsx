/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AdminBillingView,
  type AdminBillingState,
  type AdminBillingViewModel,
} from './AdminBillingView'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const billing: AdminBillingViewModel = {
  tenant: { id: 'tenant-1', name: 'Northstar Museums' },
  billingModeLabel: 'Stripe subscription (test mode)',
  planName: 'Torchiko Pilot',
  amountLabel: '$50.00',
  intervalLabel: 'monthly',
  subscriptionStatusLabel: 'Past due — grace period',
  entitlementStatusLabel: 'Active during grace period',
  statusDetail: 'Payment recovery is required; venue access remains available during grace.',
  currentPeriodLabel: 'August 20 – September 20, 2026',
  renewalOrCancellationLabel: 'Renews September 20, 2026',
  minimumCommitmentLabel: 'Through November 20, 2026',
  coveredVenues: [
    {
      id: 'venue-1',
      name: 'Harbor Museum',
      coverageLabel: 'Verified component',
      amountLabel: '$15.00',
    },
    {
      id: 'venue-2',
      name: 'Hill Park',
      coverageLabel: 'Verified component',
      amountLabel: '$10.00',
    },
  ],
  provider: {
    customerId: 'cus_test_123',
    customerDashboardUrl: 'https://dashboard.stripe.com/test/customers/cus_test_123',
    subscriptionId: 'sub_test_123',
    subscriptionDashboardUrl: 'https://dashboard.stripe.com/test/subscriptions/sub_test_123',
  },
  invoices: [
    {
      id: 'in_test_123',
      number: 'TST-0002',
      statusLabel: 'Payment failed',
      amountLabel: '$50.00',
      dateLabel: 'August 20, 2026',
      failureSummary: 'The payment method was declined. Ask the customer to update it.',
      documentUrl: 'https://invoice.example/test',
    },
  ],
  override: {
    label: 'Temporary entitlement grant',
    reason: 'Approved service recovery window',
    expiresLabel: 'August 27, 2026',
  },
  reconciliation: {
    statusLabel: 'Drift detected',
    lastCheckedLabel: 'August 20, 2026 at 2:30 PM',
    detail: 'The local invoice projection is older than the provider subscription.',
    warning: true,
  },
  timeline: [
    {
      id: 'event-1',
      occurredAtLabel: 'August 20, 2026 at 2:25 PM',
      title: 'Payment failed',
      detail: 'Invoice TST-0002 entered payment recovery.',
      actorLabel: 'Stripe test webhook',
    },
    {
      id: 'event-2',
      occurredAtLabel: 'August 20, 2026 at 2:30 PM',
      title: 'Reconciliation requested',
      detail: 'An operator requested a bounded provider comparison.',
      actorLabel: 'Platform admin',
    },
  ],
  recoveryActions: [
    {
      id: 'reconcile',
      label: 'Run reconciliation',
      description: 'Retrieve the current test-mode subscription and repair safe projection drift.',
    },
    {
      id: 'suspend',
      label: 'Suspend paid entitlements',
      description: 'Apply the documented suspension policy without deleting customer data.',
      destructive: true,
    },
  ],
}

describe('AdminBillingView', () => {
  afterEach(cleanup)

  it.each<AdminBillingState>([
    'pending',
    'active',
    'past_due',
    'grace',
    'canceled',
    'manual',
    'complimentary',
  ])('renders the %s projection with readable status and core operational evidence', (state) => {
    render(<AdminBillingView state={state} billing={billing} />)
    expect(screen.getByText('Status: Past due — grace period')).toBeTruthy()
    expect(screen.getByText('Stripe subscription (test mode)')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Billing audit timeline' })).toBeTruthy()
  })

  it('renders loading and empty states without suggesting live billing exists', () => {
    const { rerender } = render(<AdminBillingView state="loading" billing={null} />)
    expect(screen.getByRole('status').textContent).toContain('Loading billing operations')
    rerender(<AdminBillingView state="empty" billing={null} />)
    expect(screen.getByRole('heading', { name: 'No billing account' })).toBeTruthy()
    expect(screen.getByText(/Create an explicit billing arrangement/)).toBeTruthy()
  })

  it('shows provider IDs, safe dashboard links, reconciliation, failures, overrides, and venue coverage', () => {
    render(<AdminBillingView state="grace" billing={billing} />)
    expect(screen.getByText('cus_test_123')).toBeTruthy()
    expect(screen.getByText('sub_test_123')).toBeTruthy()
    expect(screen.getAllByText('Open in Stripe')).toHaveLength(2)
    expect(screen.getByRole('alert').textContent).toContain('Reconciliation warning')
    expect(screen.getByText(/payment method was declined/i)).toBeTruthy()
    expect(screen.getByText('Temporary entitlement grant')).toBeTruthy()
    expect(screen.getByText('Harbor Museum')).toBeTruthy()
    expect(screen.getByText(/Approved service recovery window/)).toBeTruthy()
  })

  it('dispatches only the selected recovery action and preserves disabled controls', () => {
    const onAction = vi.fn()
    render(
      <AdminBillingView
        state="past_due"
        billing={{
          ...billing,
          recoveryActions: [
            ...billing.recoveryActions,
            {
              id: 'unavailable',
              label: 'Unavailable action',
              description: 'This action is not currently allowed.',
              disabled: true,
            },
          ],
        }}
        onAction={onAction}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run reconciliation' }))
    expect(onAction).toHaveBeenCalledWith('reconcile')
    expect(
      screen.getByRole('button', { name: 'Unavailable action' }).hasAttribute('disabled'),
    ).toBe(true)
  })

  it('uses safe new-tab behavior for provider and invoice links', () => {
    render(<AdminBillingView state="active" billing={billing} />)
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noreferrer')
    }
  })

  it('has no automated accessibility violations in the densest warning state', async () => {
    const { container } = render(
      <AdminBillingView state="grace" billing={billing} onAction={vi.fn()} />,
    )
    document.documentElement.lang = 'en'
    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(result.violations).toEqual([])
  })
})
