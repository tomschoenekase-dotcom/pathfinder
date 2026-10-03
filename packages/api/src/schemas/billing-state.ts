import { z } from 'zod'

/**
 * Server-derived client billing states. "loading" is intentionally absent: it exists only in the
 * browser while a request is in flight. "forbidden" is produced by the tRPC FORBIDDEN error that
 * `requireRole('MANAGER')` throws and is mapped by the client; the server never returns payment
 * data to a STAFF session.
 *
 * Backing-field notes (no state invents pricing):
 * - no_setup: no BillingAccount, no CommercialAgreement, or the billing UI gate is off.
 * - complimentary: BillingMode COMPLIMENTARY / NO_BILLING_REQUIRED.
 * - pilot: BillingMode PILOT; `period.accessEndsAt` is the time bound.
 * - manual: BillingMode MANUAL_INVOICE (paid outside Stripe).
 * - no_subscription: agreement exists but nothing is payable and no provider subscription is linked.
 * - checkout_pending: PENDING agreement with an unexpired CREATED checkout attempt.
 * - invoice_open: ACTIVE/TRIALING agreement with an OPEN invoice projection.
 * - provider_sync_pending: PENDING with a linked provider subscription, reconciliation DRIFT/ERROR,
 *   or PAUSED/MANUAL_REVIEW (closest existing truth: Torchiko is verifying the provider state).
 * - error is returned for retrieval/configuration failures and never degrades to another state.
 */
export const CLIENT_BILLING_STATES = [
  'error',
  'no_setup',
  'complimentary',
  'pilot',
  'manual',
  'no_subscription',
  'checkout_pending',
  'active',
  'invoice_open',
  'past_due',
  'grace',
  'cancel_at_period_end',
  'cancelled',
  'provider_sync_pending',
] as const

export const clientBillingStateSchema = z.enum(CLIENT_BILLING_STATES)
export type ClientBillingServerState = z.infer<typeof clientBillingStateSchema>

export const clientBillingNextActionSchema = z.enum([
  'none',
  'contact_support',
  'complete_payment',
  'update_payment',
  'manage_billing',
  'retry',
  'wait',
])
export type ClientBillingNextAction = z.infer<typeof clientBillingNextActionSchema>

const moneySchema = z.object({ amountMinor: z.bigint(), currency: z.string().length(3) })

export const clientBillingStateResponseSchema = z.object({
  state: clientBillingStateSchema,
  nextAction: clientBillingNextActionSchema,
  /** When the server produced this answer. */
  asOf: z.date(),
  /** Newest provider reconciliation or applied provider event; null when none was ever recorded. */
  lastReliableUpdateAt: z.date().nullable(),
  reason: z.enum(['billing_not_enabled', 'no_billing_account', 'no_agreement']).nullable(),
  errorKind: z.enum(['retrieval', 'configuration']).nullable(),
  accessState: z.string().nullable(),
  syncHealth: z.enum(['UNKNOWN', 'CURRENT', 'STALE', 'DRIFT', 'ERROR']).nullable(),
  plan: z
    .object({
      name: z.string(),
      interval: z.string(),
      intervalCount: z.number().int(),
      price: moneySchema.nullable(),
    })
    .nullable(),
  period: z
    .object({
      currentPeriodEndsAt: z.date().nullable(),
      paidThroughAt: z.date().nullable(),
      graceEndsAt: z.date().nullable(),
      accessEndsAt: z.date().nullable(),
      expired: z.boolean(),
    })
    .nullable(),
  /** Present only when an OPEN invoice projection backs it; never inferred as zero. */
  amountDue: moneySchema.extend({ dueAt: z.date().nullable() }).nullable(),
  coveredVenues: z.array(z.object({ id: z.string(), name: z.string() })),
  invoices: z.array(
    z.object({
      id: z.string(),
      number: z.string().nullable(),
      status: z.string(),
      amountDue: moneySchema,
      date: z.date(),
      url: z.string().nullable(),
    }),
  ),
  actions: z.object({
    canStartCheckout: z.boolean(),
    checkoutUrl: z.string().nullable(),
    canManageBilling: z.boolean(),
    canCancel: z.boolean(),
  }),
})
export type ClientBillingStateResponse = z.infer<typeof clientBillingStateResponseSchema>
