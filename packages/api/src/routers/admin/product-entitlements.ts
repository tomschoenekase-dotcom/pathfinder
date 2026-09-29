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
const monthInput = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, 'Month must use YYYY-MM format.')

export const adminProductEntitlementsRouter = router({
  getVenueVoiceUsageSummary: adminProcedure
    .input(
      z
        .object({ tenantId: z.string().min(1), venueId: z.string().min(1), month: monthInput })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found.' })

        const start = new Date(`${input.month}-01T00:00:00.000Z`)
        const end = new Date(start)
        end.setUTCMonth(end.getUTCMonth() + 1)
        const [sessions, usage] = await Promise.all([
          db.voiceSession.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              connectedAt: { not: null, lt: end },
              OR: [{ endedAt: null }, { endedAt: { gt: start } }],
            },
            select: {
              connectedAt: true,
              endedAt: true,
              durationSeconds: true,
              maxDurationSeconds: true,
            },
          }),
          db.aiUsageEvent.aggregate({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              feature: 'realtime-voice',
              usageObservationStatus: 'CLIENT_REPORTED',
              createdAt: { gte: start, lt: end },
            },
            _sum: { estimatedCostUsd: true },
          }),
        ])
        const now = new Date()
        let sessionCount = 0
        const durationSeconds = sessions.reduce((sum, session) => {
          if (!session.connectedAt) return sum
          const sessionStart = session.connectedAt
          const elapsedEnd = session.endedAt
            ? new Date(
                Math.min(
                  session.endedAt.getTime(),
                  sessionStart.getTime() + session.durationSeconds * 1_000,
                ),
              )
            : new Date(
                Math.min(
                  now.getTime(),
                  sessionStart.getTime() + session.maxDurationSeconds * 1_000,
                ),
              )
          const overlapStart = Math.max(sessionStart.getTime(), start.getTime())
          const overlapEnd = Math.min(elapsedEnd.getTime(), end.getTime())
          const overlapSeconds = Math.max(0, (overlapEnd - overlapStart) / 1_000)
          if (overlapSeconds > 0) sessionCount += 1
          return sum + overlapSeconds
        }, 0)
        const minutes = durationSeconds / 60
        const estimatedCost = usage._sum.estimatedCostUsd
        return {
          month: input.month,
          durationSeconds: Number(durationSeconds.toFixed(3)),
          minutes: Number(minutes.toFixed(2)),
          sessionCount,
          estimatedCostUsd: estimatedCost?.toFixed(8) ?? '0.00000000',
          estimatedCostPerMinuteUsd:
            minutes > 0
              ? (estimatedCost?.dividedBy(durationSeconds).times(60).toFixed(8) ?? '0.00000000')
              : null,
          costIsEstimate: true as const,
          durationAttribution: 'voiceSession.connectedAt UTC-month overlap' as const,
          costAttribution: 'AiUsageEvent.createdAt' as const,
        }
      }),
    ),

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
