import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { BILLING_TENANT_FLAG_KEYS, isFeatureEnabled } from '@pathfinder/config'
import { db, setContentVersionContext, withTenantIsolationBypass } from '@pathfinder/db'
import {
  BillingServiceError,
  StripeBillingProvider,
  createManualBillingArrangement,
  createBillingAccessOverride,
  createStripeClient,
  createTenantCheckout,
  executeApprovedBillingAgentCommand,
  getTenantBillingOverview,
  parseBillingEnvironment,
  reconcileBillingAccount,
  recordManualPayment,
} from '@pathfinder/billing'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'

function runtime() {
  const environment = parseBillingEnvironment()
  return { environment, provider: new StripeBillingProvider(createStripeClient(environment)) }
}

function rethrow(error: unknown): never {
  if (error instanceof BillingServiceError) {
    throw new TRPCError({
      code:
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'PRECONDITION_FAILED',
      message: error.message,
    })
  }
  throw error
}

const tenantId = z.string().trim().min(1).max(191)

const BILLING_ROLLOUT_FLAGS = [
  {
    tenantFlagKey: BILLING_TENANT_FLAG_KEYS.ui,
    featureKey: 'billingUi' as const,
    label: 'Payment tab',
    description: 'Shows the tenant-scoped payment workspace and billing history.',
  },
  {
    tenantFlagKey: BILLING_TENANT_FLAG_KEYS.checkout,
    featureKey: 'billingCheckout' as const,
    label: 'Checkout',
    description: 'Allows the tenant owner to open an approved Stripe Checkout Session.',
  },
  {
    tenantFlagKey: BILLING_TENANT_FLAG_KEYS.portal,
    featureKey: 'billingPortal' as const,
    label: 'Payment management',
    description: 'Allows the tenant owner to open the restricted Stripe Customer Portal.',
  },
  {
    tenantFlagKey: BILLING_TENANT_FLAG_KEYS.cancellation,
    featureKey: 'billingCancellation' as const,
    label: 'Cancellation requests',
    description: 'Allows reason-required cancellation at the paid-through period end.',
  },
  {
    tenantFlagKey: BILLING_TENANT_FLAG_KEYS.entitlementEnforcement,
    featureKey: 'billingEntitlementEnforcement' as const,
    label: 'Billing entitlement enforcement',
    description: 'Applies the centralized billing access policy for this pilot tenant.',
  },
] as const

const allowedBillingTenantKeys = new Set<string>(
  BILLING_ROLLOUT_FLAGS.map((flag) => flag.tenantFlagKey),
)
const billingTenantFlagKey = z.string().refine((value) => allowedBillingTenantKeys.has(value), {
  message: 'Unknown billing rollout flag',
})

export const adminBillingRouter = router({
  getBillingRollout: adminProcedure.input(z.object({ tenantId }).strict()).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      const [tenant, rows] = await Promise.all([
        db.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true, name: true } }),
        db.tenantFeatureFlag.findMany({
          where: {
            tenantId: input.tenantId,
            flagKey: { in: BILLING_ROLLOUT_FLAGS.map((flag) => flag.tenantFlagKey) },
          },
          select: { flagKey: true, enabled: true, setAt: true, setBy: true },
        }),
      ])
      if (!tenant) throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })

      const byKey = new Map(rows.map((row) => [row.flagKey, row]))
      return {
        tenant,
        flags: BILLING_ROLLOUT_FLAGS.map((definition) => {
          const row = byKey.get(definition.tenantFlagKey)
          const globalEnabled = isFeatureEnabled(definition.featureKey)
          const tenantEnabled = row?.enabled ?? false
          return {
            ...definition,
            globalEnabled,
            tenantEnabled,
            effective: globalEnabled && tenantEnabled,
            setAt: row?.setAt ?? null,
            setBy: row?.setBy ?? null,
          }
        }),
      }
    }),
  ),

  setBillingTenantFlag: adminProcedure
    .input(z.object({ tenantId, flagKey: billingTenantFlagKey, enabled: z.boolean() }).strict())
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        db.$transaction(async (transaction) => {
          await setContentVersionContext(transaction, { actorId: ctx.session.userId })
          const tenant = await transaction.tenant.findUnique({
            where: { id: input.tenantId },
            select: { id: true },
          })
          if (!tenant) throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })

          const before = await transaction.tenantFeatureFlag.findUnique({
            where: {
              tenantId_flagKey: { tenantId: input.tenantId, flagKey: input.flagKey },
            },
            select: { enabled: true },
          })
          const saved = await transaction.tenantFeatureFlag.upsert({
            where: {
              tenantId_flagKey: { tenantId: input.tenantId, flagKey: input.flagKey },
            },
            create: {
              tenantId: input.tenantId,
              flagKey: input.flagKey,
              enabled: input.enabled,
              setBy: ctx.session.userId,
              metadata: { source: 'platform-admin', system: 'billing' },
            },
            update: {
              enabled: input.enabled,
              setBy: ctx.session.userId,
              setAt: new Date(),
              metadata: { source: 'platform-admin', system: 'billing' },
            },
            select: { flagKey: true, enabled: true, setAt: true, setBy: true },
          })

          await transaction.auditLog.create({
            data: {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: input.enabled
                ? 'admin.billing-rollout.enabled'
                : 'admin.billing-rollout.disabled',
              targetType: 'TenantFeatureFlag',
              targetId: `${input.tenantId}:${input.flagKey}`,
              beforeState: { enabled: before?.enabled ?? false },
              afterState: { enabled: input.enabled, flagKey: input.flagKey },
            },
          })

          const definition = BILLING_ROLLOUT_FLAGS.find(
            (flag) => flag.tenantFlagKey === input.flagKey,
          )
          const globalEnabled = definition ? isFeatureEnabled(definition.featureKey) : false
          return { ...saved, globalEnabled, effective: globalEnabled && saved.enabled }
        }),
      ),
    ),

  executeApprovedBillingCommand: adminProcedure
    .input(z.object({ tenantId, commandId: z.string().trim().min(1).max(191) }).strict())
    .mutation(async ({ input, ctx }) => {
      try {
        const providerRuntime = runtime()
        return await executeApprovedBillingAgentCommand({
          tenantId: input.tenantId,
          commandId: input.commandId,
          actorId: ctx.session.userId,
          provider: providerRuntime.provider,
          environment: providerRuntime.environment,
          client: ctx.db,
        })
      } catch (error) {
        rethrow(error)
      }
    }),

  getClientBilling: adminProcedure
    .input(z.object({ tenantId }).strict())
    .query(({ input, ctx }) =>
      getTenantBillingOverview({ tenantId: input.tenantId, client: ctx.db }),
    ),

  createClientCheckout: adminProcedure
    .input(
      z
        .object({
          tenantId,
          planKey: z.string().trim().min(1).max(100),
          planVersion: z.number().int().positive().optional(),
          venueIds: z.array(z.string().trim().min(1).max(191)).min(1).max(100),
          operationKey: z.string().uuid().optional(),
          replaceManualArrangement: z.boolean().default(false),
          negotiatedTerms: z
            .object({
              amountMinor: z
                .string()
                .regex(/^[1-9]\d{0,11}$/u)
                .transform(BigInt),
              currency: z
                .string()
                .trim()
                .regex(/^[a-zA-Z]{3}$/u)
                .transform((value) => value.toLowerCase()),
              interval: z.enum(['month', 'year']),
              intervalCount: z.number().int().positive().max(12).default(1),
              reason: z.string().trim().min(3).max(500),
              reference: z.string().trim().min(1).max(191),
            })
            .strict()
            .optional(),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const providerRuntime = runtime()
        return await createTenantCheckout({
          tenantId: input.tenantId,
          actorId: ctx.session.userId,
          actorRole: 'PLATFORM_ADMIN',
          planKey: input.planKey,
          ...(input.planVersion === undefined ? {} : { planVersion: input.planVersion }),
          venueIds: input.venueIds,
          ...(input.operationKey === undefined ? {} : { operationKey: input.operationKey }),
          replaceManualArrangement: input.replaceManualArrangement,
          ...(input.negotiatedTerms ? { negotiatedTerms: input.negotiatedTerms } : {}),
          provider: providerRuntime.provider,
          environment: providerRuntime.environment,
          client: ctx.db,
        })
      } catch (error) {
        rethrow(error)
      }
    }),

  createBillingAccessOverride: adminProcedure
    .input(
      z
        .object({
          tenantId,
          agreementId: z.string().trim().min(1).max(191).nullable().optional(),
          venueId: z.string().trim().min(1).max(191).nullable().optional(),
          effect: z.enum(['GRANT', 'DENY']),
          kind: z.enum([
            'MANUAL_PAYMENT',
            'COMPLIMENTARY',
            'PILOT',
            'GRACE_PERIOD',
            'PLATFORM_ADMIN',
          ]),
          startsAt: z
            .string()
            .datetime({ offset: true })
            .transform((value) => new Date(value))
            .optional(),
          expiresAt: z
            .string()
            .datetime({ offset: true })
            .transform((value) => new Date(value)),
          reason: z.string().trim().min(3).max(500),
          reference: z.string().trim().min(1).max(191).nullable().optional(),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await createBillingAccessOverride({
          tenantId: input.tenantId,
          actorId: ctx.session.userId,
          agreementId: input.agreementId ?? null,
          venueId: input.venueId ?? null,
          effect: input.effect,
          kind: input.kind,
          ...(input.startsAt ? { startsAt: input.startsAt } : {}),
          expiresAt: input.expiresAt,
          reason: input.reason,
          reference: input.reference ?? null,
          client: ctx.db,
        })
      } catch (error) {
        rethrow(error)
      }
    }),

  createManualArrangement: adminProcedure
    .input(
      z
        .object({
          tenantId,
          mode: z.enum(['MANUAL_INVOICE', 'COMPLIMENTARY', 'PILOT', 'NO_BILLING_REQUIRED']),
          planKey: z.string().trim().min(1).max(100),
          amountMinor: z.string().regex(/^\d+$/u).transform(BigInt).nullable().optional(),
          accessEndsAt: z
            .string()
            .datetime({ offset: true })
            .transform((value) => new Date(value))
            .nullable()
            .optional(),
          venueIds: z.array(z.string().trim().min(1).max(191)).min(1).max(100),
          reason: z.string().trim().min(3).max(500),
          reference: z.string().trim().min(1).max(191).nullable().optional(),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await createManualBillingArrangement({
          tenantId: input.tenantId,
          actorId: ctx.session.userId,
          mode: input.mode,
          planKey: input.planKey,
          amountMinor: input.amountMinor ?? null,
          accessEndsAt: input.accessEndsAt ?? null,
          venueIds: input.venueIds,
          reason: input.reason,
          reference: input.reference ?? null,
          client: ctx.db,
        })
      } catch (error) {
        rethrow(error)
      }
    }),

  recordManualPayment: adminProcedure
    .input(
      z
        .object({
          tenantId,
          agreementId: z.string().trim().min(1).max(191),
          amountMinor: z.string().regex(/^\d+$/u).transform(BigInt),
          currency: z.string().regex(/^[a-zA-Z]{3}$/u),
          paidAt: z
            .string()
            .datetime({ offset: true })
            .transform((value) => new Date(value)),
          paidThroughAt: z
            .string()
            .datetime({ offset: true })
            .transform((value) => new Date(value))
            .nullable()
            .optional(),
          reference: z.string().trim().min(1).max(191),
          reason: z.string().trim().min(3).max(500),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await recordManualPayment({
          tenantId: input.tenantId,
          agreementId: input.agreementId,
          actorId: ctx.session.userId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          paidAt: input.paidAt,
          paidThroughAt: input.paidThroughAt ?? null,
          reference: input.reference,
          reason: input.reason,
          client: ctx.db,
        })
      } catch (error) {
        rethrow(error)
      }
    }),

  reconcileClientBilling: adminProcedure
    .input(z.object({ tenantId }).strict())
    .mutation(async ({ input, ctx }) => {
      try {
        const providerRuntime = runtime()
        return await reconcileBillingAccount({
          tenantId: input.tenantId,
          actorId: ctx.session.userId,
          trigger: 'ON_DEMAND',
          provider: providerRuntime.provider,
          environment: providerRuntime.environment,
          client: ctx.db,
        })
      } catch (error) {
        rethrow(error)
      }
    }),
})
