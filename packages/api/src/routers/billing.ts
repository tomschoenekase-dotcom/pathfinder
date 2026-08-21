import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  BillingServiceError,
  BILLING_ADD_ON_CATALOG,
  StripeBillingProvider,
  createStripeClient,
  createTenantCheckout,
  createTenantPortal,
  getTenantBillingOverview,
  parseBillingEnvironment,
  recordTenantAddOnInterest,
  requestTenantCancellation,
} from '@pathfinder/billing'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

function provider() {
  const environment = parseBillingEnvironment()
  return { environment, provider: new StripeBillingProvider(createStripeClient(environment)) }
}

function mapBillingError(error: unknown): never {
  if (error instanceof BillingServiceError) {
    const code =
      error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.code === 'CONFLICT'
          ? 'CONFLICT'
          : error.code === 'FORBIDDEN'
            ? 'FORBIDDEN'
            : 'PRECONDITION_FAILED'
    throw new TRPCError({ code, message: error.message })
  }
  throw error
}

async function requireTenantFlag(
  ctx: { db: Parameters<typeof getTenantBillingOverview>[0]['client'] },
  tenantId: string,
  flagKey: string,
) {
  const flag = await ctx.db?.tenantFeatureFlag.findUnique({
    where: { tenantId_flagKey: { tenantId, flagKey } },
    select: { enabled: true },
  })
  if (!flag?.enabled)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Billing is not available.' })
}

export const billingRouter = router({
  overview: tenantProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.session.activeTenantId
    await requireTenantFlag(ctx, tenantId, 'billing-ui-v1')
    const overview = await getTenantBillingOverview({ tenantId, client: ctx.db })
    if (!overview.account)
      return { ...overview, hasStripeCustomer: false, currentCheckoutUrl: null }
    const account = overview.account
    const currentAttempt = account.checkoutAttempts[0]
    return {
      enabled: overview.enabled,
      capabilities: overview.capabilities,
      catalog: overview.catalog,
      venues: overview.venues,
      access: overview.access,
      hasStripeCustomer: Boolean(account.stripeCustomerId),
      currentCheckoutUrl:
        ctx.session.role === 'OWNER' &&
        currentAttempt?.stripeCheckoutUrl &&
        currentAttempt.expiresAt &&
        currentAttempt.expiresAt > new Date()
          ? currentAttempt.stripeCheckoutUrl
          : null,
      addOnCatalog: BILLING_ADD_ON_CATALOG,
      account: {
        billingMode: account.billingMode,
        currency: account.currency,
        status: account.status,
        paidThroughAt: account.paidThroughAt,
        gracePeriodEndsAt: account.gracePeriodEndsAt,
        reconciliationHealth: account.reconciliationHealth,
        lastReconciledAt: account.lastReconciledAt,
        commercialAgreements: account.commercialAgreements.map((agreement) => ({
          id: agreement.id,
          isBase: agreement.isBase,
          internalPlanKey: agreement.internalPlanKey,
          internalPlanVersion: agreement.internalPlanVersion,
          status: agreement.status,
          billingMode: agreement.billingMode,
          billingInterval: agreement.billingInterval,
          agreedAmountMinor: agreement.agreedAmountMinor,
          currency: agreement.currency,
          cancelAtPeriodEnd: agreement.cancelAtPeriodEnd,
          currentPeriodEndsAt: agreement.currentPeriodEndsAt,
          accessEndsAt: agreement.accessEndsAt,
          coveredVenues: agreement.coveredVenues.map((coverage) => ({
            venue: coverage.venue,
          })),
        })),
        invoiceProjections: account.invoiceProjections.map((invoice) => ({
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          amountDueMinor: invoice.amountDueMinor,
          currency: invoice.currency,
          dueAt: invoice.dueAt,
          paidAt: invoice.paidAt,
          createdAt: invoice.createdAt,
          invoiceDocumentUrl: invoice.invoiceDocumentUrl,
          hostedInvoiceUrl: invoice.hostedInvoiceUrl,
        })),
        customerRequests: account.customerRequests.map((request) => ({
          id: request.id,
          kind: request.kind,
          status: request.status,
          reason: request.reason,
          featureKey: request.featureKey,
          featureLabel: request.featureLabelSnapshot,
          venueId: request.venueId,
          providerActionAt: request.providerActionAt,
          resolvedAt: request.resolvedAt,
          createdAt: request.createdAt,
        })),
      },
    }
  }),

  createCheckout: tenantProcedure
    .use(requireRole('OWNER'))
    .input(
      z
        .object({
          planKey: z.string().trim().min(1).max(100),
          planVersion: z.number().int().positive().optional(),
          venueIds: z.array(z.string().trim().min(1).max(191)).min(1).max(100),
          operationKey: z.string().uuid().optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      await requireTenantFlag(ctx, ctx.session.activeTenantId, 'billing-checkout-v1')
      try {
        const runtime = provider()
        return await createTenantCheckout({
          tenantId: ctx.session.activeTenantId,
          actorId: ctx.session.userId,
          actorRole: ctx.session.role,
          planKey: input.planKey,
          ...(input.planVersion === undefined ? {} : { planVersion: input.planVersion }),
          venueIds: input.venueIds,
          ...(input.operationKey === undefined ? {} : { operationKey: input.operationKey }),
          provider: runtime.provider,
          environment: runtime.environment,
          client: ctx.db,
        })
      } catch (error) {
        mapBillingError(error)
      }
    }),

  createPortal: tenantProcedure.use(requireRole('OWNER')).mutation(async ({ ctx }) => {
    await requireTenantFlag(ctx, ctx.session.activeTenantId, 'billing-portal-v1')
    try {
      const runtime = provider()
      return await createTenantPortal({
        tenantId: ctx.session.activeTenantId,
        provider: runtime.provider,
        environment: runtime.environment,
        client: ctx.db,
      })
    } catch (error) {
      mapBillingError(error)
    }
  }),

  requestCancellation: tenantProcedure
    .use(requireRole('OWNER'))
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          reason: z.string().trim().min(3).max(2000),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      await requireTenantFlag(ctx, ctx.session.activeTenantId, 'billing-cancellation-v1')
      try {
        const runtime = provider()
        return await requestTenantCancellation({
          tenantId: ctx.session.activeTenantId,
          actorId: ctx.session.userId,
          actorRole: ctx.session.role,
          operationId: input.operationId,
          reason: input.reason,
          provider: runtime.provider,
          environment: runtime.environment,
          client: ctx.db,
        })
      } catch (error) {
        mapBillingError(error)
      }
    }),

  recordAddOnInterest: tenantProcedure
    .use(requireRole('OWNER'))
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          featureKey: z.string().trim().min(1).max(100),
          venueId: z.string().trim().min(1).max(191).nullable().optional(),
          note: z.string().trim().max(2000).nullable().optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      await requireTenantFlag(ctx, ctx.session.activeTenantId, 'billing-ui-v1')
      try {
        return await recordTenantAddOnInterest({
          tenantId: ctx.session.activeTenantId,
          actorId: ctx.session.userId,
          actorRole: ctx.session.role,
          operationId: input.operationId,
          featureKey: input.featureKey,
          venueId: input.venueId ?? null,
          note: input.note ?? null,
          client: ctx.db,
        })
      } catch (error) {
        mapBillingError(error)
      }
    }),
})
