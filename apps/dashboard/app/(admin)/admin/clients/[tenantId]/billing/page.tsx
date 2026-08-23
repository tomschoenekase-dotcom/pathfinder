export const dynamic = 'force-dynamic'

import { AdminBillingActionsView } from '../../../../../../components/admin/AdminBillingActionsView'
import { AdminBillingControls } from '../../../../../../components/admin/AdminBillingControls'
import type {
  AdminBillingState,
  AdminBillingViewModel,
} from '../../../../../../components/admin/AdminBillingView'
import { createAdminCaller } from '../../../../../../lib/admin-caller'

type Props = { params: Promise<{ tenantId: string }> }

function date(value: Date | string | null | undefined) {
  return value
    ? new Date(value).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null
}

function money(value: bigint | number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(Number(value) / 100)
}

export default async function AdminClientBillingPage({ params }: Props) {
  const { tenantId } = await params
  const caller = await createAdminCaller()
  const [overview, client, rollout] = await Promise.all([
    caller.admin.getClientBilling({ tenantId }),
    caller.admin.getClient({ tenantId }),
    caller.admin.getBillingRollout({ tenantId }),
  ])
  if (!overview.enabled)
    return (
      <section className="rounded-2xl border border-pf-light bg-white p-8 text-center">
        <h1 className="text-xl font-semibold text-pf-deep">Billing operations are disabled</h1>
        <p className="mt-2 text-sm text-pf-deep/65">
          The server billing UI kill switch remains off for this environment.
        </p>
      </section>
    )
  const account = overview.account
  if (!account)
    return (
      <>
        <AdminBillingActionsView tenantId={tenantId} state="empty" billing={null} />
        <AdminBillingControls
          tenantId={tenantId}
          venues={overview.venues}
          catalog={overview.catalog}
          agreementId={null}
          hasManualBase={false}
          rolloutFlags={rollout.flags}
          agentCommands={[]}
        />
      </>
    )
  const agreement =
    account.commercialAgreements.find((item) => item.isBase) ?? account.commercialAgreements[0]
  if (!agreement)
    return <AdminBillingActionsView tenantId={tenantId} state="empty" billing={null} />
  const mode = agreement.billingMode
  const state: AdminBillingState =
    mode === 'COMPLIMENTARY' || mode === 'PILOT'
      ? 'complimentary'
      : mode !== 'STRIPE_SUBSCRIPTION' && mode !== 'STRIPE_INVOICE'
        ? 'manual'
        : overview.access?.state === 'GRACE_PERIOD'
          ? 'grace'
          : agreement.status === 'PAST_DUE' || agreement.status === 'UNPAID'
            ? 'past_due'
            : agreement.status === 'PENDING' || agreement.status === 'DRAFT'
              ? 'pending'
              : agreement.cancelAtPeriodEnd ||
                  agreement.status === 'CANCELED' ||
                  agreement.status === 'ENDED'
                ? 'canceled'
                : 'active'
  const activeOverride = account.accessOverrides[0]
  const stripeRoot =
    account.stripeMode === 'TEST'
      ? 'https://dashboard.stripe.com/test'
      : 'https://dashboard.stripe.com'
  const model: AdminBillingViewModel = {
    tenant: { id: client.tenant.id, name: client.tenant.name },
    billingModeLabel: mode.replaceAll('_', ' ').toLowerCase(),
    planName: agreement.internalPlanKey,
    amountLabel:
      agreement.agreedAmountMinor === null
        ? null
        : money(agreement.agreedAmountMinor, agreement.currency),
    intervalLabel:
      agreement.billingInterval === 'CUSTOM'
        ? null
        : `per ${agreement.billingInterval.toLowerCase()}`,
    subscriptionStatusLabel: agreement.status.replaceAll('_', ' ').toLowerCase(),
    entitlementStatusLabel: overview.access?.entitlementsActive
      ? `Active · ${overview.access.state.toLowerCase().replaceAll('_', ' ')}`
      : `Inactive · ${overview.access?.state.toLowerCase().replaceAll('_', ' ') ?? 'unresolved'}`,
    statusDetail: overview.access?.reason ?? 'No billing-to-entitlement decision is available.',
    currentPeriodLabel:
      agreement.currentPeriodStartsAt && agreement.currentPeriodEndsAt
        ? `${date(agreement.currentPeriodStartsAt)} – ${date(agreement.currentPeriodEndsAt)}`
        : null,
    renewalOrCancellationLabel: agreement.cancelAtPeriodEnd
      ? `Ends ${date(agreement.cancellationEffectiveAt ?? agreement.currentPeriodEndsAt)}`
      : agreement.currentPeriodEndsAt
        ? `Renews ${date(agreement.currentPeriodEndsAt)}`
        : null,
    minimumCommitmentLabel: agreement.minimumCommitmentEndsAt
      ? `Through ${date(agreement.minimumCommitmentEndsAt)}`
      : null,
    coveredVenues: agreement.coveredVenues.map((coverage) => ({
      id: coverage.venue.id,
      name: coverage.venue.name,
      coverageLabel: agreement.venuePriceBreakdownComplete
        ? 'Verified component'
        : 'Breakdown unavailable',
      amountLabel:
        agreement.venuePriceBreakdownComplete && coverage.agreedAmountMinor !== null
          ? money(coverage.agreedAmountMinor, agreement.currency)
          : null,
    })),
    provider: {
      customerId: account.stripeCustomerId,
      customerDashboardUrl: account.stripeCustomerId
        ? `${stripeRoot}/customers/${encodeURIComponent(account.stripeCustomerId)}`
        : null,
      subscriptionId: agreement.stripeSubscriptionId,
      subscriptionDashboardUrl: agreement.stripeSubscriptionId
        ? `${stripeRoot}/subscriptions/${encodeURIComponent(agreement.stripeSubscriptionId)}`
        : null,
    },
    invoices: account.invoiceProjections.map((invoice) => ({
      id: invoice.id,
      number: invoice.invoiceNumber,
      statusLabel: invoice.status.toLowerCase(),
      amountLabel: money(invoice.amountDueMinor, invoice.currency),
      dateLabel: date(invoice.paidAt ?? invoice.dueAt ?? invoice.createdAt) ?? 'Unavailable',
      failureSummary: invoice.failureSummary,
      documentUrl: invoice.invoiceDocumentUrl ?? invoice.hostedInvoiceUrl,
    })),
    override: activeOverride
      ? {
          label: `${activeOverride.kind.replaceAll('_', ' ')} · ${activeOverride.effect}`,
          reason: activeOverride.reason,
          expiresLabel: date(activeOverride.expiresAt) ?? 'Unavailable',
        }
      : null,
    reconciliation: {
      statusLabel: account.reconciliationHealth.toLowerCase(),
      lastCheckedLabel: date(account.lastReconciledAt),
      detail:
        account.lastReconciliationError ??
        (account.reconciliationHealth === 'CURRENT'
          ? 'Local projection matches the last provider comparison.'
          : 'Reconciliation has not established a current provider projection.'),
      warning: account.reconciliationHealth !== 'CURRENT',
    },
    timeline: [
      ...account.customerRequests.map((request) => ({
        id: request.id,
        occurredAtLabel: new Date(request.createdAt).toLocaleString('en-US'),
        title:
          request.kind === 'ADD_ON_INTEREST'
            ? `Add-on interest: ${request.featureLabelSnapshot ?? request.featureKey ?? 'feature'}`
            : 'Customer cancellation request',
        detail: `${request.status.toLowerCase()}${request.reason ? ` · ${request.reason}` : ''}`,
        actorLabel: 'Customer billing request',
      })),
      ...account.eventApplications.map((event) => ({
        id: event.id,
        occurredAtLabel: new Date(event.providerCreatedAt).toLocaleString('en-US'),
        title: event.eventType,
        detail: event.status.toLowerCase().replaceAll('_', ' '),
        actorLabel: 'Verified Stripe event',
      })),
    ],
    recoveryActions: [
      {
        id: 'reconcile',
        label: 'Reconcile with Stripe',
        description: 'Retrieve current test-mode subscription truth and repair drift idempotently.',
      },
    ],
  }
  return (
    <>
      <AdminBillingActionsView tenantId={tenantId} state={state} billing={model} />
      <AdminBillingControls
        tenantId={tenantId}
        venues={overview.venues}
        catalog={overview.catalog}
        agreementId={agreement.id}
        hasManualBase={mode !== 'STRIPE_SUBSCRIPTION' && mode !== 'STRIPE_INVOICE'}
        rolloutFlags={rollout.flags}
        agentCommands={account.agentCommands}
      />
    </>
  )
}
