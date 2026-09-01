import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { aiCostDecimalToUnits, aiCostUnitsToDecimal } from '@pathfinder/ai'
import {
  AI_COST_BUDGET_COVERAGE_VERSION,
  db,
  reconcileExpiredAiCostAttempts,
  withTenantIsolationBypass,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { isUniqueConstraintError } from './helpers'

// Technical storage bound, not an invented commercial default: $10 million
// at 1e-8 USD precision leaves substantial BIGINT headroom for a fail-closed
// over-ceiling settlement.
const MAX_AI_COST_BUDGET_UNITS = 1_000_000_000_000_000n

const coverage = {
  version: AI_COST_BUDGET_COVERAGE_VERSION,
  excludedProviderPaths: [] as const,
}

const budgetInput = z
  .object({
    tenantId: z.string().min(1),
    enabled: z.boolean(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    hardLimitUsd: z
      .string()
      .trim()
      .max(32)
      .regex(/^\d+(?:\.\d{1,8})?$/),
    reason: z.string().trim().min(1).max(500),
    expectedRevision: z.number().int().positive().nullable(),
  })
  .strict()

const resetBudgetInput = z
  .object({
    tenantId: z.string().min(1),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    reason: z.string().trim().min(1).max(500),
    expectedRevision: z.number().int().positive(),
  })
  .strict()

function conflict(): never {
  throw new TRPCError({
    code: 'CONFLICT',
    message: 'AI cost budget changed; refresh and try again.',
  })
}

function serializeBudget(
  budget: {
    tenantId: string
    enabled: boolean
    startsAt: Date
    endsAt: Date
    limitUnits: bigint
    remainingUnits: bigint
    reservedUnits: bigint
    committedUnits: bigint
    epoch: number
    revision: number
    breachedAt: Date | null
    updatedBy: string
    reason: string
    createdAt: Date
    updatedAt: Date
  } | null,
) {
  if (!budget) return { configured: false as const, ...coverage }
  return {
    configured: true as const,
    ...coverage,
    tenantId: budget.tenantId,
    enabled: budget.enabled,
    startsAt: budget.startsAt,
    endsAt: budget.endsAt,
    hardLimitUsd: aiCostUnitsToDecimal(budget.limitUnits),
    remainingUsd: aiCostUnitsToDecimal(budget.remainingUnits),
    reservedUsd: aiCostUnitsToDecimal(budget.reservedUnits),
    committedUsd: aiCostUnitsToDecimal(budget.committedUnits),
    epoch: budget.epoch,
    revision: budget.revision,
    breachedAt: budget.breachedAt,
    updatedBy: budget.updatedBy,
    reason: budget.reason,
    createdAt: budget.createdAt,
    updatedAt: budget.updatedAt,
  }
}

export const adminCostBudgetRouter = router({
  getAiCostBudget: adminProcedure
    .input(z.object({ tenantId: z.string().min(1) }).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const tenant = await db.tenant.findUnique({
          where: { id: input.tenantId },
          select: { id: true },
        })
        if (!tenant) throw new TRPCError({ code: 'NOT_FOUND', message: 'Tenant not found.' })
        const budget = await db.aiCostBudget.findFirst({
          where: {
            tenantId: input.tenantId,
            coverageVersion: AI_COST_BUDGET_COVERAGE_VERSION,
          },
        })
        return serializeBudget(budget)
      }),
    ),

  setAiCostBudget: adminProcedure.input(budgetInput).mutation(async ({ ctx, input }) => {
    try {
      return await withTenantIsolationBypass(() =>
        db.$transaction(async (transaction) => {
          const tenant = await transaction.tenant.findUnique({
            where: { id: input.tenantId },
            select: { id: true },
          })
          if (!tenant) throw new TRPCError({ code: 'NOT_FOUND', message: 'Tenant not found.' })
          if (input.startsAt >= input.endsAt) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'AI cost budget start must be before its end.',
            })
          }
          if (input.enabled && input.endsAt <= new Date()) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'An enabled AI cost budget must end in the future.',
            })
          }
          const limitUnits = aiCostDecimalToUnits(input.hardLimitUsd)
          if (limitUnits <= 0n) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'AI cost budget must be positive.',
            })
          }
          if (limitUnits > MAX_AI_COST_BUDGET_UNITS) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'AI cost budget exceeds the supported technical limit.',
            })
          }

          const before = await transaction.aiCostBudget.findFirst({
            where: {
              tenantId: input.tenantId,
              coverageVersion: AI_COST_BUDGET_COVERAGE_VERSION,
            },
          })
          if (!before && input.expectedRevision !== null) conflict()
          if (before && input.expectedRevision !== before.revision) conflict()
          const exposureUnits = (before?.reservedUnits ?? 0n) + (before?.committedUnits ?? 0n)
          if (limitUnits < exposureUnits) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'AI cost budget cannot be below its committed and reserved exposure.',
            })
          }

          if (
            before &&
            before.enabled === input.enabled &&
            before.startsAt.getTime() === input.startsAt.getTime() &&
            before.endsAt.getTime() === input.endsAt.getTime() &&
            before.limitUnits === limitUnits &&
            before.reason === input.reason
          ) {
            return { ...serializeBudget(before), replayed: true }
          }

          const nextUpdatedAt = new Date(
            before ? Math.max(Date.now(), before.updatedAt.getTime() + 1) : Date.now(),
          )
          const remainingUnits = limitUnits - exposureUnits
          const next = before
            ? await transaction.aiCostBudget.updateMany({
                where: {
                  id: before.id,
                  tenantId: input.tenantId,
                  revision: before.revision,
                  remainingUnits: before.remainingUnits,
                  reservedUnits: before.reservedUnits,
                  committedUnits: before.committedUnits,
                  breachedAt: before.breachedAt,
                },
                data: {
                  enabled: input.enabled,
                  startsAt: input.startsAt,
                  endsAt: input.endsAt,
                  limitUnits,
                  remainingUnits,
                  revision: { increment: 1 },
                  updatedBy: ctx.session.userId,
                  reason: input.reason,
                  updatedAt: nextUpdatedAt,
                },
              })
            : null
          if (before && next?.count !== 1) conflict()

          const saved = before
            ? await transaction.aiCostBudget.findFirstOrThrow({
                where: { id: before.id, tenantId: input.tenantId },
              })
            : await transaction.aiCostBudget.create({
                data: {
                  tenantId: input.tenantId,
                  coverageVersion: AI_COST_BUDGET_COVERAGE_VERSION,
                  enabled: input.enabled,
                  startsAt: input.startsAt,
                  endsAt: input.endsAt,
                  limitUnits,
                  remainingUnits,
                  updatedBy: ctx.session.userId,
                  reason: input.reason,
                  updatedAt: nextUpdatedAt,
                },
              })

          await writeAuditLogStrict(
            {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: saved.enabled
                ? 'admin.ai-cost-budget.enabled'
                : 'admin.ai-cost-budget.disabled',
              targetType: 'AiCostBudget',
              targetId: saved.id,
              ...(before
                ? {
                    beforeState: {
                      enabled: before.enabled,
                      startsAt: before.startsAt.toISOString(),
                      endsAt: before.endsAt.toISOString(),
                      hardLimitUsd: aiCostUnitsToDecimal(before.limitUnits),
                      revision: before.revision,
                    },
                  }
                : {}),
              afterState: {
                enabled: saved.enabled,
                startsAt: saved.startsAt.toISOString(),
                endsAt: saved.endsAt.toISOString(),
                hardLimitUsd: aiCostUnitsToDecimal(saved.limitUnits),
                revision: saved.revision,
                reason: saved.reason,
                coverageVersion: saved.coverageVersion,
              },
            },
            transaction,
          )

          return { ...serializeBudget(saved), replayed: false }
        }),
      )
    } catch (error) {
      if (error instanceof TRPCError) throw error
      if (isUniqueConstraintError(error)) conflict()
      throw error
    }
  }),

  resetAiCostBudgetWindow: adminProcedure.input(resetBudgetInput).mutation(({ ctx, input }) =>
    withTenantIsolationBypass(async () => {
      if (input.startsAt >= input.endsAt) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'AI cost budget start must be before its end.',
        })
      }
      if (input.endsAt <= new Date()) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A reset AI cost budget must end in the future.',
        })
      }

      const reconciliation = await reconcileExpiredAiCostAttempts({
        db,
        tenantId: input.tenantId,
      })
      return db.$transaction(async (transaction) => {
        const before = await transaction.aiCostBudget.findFirst({
          where: {
            tenantId: input.tenantId,
            coverageVersion: AI_COST_BUDGET_COVERAGE_VERSION,
          },
        })
        if (!before) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'AI cost budget not found.' })
        }
        if (before.revision !== input.expectedRevision) conflict()
        if (before.enabled) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Disable the AI cost budget before resetting its window.',
          })
        }
        if (before.reservedUnits !== 0n) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'AI cost budget still has live reservations; retry after they expire.',
          })
        }

        const nextUpdatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
        const updated = await transaction.aiCostBudget.updateMany({
          where: {
            id: before.id,
            tenantId: input.tenantId,
            enabled: false,
            revision: before.revision,
            reservedUnits: 0n,
          },
          data: {
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            remainingUnits: before.limitUnits,
            committedUnits: 0n,
            breachedAt: null,
            epoch: { increment: 1 },
            revision: { increment: 1 },
            updatedBy: ctx.session.userId,
            reason: input.reason,
            updatedAt: nextUpdatedAt,
          },
        })
        if (updated.count !== 1) conflict()
        const saved = await transaction.aiCostBudget.findFirstOrThrow({
          where: { id: before.id, tenantId: input.tenantId },
        })

        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: ctx.session.userId,
            actorRole: 'PLATFORM_ADMIN',
            action: 'admin.ai-cost-budget.window-reset',
            targetType: 'AiCostBudget',
            targetId: saved.id,
            beforeState: {
              epoch: before.epoch,
              revision: before.revision,
              committedUsd: aiCostUnitsToDecimal(before.committedUnits),
              breachedAt: before.breachedAt?.toISOString() ?? null,
            },
            afterState: {
              epoch: saved.epoch,
              revision: saved.revision,
              startsAt: saved.startsAt.toISOString(),
              endsAt: saved.endsAt.toISOString(),
              hardLimitUsd: aiCostUnitsToDecimal(saved.limitUnits),
              reason: saved.reason,
              expiredReservationsSettled: reconciliation.settled,
            },
          },
          transaction,
        )

        return { ...serializeBudget(saved), reconciliation }
      })
    }),
  ),
})
