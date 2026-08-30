import { env } from '@pathfinder/config'
import {
  db,
  EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY,
  setContentVersionContext,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const EVALUATION_RUNNER_FLAG = 'evaluation-runner-v1'
const EVALUATION_ENABLE_CONFIRMATION = 'ENABLE EVALUATION RUNNER'

function durableGlobalValueEnabled(value: unknown) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 1 &&
    (value as Record<string, unknown>).enabled === true
  )
}

export const adminEvaluationRuntimeGatesRouter = router({
  setEvaluationRuntimeDurableGates: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          enabled: z.boolean(),
          expectedGlobalEnabled: z.boolean(),
          expectedTenantEnabled: z.boolean(),
          confirmation: z.string().max(64).optional(),
        })
        .strict(),
    )
    .mutation(({ input, ctx }) =>
      withTenantIsolationBypass(() =>
        db.$transaction(
          async (transaction) => {
            if (input.enabled && input.confirmation !== EVALUATION_ENABLE_CONFIRMATION)
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `Type ${EVALUATION_ENABLE_CONFIRMATION} to enable evaluation execution`,
              })

            await setContentVersionContext(transaction, { actorId: ctx.session.userId })
            const [venue, globalRow, tenantRow] = await Promise.all([
              transaction.venue.findFirst({
                where: { id: input.venueId, tenantId: input.tenantId },
                select: { id: true },
              }),
              transaction.platformConfig.findUnique({
                where: { key: EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY },
                select: { value: true },
              }),
              transaction.tenantFeatureFlag.findUnique({
                where: {
                  tenantId_flagKey: {
                    tenantId: input.tenantId,
                    flagKey: EVALUATION_RUNNER_FLAG,
                  },
                },
                select: { enabled: true },
              }),
            ])
            if (!venue)
              throw new TRPCError({
                code: 'NOT_FOUND',
                message: 'Venue was not found for this client',
              })

            const before = {
              durableGlobalEnabled: durableGlobalValueEnabled(globalRow?.value),
              tenantEnabled: tenantRow?.enabled === true,
            }
            if (
              before.durableGlobalEnabled !== input.expectedGlobalEnabled ||
              before.tenantEnabled !== input.expectedTenantEnabled
            )
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Evaluation readiness changed. Refresh before changing the durable gates.',
              })

            const changedAt = new Date()
            await transaction.platformConfig.upsert({
              where: { key: EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY },
              create: {
                key: EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY,
                value: { version: 1, enabled: input.enabled },
                updatedBy: ctx.session.userId,
              },
              update: {
                value: { version: 1, enabled: input.enabled },
                updatedBy: ctx.session.userId,
              },
            })
            await transaction.tenantFeatureFlag.upsert({
              where: {
                tenantId_flagKey: {
                  tenantId: input.tenantId,
                  flagKey: EVALUATION_RUNNER_FLAG,
                },
              },
              create: {
                tenantId: input.tenantId,
                flagKey: EVALUATION_RUNNER_FLAG,
                enabled: input.enabled,
                setBy: ctx.session.userId,
                metadata: { source: 'platform-admin', system: 'evaluation-operations' },
              },
              update: {
                enabled: input.enabled,
                setBy: ctx.session.userId,
                setAt: changedAt,
                metadata: { source: 'platform-admin', system: 'evaluation-operations' },
              },
            })
            const after = {
              durableGlobalEnabled: input.enabled,
              tenantEnabled: input.enabled,
            }
            await transaction.auditLog.create({
              data: {
                tenantId: input.tenantId,
                actorId: ctx.session.userId,
                actorRole: 'PLATFORM_ADMIN',
                action: input.enabled
                  ? 'admin.evaluation-runtime.enabled'
                  : 'admin.evaluation-runtime.disabled',
                targetType: 'EvaluationRuntimeGates',
                targetId: `${input.tenantId}:${input.venueId}`,
                structuredReason: {
                  venueId: input.venueId,
                  processGateChanged: false,
                  globalScope: true,
                },
                beforeState: before,
                afterState: after,
              },
            })
            return {
              ...after,
              apiProcessEnabled: env.EVALUATION_RUNNER_ENABLED,
              executionEnabled: env.EVALUATION_RUNNER_ENABLED && input.enabled,
            }
          },
          { isolationLevel: 'Serializable' },
        ),
      ),
    ),
})
