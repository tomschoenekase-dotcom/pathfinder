import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  PRODUCT_CAPABILITY_IDS,
  ProductCapabilityId,
} from '@pathfinder/contracts/product-entitlements'
import {
  db,
  resolveProductEntitlement,
  withTenantIsolationBypass,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const settingValue = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()])
const settings = z.record(z.string().max(100), settingValue)

export const adminProductEntitlementsRouter = router({
  listProductEntitlements: adminProcedure
    .input(
      z.object({ tenantId: z.string().min(1), venueId: z.string().min(1).optional() }).strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        if (input.venueId) {
          const venue = await db.venue.findFirst({
            where: { id: input.venueId, tenantId: input.tenantId },
            select: { id: true },
          })
          if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found.' })
        }
        return Promise.all(
          PRODUCT_CAPABILITY_IDS.map((capability) =>
            resolveProductEntitlement({
              client: db,
              tenantId: input.tenantId,
              ...(input.venueId ? { venueId: input.venueId } : {}),
              capability,
              featureAvailable: true,
            }),
          ),
        )
      }),
    ),

  setProductEntitlementOverride: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1).nullable().default(null),
          capability: ProductCapabilityId,
          effect: z.enum(['GRANT', 'DENY']),
          kind: z.enum(['EXPLICIT', 'TRIAL', 'PROMOTION', 'ADMIN']).default('ADMIN'),
          startsAt: z.string().datetime({ offset: true }).optional(),
          endsAt: z.string().datetime({ offset: true }).nullable().default(null),
          settings: settings.default({}),
          reason: z.string().trim().min(3).max(500),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const startsAt = input.startsAt ? new Date(input.startsAt) : new Date()
        const endsAt = input.endsAt ? new Date(input.endsAt) : null
        if (endsAt && endsAt <= startsAt) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Override end must be after its start.',
          })
        }
        return db.$transaction(async (tx) => {
          const tenant = await tx.tenant.findUnique({
            where: { id: input.tenantId },
            select: { id: true },
          })
          if (!tenant) throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found.' })
          if (input.venueId) {
            const venue = await tx.venue.findFirst({
              where: { id: input.venueId, tenantId: input.tenantId },
              select: { id: true },
            })
            if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found.' })
          }
          const override = await tx.productEntitlementOverride.create({
            data: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              capability: input.capability,
              effect: input.effect,
              kind: input.kind,
              startsAt,
              endsAt,
              settings: input.settings,
              setBy: ctx.session.userId,
              reason: input.reason,
            },
          })
          await writeAuditLogStrict(
            {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: 'admin.product-entitlement.override-created',
              targetType: 'ProductEntitlementOverride',
              targetId: override.id,
              afterState: {
                venueId: input.venueId,
                capability: input.capability,
                effect: input.effect,
                kind: input.kind,
                startsAt: startsAt.toISOString(),
                endsAt: endsAt?.toISOString() ?? null,
                reason: input.reason,
              },
            },
            tx,
          )
          return override
        })
      }),
    ),

  setProductPlanCapability: adminProcedure
    .input(
      z
        .object({
          planTier: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u),
          capability: ProductCapabilityId,
          enabled: z.boolean(),
          settings: settings.default({}),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          const mapping = await tx.productPlanCapability.upsert({
            where: {
              planTier_capability: { planTier: input.planTier, capability: input.capability },
            },
            create: { ...input, createdBy: ctx.session.userId, updatedBy: ctx.session.userId },
            update: {
              enabled: input.enabled,
              settings: input.settings,
              updatedBy: ctx.session.userId,
            },
          })
          await writeAuditLogStrict(
            {
              tenantId: null,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: 'admin.product-plan-capability.updated',
              targetType: 'ProductPlanCapability',
              targetId: mapping.id,
              afterState: {
                planTier: input.planTier,
                capability: input.capability,
                enabled: input.enabled,
              },
            },
            tx,
          )
          return mapping
        }),
      ),
    ),
})
