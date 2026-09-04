import { randomUUID } from 'node:crypto'

import { env } from '@pathfinder/config'
import {
  db,
  EVALUATION_AUTHORIZED_PROVIDERS,
  EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY,
  MAX_EVALUATION_AUTHORIZATION_BUDGET_E8_USD,
  parseEvaluationRuntimeAuthorization,
  setContentVersionContext,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const EVALUATION_RUNNER_FLAG = 'evaluation-runner-v1'
const EVALUATION_ENABLE_CONFIRMATION = 'ENABLE EVALUATION RUNNER'

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
          durationMinutes: z.number().int().min(5).max(120).optional(),
          maxBudgetE8Usd: z.string().regex(/^\d+$/u).optional(),
          allowedProviders: z
            .array(z.enum(EVALUATION_AUTHORIZED_PROVIDERS))
            .min(1)
            .max(2)
            .optional(),
        })
        .strict()
        .superRefine((value, context) => {
          if (!value.enabled) return
          if (value.durationMinutes === undefined)
            context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duration is required' })
          if (value.maxBudgetE8Usd === undefined)
            context.addIssue({ code: z.ZodIssueCode.custom, message: 'Budget is required' })
          if (value.allowedProviders === undefined)
            context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provider scope is required' })
        }),
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
            const maximumBudget = input.maxBudgetE8Usd ? BigInt(input.maxBudgetE8Usd) : 0n
            if (
              input.enabled &&
              (maximumBudget <= 0n || maximumBudget > MAX_EVALUATION_AUTHORIZATION_BUDGET_E8_USD)
            )
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'Authorization budget must be within the evaluation hard limit',
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
              durableGlobalEnabled:
                parseEvaluationRuntimeAuthorization(globalRow?.value, new Date()) !== null,
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
            const authorizationId = input.enabled ? randomUUID() : null
            const expiresAt = input.enabled
              ? new Date(changedAt.getTime() + input.durationMinutes! * 60_000)
              : null
            const durableValue = input.enabled
              ? {
                  version: 2,
                  enabled: true,
                  authorizationId: authorizationId!,
                  authorizedAt: changedAt.toISOString(),
                  expiresAt: expiresAt!.toISOString(),
                  maxBudgetE8Usd: maximumBudget.toString(),
                  allowedProviders: [...new Set(input.allowedProviders!)],
                }
              : { version: 2, enabled: false, disabledAt: changedAt.toISOString() }
            await transaction.platformConfig.upsert({
              where: { key: EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY },
              create: {
                key: EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY,
                value: durableValue,
                updatedBy: ctx.session.userId,
              },
              update: {
                value: durableValue,
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
                metadata: {
                  source: 'platform-admin',
                  system: 'evaluation-operations',
                  ...(authorizationId
                    ? { authorizationId, expiresAt: expiresAt!.toISOString() }
                    : {}),
                },
              },
              update: {
                enabled: input.enabled,
                setBy: ctx.session.userId,
                setAt: changedAt,
                metadata: {
                  source: 'platform-admin',
                  system: 'evaluation-operations',
                  ...(authorizationId
                    ? { authorizationId, expiresAt: expiresAt!.toISOString() }
                    : {}),
                },
              },
            })
            const after = {
              durableGlobalEnabled: input.enabled,
              tenantEnabled: input.enabled,
              authorizationId,
              expiresAt: expiresAt?.toISOString() ?? null,
              maxBudgetE8Usd: input.enabled ? maximumBudget.toString() : null,
              allowedProviders: input.enabled ? [...new Set(input.allowedProviders!)] : [],
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
                  authorizationIsExpiring: input.enabled,
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
