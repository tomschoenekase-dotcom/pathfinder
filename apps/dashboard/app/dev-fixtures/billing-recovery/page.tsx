import { notFound } from 'next/navigation'

import { AdminBillingPortfolio } from '../../../components/admin/AdminBillingPortfolio'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Torchiko payment recovery browser fixture' }

export default function BillingRecoveryFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  const failedAt = new Date('2026-08-20T12:00:00.000Z')
  const graceEndsAt = new Date('2026-08-27T12:00:00.000Z')
  return (
    <main className="min-h-screen bg-pf-surface px-4 py-8 text-pf-deep sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Development-only visual fixture
        </p>
        <AdminBillingPortfolio
          data={{
            bounded: false,
            summary: { customers: 1, attention: 1, pastDue: 1, unhealthy: 0 },
            rows: [
              {
                id: 'billing-account-fixture',
                tenantId: 'tenant-fixture',
                displayNameSnapshot: 'Museum of Tiny Fixtures',
                billingEmail: 'billing@example.invalid',
                billingMode: 'STRIPE_SUBSCRIPTION',
                currency: 'usd',
                status: 'PAST_DUE',
                paidThroughAt: null,
                gracePeriodEndsAt: graceEndsAt,
                reconciliationHealth: 'CURRENT',
                lastReconciledAt: new Date('2026-08-23T12:00:00.000Z'),
                updatedAt: new Date('2026-08-23T12:00:00.000Z'),
                tenant: { id: 'tenant-fixture', name: 'Museum of Tiny Fixtures', status: 'ACTIVE' },
                crmOrganization: {
                  id: 'organization-fixture',
                  canonicalName: 'Tiny Fixtures Foundation',
                },
                needsAttention: true,
                paymentRecovery: {
                  state: 'PAYMENT_RECOVERY',
                  reviewRequired: true,
                  policy: {
                    relationshipPreserving: true,
                    automaticRestrictionAuthorized: false,
                    automaticCustomerContactAuthorized: false,
                    graceAndCutoffPolicy: 'UNRESOLVED',
                  },
                  timing: {
                    delinquentSince: failedAt,
                    daysDelinquent: 3,
                    nextRetryAt: new Date('2026-08-24T12:00:00.000Z'),
                    gracePeriodEndsAt: graceEndsAt,
                    graceState: 'ACTIVE',
                  },
                  financialExposure: {
                    receivableAtRiskByCurrency: [{ currency: 'usd', amountMinor: 5000n }],
                    ongoingVariableCost: null,
                    complete: false,
                  },
                  relationship: {
                    organizationId: 'organization-fixture',
                    organizationName: 'Tiny Fixtures Foundation',
                    relationshipTier: 'HIGH_TOUCH',
                    relationshipStartedAt: new Date('2026-01-15T12:00:00.000Z'),
                  },
                  missingEvidence: ['ONGOING_VARIABLE_COST', 'PRIOR_COMMUNICATION'],
                  recommendedNextStep:
                    'Review the durable payment, relationship, cost, and communication evidence before choosing any consequential action.',
                },
                customerRequests: [],
                agreement: {
                  id: 'agreement-fixture',
                  internalPlanKey: 'negotiated',
                  status: 'PAST_DUE',
                  billingMode: 'STRIPE_SUBSCRIPTION',
                  billingInterval: 'MONTH',
                  agreedAmountMinor: 5000n,
                  currency: 'usd',
                  currentPeriodEndsAt: new Date('2026-08-20T12:00:00.000Z'),
                  cancelAtPeriodEnd: false,
                  coveredVenueCount: 2,
                },
                latestInvoices: [
                  {
                    id: 'invoice-fixture',
                    status: 'OPEN',
                    amountDueMinor: 5000n,
                    amountPaidMinor: 0n,
                    currency: 'usd',
                    dueAt: failedAt,
                    paidAt: null,
                    failedAt,
                    failureSummary: 'The synthetic test payment did not complete.',
                  },
                ],
              },
            ],
          }}
        />
      </div>
    </main>
  )
}
