import { formatMinorUnits } from './money'
import type { DashboardTRPCClient } from './trpc'
import type {
  ClientBillingState,
  ClientBillingViewModel,
} from '../components/billing/ClientBillingView'

// One interpretation of the tenant's billing projection, shared by Account and the Home
// payment summary so the two can never disagree about what is owed.
export type ClientBillingOverview = Awaited<
  ReturnType<DashboardTRPCClient['billing']['overview']['query']>
>

function dateLabel(value: Date | string | null | undefined) {
  return value
    ? new Date(value).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null
}

const moneyLabel = formatMinorUnits

export function clientBillingPresentation(overview: ClientBillingOverview): {
  state: ClientBillingState
  model: ClientBillingViewModel | null
} {
  const account = overview.account
  if (!account) return { state: 'empty', model: null }
  const agreement =
    account.commercialAgreements.find((item) => item.isBase) ?? account.commercialAgreements[0]
  if (!agreement) return { state: 'empty', model: null }
  const mode = agreement.billingMode
  const state: ClientBillingState =
    mode === 'COMPLIMENTARY' || mode === 'PILOT'
      ? 'complimentary'
      : mode !== 'STRIPE_SUBSCRIPTION' && mode !== 'STRIPE_INVOICE'
        ? 'manual'
        : overview.access?.state === 'GRACE_PERIOD'
          ? 'grace'
          : overview.access?.state === 'PAID_THROUGH' || overview.access?.state === 'ENDED'
            ? 'canceled'
            : agreement.status === 'PAST_DUE' || agreement.status === 'UNPAID'
              ? 'past_due'
              : agreement.status === 'PENDING' || agreement.status === 'DRAFT'
                ? 'pending'
                : 'active'
  const catalogPlan = overview.catalog.find(
    (plan) =>
      plan.key === agreement.internalPlanKey && plan.version === agreement.internalPlanVersion,
  )
  return {
    state,
    model: {
      planName: catalogPlan?.displayName ?? agreement.internalPlanKey.replaceAll('_', ' '),
      arrangementLabel: mode.replaceAll('_', ' ').toLowerCase(),
      amountLabel:
        agreement.agreedAmountMinor === null
          ? null
          : moneyLabel(agreement.agreedAmountMinor, agreement.currency),
      intervalLabel:
        agreement.billingInterval === 'CUSTOM'
          ? null
          : `per ${agreement.billingInterval.toLowerCase()}`,
      statusDetail: overview.access?.reason ?? 'Torchiko is waiting for a durable billing update.',
      nextBillingLabel: agreement.cancelAtPeriodEnd
        ? null
        : dateLabel(agreement.currentPeriodEndsAt),
      paidThroughLabel: dateLabel(
        account.paidThroughAt ?? agreement.currentPeriodEndsAt ?? agreement.accessEndsAt,
      ),
      coveredVenues: agreement.coveredVenues.map((coverage) => ({
        ...coverage.venue,
        amountLabel:
          agreement.venuePriceBreakdownComplete && coverage.agreedAmountMinor !== null
            ? moneyLabel(coverage.agreedAmountMinor, agreement.currency)
            : null,
      })),
      invoices: account.invoiceProjections.map((invoice) => ({
        id: invoice.id,
        number: invoice.invoiceNumber,
        statusLabel: invoice.status.toLowerCase(),
        amountLabel: moneyLabel(invoice.amountDueMinor, invoice.currency),
        dateLabel:
          dateLabel(invoice.paidAt ?? invoice.dueAt ?? invoice.createdAt) ?? 'Date unavailable',
        documentUrl: invoice.invoiceDocumentUrl ?? invoice.hostedInvoiceUrl,
      })),
      canStartCheckout:
        overview.capabilities.checkout &&
        agreement.status === 'PENDING' &&
        Boolean(overview.currentCheckoutUrl),
      canRetryCheckout:
        overview.capabilities.portal &&
        overview.hasStripeCustomer &&
        (agreement.status === 'PAST_DUE' || agreement.status === 'UNPAID'),
      canManageBilling: overview.capabilities.portal && overview.hasStripeCustomer,
      canCancel:
        overview.capabilities.cancellation &&
        Boolean(agreement.cancelAtPeriodEnd === false) &&
        Boolean(agreement.status === 'ACTIVE' || agreement.status === 'PAST_DUE'),
      cancellationPending:
        agreement.cancelAtPeriodEnd ||
        account.customerRequests.some(
          (request) =>
            request.kind === 'CANCELLATION' && ['PROCESSING', 'COMPLETED'].includes(request.status),
        ),
      addOns: overview.addOnCatalog.map((addOn) => ({
        ...addOn,
        interested: account.customerRequests.some(
          (request) =>
            request.kind === 'ADD_ON_INTEREST' &&
            request.featureKey === addOn.key &&
            ['OPEN', 'PROCESSING'].includes(request.status),
        ),
      })),
      supportUrl: '/support',
    },
  }
}
