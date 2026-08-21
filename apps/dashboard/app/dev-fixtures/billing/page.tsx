import { notFound } from 'next/navigation'

import {
  AdminBillingView,
  type AdminBillingState,
} from '../../../components/admin/AdminBillingView'
import { type ClientBillingState } from '../../../components/billing/ClientBillingView'
import { InteractiveClientBillingFixture } from './InteractiveClientBillingFixture'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Torchiko billing browser fixture' }

const states = [
  'loading',
  'empty',
  'pending',
  'active',
  'past_due',
  'grace',
  'canceled',
  'manual',
  'complimentary',
] as const
type State = (typeof states)[number]
type Props = { searchParams: Promise<{ surface?: string; state?: string }> }

export default async function BillingFixturePage({ searchParams }: Props) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const query = await searchParams
  const state: State = states.includes(query.state as State) ? (query.state as State) : 'grace'
  const surface = query.surface === 'admin' ? 'admin' : 'client'
  const clientBilling = {
    planName: 'Torchiko Pilot Test',
    arrangementLabel: 'Stripe test subscription',
    amountLabel: '$25.00',
    intervalLabel: 'per month',
    statusDetail:
      state === 'grace'
        ? 'The latest payment failed. Venue access continues through August 27 while payment is recovered.'
        : 'This deterministic fixture contains no customer or provider data.',
    nextBillingLabel: 'September 20, 2026',
    paidThroughLabel: 'August 27, 2026',
    coveredVenues: [
      { id: 'venue-1', name: 'Museum of Tiny Fixtures' },
      { id: 'venue-2', name: 'Fixture Sculpture Garden' },
    ],
    invoices: [
      {
        id: 'invoice-1',
        number: 'TST-0001',
        statusLabel: state === 'past_due' || state === 'grace' ? 'open · payment failed' : 'paid',
        amountLabel: '$50.00',
        dateLabel: 'August 20, 2026',
        documentUrl: 'https://example.invalid/test-invoice',
      },
    ],
    canStartCheckout: state === 'pending',
    canRetryCheckout: state === 'past_due' || state === 'grace',
    canManageBilling: state === 'active',
    canCancel: state === 'active',
    cancellationPending: state === 'canceled',
    addOns: [
      {
        key: 'premium-voice',
        label: 'Premium voice mode',
        description: 'Natural voice conversations for visitors.',
        interested: false,
      },
    ],
    supportUrl: '/support',
  }
  const adminBilling = {
    tenant: { id: 'tenant-fixture', name: 'Museum of Tiny Fixtures' },
    billingModeLabel:
      state === 'manual'
        ? 'manual invoice'
        : state === 'complimentary'
          ? 'complimentary'
          : 'Stripe test subscription',
    planName: 'torchiko_pilot_test',
    amountLabel: '$50.00',
    intervalLabel: 'per month',
    subscriptionStatusLabel: state.replaceAll('_', ' '),
    entitlementStatusLabel: state === 'grace' ? 'Active · grace period' : 'Active',
    statusDetail:
      'Synthetic, development-only billing evidence for responsive and accessibility review.',
    currentPeriodLabel: 'Aug 20 – Sep 20, 2026',
    renewalOrCancellationLabel: state === 'canceled' ? 'Ends Sep 20, 2026' : 'Renews Sep 20, 2026',
    minimumCommitmentLabel: 'Through Nov 20, 2026',
    coveredVenues: [
      { id: 'venue-1', name: 'Museum of Tiny Fixtures', coverageLabel: 'Base arrangement' },
      { id: 'venue-2', name: 'Fixture Sculpture Garden', coverageLabel: 'Base arrangement' },
    ],
    provider: {
      customerId: 'cus_TEST_FIXTURE',
      customerDashboardUrl: 'https://dashboard.stripe.com/test/customers/cus_TEST_FIXTURE',
      subscriptionId: 'sub_TEST_FIXTURE',
      subscriptionDashboardUrl: 'https://dashboard.stripe.com/test/subscriptions/sub_TEST_FIXTURE',
    },
    invoices: [
      {
        id: 'invoice-1',
        number: 'TST-0001',
        statusLabel: state === 'grace' ? 'open' : 'paid',
        amountLabel: '$50.00',
        dateLabel: 'Aug 20, 2026',
        failureSummary: state === 'grace' ? 'The test payment did not complete.' : null,
        documentUrl: 'https://example.invalid/test-invoice',
      },
    ],
    override:
      state === 'manual'
        ? {
            label: 'Platform admin grant',
            reason: 'Approved fixture demonstration',
            expiresLabel: 'Aug 27, 2026',
          }
        : null,
    reconciliation: {
      statusLabel: state === 'grace' ? 'drift' : 'current',
      lastCheckedLabel: 'Aug 20, 2026',
      detail:
        state === 'grace'
          ? 'A reconciliation warning needs operator review.'
          : 'Local projection matches the test provider.',
      warning: state === 'grace',
    },
    timeline: [
      {
        id: 'event-1',
        occurredAtLabel: 'Aug 20, 2026, 2:00 PM',
        title: 'invoice.payment_failed',
        detail: 'Applied; grace period started',
        actorLabel: 'Verified Stripe event',
      },
    ],
    recoveryActions: [
      {
        id: 'reconcile',
        label: 'Reconcile with Stripe',
        description: 'Retrieve current test-mode state and repair drift.',
      },
    ],
  }
  return (
    <main className="min-h-screen bg-pf-surface px-4 py-8 text-pf-deep sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Development-only visual fixture
        </p>
        <h1 className="mt-2 text-3xl font-semibold">
          {surface === 'admin' ? 'Operator' : 'Client'} billing · {state.replaceAll('_', ' ')}
        </h1>
        <nav aria-label="Billing fixture states" className="my-6 flex flex-wrap gap-2">
          {states.map((item) => (
            <a
              key={item}
              href={`/dev-fixtures/billing?surface=${surface}&state=${item}`}
              className="inline-flex min-h-11 items-center rounded-full border border-pf-light bg-white px-3 text-xs font-semibold capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
            >
              {item.replaceAll('_', ' ')}
            </a>
          ))}
          <a
            href={`/dev-fixtures/billing?surface=${surface === 'admin' ? 'client' : 'admin'}&state=${state}`}
            className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-4 text-xs font-semibold text-white"
          >
            Switch surface
          </a>
        </nav>
        <section className="rounded-3xl border border-pf-light bg-white p-4 shadow-sm sm:p-7">
          {surface === 'admin' ? (
            <AdminBillingView
              state={state as AdminBillingState}
              billing={state === 'loading' || state === 'empty' ? null : adminBilling}
            />
          ) : (
            <InteractiveClientBillingFixture
              state={state as ClientBillingState}
              billing={state === 'loading' || state === 'empty' ? null : clientBilling}
              reconciliationWarning={
                state === 'grace' ? 'Provider reconciliation is in progress.' : null
              }
            />
          )}
        </section>
      </div>
    </main>
  )
}
