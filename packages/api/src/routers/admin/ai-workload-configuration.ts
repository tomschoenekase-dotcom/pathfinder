import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  AI_CENTRAL_MODEL_REGISTRY,
  resolveAiWorkloadConfiguration,
  type AiConfigurationOverride,
  type AiWorkloadId,
} from '@pathfinder/ai'
import {
  AiConfigurationActionError,
  configurationOverrideFromRow,
  configurationValuesFromRow,
  resetAiWorkloadConfigurationOverrideAction,
  saveAiWorkloadConfigurationOverrideAction,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const venueInputSchema = z
  .object({ tenantId: z.string().min(1).max(128), venueId: z.string().min(1).max(128) })
  .strict()

const workloadIds = Object.keys(AI_CENTRAL_MODEL_REGISTRY).sort() as [
  AiWorkloadId,
  ...AiWorkloadId[],
]
const workloadIdSchema = z.enum(workloadIds)

const scopeSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('WORKLOAD'), workloadId: workloadIdSchema }).strict(),
  z
    .object({
      level: z.literal('CLIENT'),
      tenantId: z.string().min(1).max(128),
      workloadId: workloadIdSchema,
    })
    .strict(),
  z
    .object({
      level: z.literal('VENUE'),
      tenantId: z.string().min(1).max(128),
      venueId: z.string().min(1).max(128),
      workloadId: workloadIdSchema,
    })
    .strict(),
])

const valuesSchema = z
  .object({
    primaryModelKey: workloadIdSchema.optional(),
    fallback: z
      .object({ enabled: z.boolean(), modelKeys: z.array(workloadIdSchema).max(3) })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
    maxAttempts: z.number().int().min(1).max(5).optional(),
    maxOutputTokens: z.number().int().min(1).max(32_000).nullable().optional(),
    requestBudgetCeilingE8Usd: z.string().regex(/^\d+$/u).nullable().optional(),
  })
  .strict()

const saveInputSchema = z
  .object({
    scope: scopeSchema,
    expectedRevision: z.number().int().positive().nullable(),
    enabled: z.boolean(),
    values: valuesSchema,
    unsafeChangesEnabled: z.boolean().default(false),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .superRefine((input, context) => {
    const expectedKind = AI_CENTRAL_MODEL_REGISTRY[input.scope.workloadId].kind
    const selectedKeys = [
      ...(input.values.primaryModelKey ? [input.values.primaryModelKey] : []),
      ...(input.values.fallback?.modelKeys ?? []),
    ]
    if (selectedKeys.some((key) => AI_CENTRAL_MODEL_REGISTRY[key].kind !== expectedKind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['values'],
        message: 'AI model selections cannot cross workload model kinds',
      })
    }
  })

const persistedSelect = {
  id: true,
  workloadId: true,
  enabled: true,
  primaryModelKey: true,
  primaryModelKeySet: true,
  fallbackEnabled: true,
  fallbackEnabledSet: true,
  fallbackModelKeys: true,
  fallbackModelKeysSet: true,
  timeoutMs: true,
  timeoutMsSet: true,
  maxAttempts: true,
  maxAttemptsSet: true,
  maxOutputTokens: true,
  maxOutputTokensSet: true,
  requestBudgetCeilingE8Usd: true,
  requestBudgetCeilingE8UsdSet: true,
  unsafeChangesEnabled: true,
  isTombstone: true,
  reason: true,
  revision: true,
  createdBy: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
} as const

function mapActionError(error: unknown): never {
  if (error instanceof AiConfigurationActionError) {
    const code =
      error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.code === 'CONFLICT'
          ? 'CONFLICT'
          : 'BAD_REQUEST'
    throw new TRPCError({ code, message: error.message })
  }
  throw error
}

function storedState(row: Parameters<typeof configurationValuesFromRow>[0] | undefined) {
  if (!row) return null
  return {
    id: row.id,
    enabled: row.enabled,
    values: configurationValuesFromRow(row),
    unsafeChangesEnabled: row.unsafeChangesEnabled,
    isTombstone: row.isTombstone,
    reason: row.reason,
    revision: row.revision,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const adminAiWorkloadConfigurationRouter = router({
  getVenueAiWorkloadConfiguration: adminProcedure
    .input(venueInputSchema)
    .query(async ({ ctx, input }) => {
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })

      const [workloadRows, clientRows, venueRows] = await Promise.all([
        ctx.db.aiWorkloadConfigurationOverride.findMany({ select: persistedSelect }),
        ctx.db.aiScopedWorkloadConfigurationOverride.findMany({
          where: { tenantId: input.tenantId, venueScopeKey: '__client__' },
          select: persistedSelect,
        }),
        ctx.db.aiScopedWorkloadConfigurationOverride.findMany({
          where: { tenantId: input.tenantId, venueScopeKey: input.venueId },
          select: persistedSelect,
        }),
      ])
      const byWorkload = (rows: typeof workloadRows) =>
        new Map(rows.map((row) => [row.workloadId, row]))
      const workloadMap = byWorkload(workloadRows)
      const clientMap = byWorkload(clientRows)
      const venueMap = byWorkload(venueRows)

      return {
        scope: { tenantId: input.tenantId, venueId: input.venueId },
        readOnly: false as const,
        stagedControlPlane: true as const,
        providerExecution: false as const,
        layers: [
          {
            level: 'PLATFORM' as const,
            availability: 'AVAILABLE' as const,
            detail: 'Versioned registry defaults.',
          },
          {
            level: 'WORKLOAD' as const,
            availability: 'AVAILABLE' as const,
            detail: 'Global workload override.',
          },
          {
            level: 'CLIENT' as const,
            availability: 'AVAILABLE' as const,
            detail: 'Client-scoped override.',
          },
          {
            level: 'VENUE' as const,
            availability: 'AVAILABLE' as const,
            detail: 'Venue-scoped override.',
          },
        ] satisfies Array<{
          level: 'PLATFORM' | 'WORKLOAD' | 'CLIENT' | 'VENUE'
          availability: 'AVAILABLE' | 'UNAVAILABLE'
          detail: string
        }>,
        budgetIntegration: {
          availability: 'STAGED' as const,
          detail:
            'A request ceiling is configuration metadata; runtime AiBudgetGate remains authoritative.',
        },
        modelOptions: workloadIds.map((key) => ({
          key,
          kind: AI_CENTRAL_MODEL_REGISTRY[key].kind,
          provider: AI_CENTRAL_MODEL_REGISTRY[key].provider,
          model: AI_CENTRAL_MODEL_REGISTRY[key].model,
        })),
        workloads: workloadIds.map((workloadId) => {
          const workloadRow = workloadMap.get(workloadId)
          const clientRow = clientMap.get(workloadId)
          const venueRow = venueMap.get(workloadId)
          const overrides = [
            workloadRow
              ? configurationOverrideFromRow(workloadRow, { level: 'WORKLOAD', workloadId })
              : null,
            clientRow
              ? configurationOverrideFromRow(clientRow, {
                  level: 'CLIENT',
                  tenantId: input.tenantId,
                  workloadId,
                })
              : null,
            venueRow
              ? configurationOverrideFromRow(venueRow, {
                  level: 'VENUE',
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  workloadId,
                })
              : null,
          ].filter((value): value is AiConfigurationOverride => value !== null)
          const effective = resolveAiWorkloadConfiguration({
            workloadId,
            clientId: input.tenantId,
            venueId: input.venueId,
            overrides,
          })
          return {
            workloadId,
            kind: effective.kind,
            provider: effective.model.provider,
            model: effective.model.model,
            effective: {
              primaryModelKey: effective.primaryModelKey,
              fallback: effective.fallback,
              timeoutMs: effective.timeoutMs,
              maxAttempts: effective.maxAttempts,
              maxOutputTokens: effective.maxOutputTokens,
              requestBudgetCeilingE8Usd: effective.requestBudgetCeilingE8Usd,
              sources: effective.sources,
            },
            effectiveSource: effective.sources.primaryModelKey,
            fallback: effective.fallback,
            requestBudgetCeilingE8Usd: effective.requestBudgetCeilingE8Usd,
            unsafeChangesEnabled: venueRow?.unsafeChangesEnabled ?? false,
            overrides: {
              workload: storedState(workloadRow),
              client: storedState(clientRow),
              venue: storedState(venueRow),
            },
            pricingEstimate: {
              version: effective.model.pricingVersion,
              usdPerMillionTokens: effective.model.pricingUsdPerMillionTokens,
              invoiceAmount: false as const,
            },
            limits: effective.model.limits,
          }
        }),
      }
    }),

  saveAiWorkloadConfigurationOverride: adminProcedure
    .input(saveInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const saved = await saveAiWorkloadConfigurationOverrideAction({
          ...input,
          actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
        return { id: saved.id, revision: saved.revision, enabled: saved.enabled }
      } catch (error) {
        mapActionError(error)
      }
    }),

  resetAiWorkloadConfigurationOverride: adminProcedure
    .input(
      z
        .object({
          scope: scopeSchema,
          expectedRevision: z.number().int().positive(),
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const saved = await resetAiWorkloadConfigurationOverrideAction({
          ...input,
          actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
        return { id: saved.id, revision: saved.revision, isTombstone: saved.isTombstone }
      } catch (error) {
        mapActionError(error)
      }
    }),
})
