import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { BILLING_TENANT_FLAG_KEYS, isFeatureEnabled } from '@pathfinder/config'
import { db, setContentVersionContext, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

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

export const adminBillingRolloutRouter = router({
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
})
