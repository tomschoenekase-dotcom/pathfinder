import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { isFeatureEnabled, TOCHI_ROLLOUT_FLAGS } from '@pathfinder/config'
import { db, setContentVersionContext, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const tenantInput = z.object({ tenantId: z.string().min(1).max(128) }).strict()
const allowedTenantKeys = new Set<string>(TOCHI_ROLLOUT_FLAGS.map((flag) => flag.tenantFlagKey))
const tenantFlagKey = z.string().refine((value) => allowedTenantKeys.has(value), {
  message: 'Unknown Tochi rollout flag',
})

export const adminTochiRolloutRouter = router({
  getTochiRollout: adminProcedure.input(tenantInput).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      const [tenant, rows] = await Promise.all([
        db.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true, name: true } }),
        db.tenantFeatureFlag.findMany({
          where: {
            tenantId: input.tenantId,
            flagKey: { in: TOCHI_ROLLOUT_FLAGS.map((flag) => flag.tenantFlagKey) },
          },
          select: { flagKey: true, enabled: true, setAt: true, setBy: true },
        }),
      ])
      if (!tenant) throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })

      const byKey = new Map(rows.map((row) => [row.flagKey, row]))
      return {
        tenant,
        flags: TOCHI_ROLLOUT_FLAGS.map((definition) => {
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

  setTochiTenantFlag: adminProcedure
    .input(tenantInput.extend({ flagKey: tenantFlagKey, enabled: z.boolean() }).strict())
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
              metadata: { source: 'platform-admin', system: 'tochi' },
            },
            update: {
              enabled: input.enabled,
              setBy: ctx.session.userId,
              setAt: new Date(),
              metadata: { source: 'platform-admin', system: 'tochi' },
            },
            select: { flagKey: true, enabled: true, setAt: true, setBy: true },
          })

          await transaction.auditLog.create({
            data: {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: input.enabled
                ? 'admin.tochi-rollout.enabled'
                : 'admin.tochi-rollout.disabled',
              targetType: 'TenantFeatureFlag',
              targetId: `${input.tenantId}:${input.flagKey}`,
              beforeState: { enabled: before?.enabled ?? false },
              afterState: { enabled: input.enabled, flagKey: input.flagKey },
            },
          })

          const definition = TOCHI_ROLLOUT_FLAGS.find(
            (flag) => flag.tenantFlagKey === input.flagKey,
          )
          const globalEnabled = definition ? isFeatureEnabled(definition.featureKey) : false
          return { ...saved, globalEnabled, effective: globalEnabled && saved.enabled }
        }),
      ),
    ),
})
