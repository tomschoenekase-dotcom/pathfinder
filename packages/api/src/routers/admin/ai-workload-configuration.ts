import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  AI_CENTRAL_MODEL_REGISTRY,
  AI_INVENTORY_OMISSIONS,
  AI_PUBLIC_VISITOR_CHAT_ROUTE_KEYS,
  buildAiWorkloadInventory,
  modelIsSelectableForWorkload,
  resolveAiWorkloadConfiguration,
  type AiConfigurationOverride,
} from '@pathfinder/ai'
import {
  AiConfigurationActionError,
  configurationOverrideFromRow,
  configurationValuesFromRow,
  resetAiWorkloadConfigurationOverrideAction,
  saveAiWorkloadConfigurationOverrideAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { getVisitorProviderSetup, providerHasExecutionKey } from './ai-provider-connections'
import {
  saveInputSchema,
  scopeSchema,
  venueInputSchema,
  workloadIds,
} from './ai-workload-configuration-inputs'

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
  getAdminAiSystems: adminProcedure.query(async ({ ctx }) => {
    const workloadId = 'guest-chat' as const
    const [workloadRows, scopedExceptionCount] = await withTenantIsolationBypass(() =>
      Promise.all([
        ctx.db.aiWorkloadConfigurationOverride.findMany({
          where: { workloadId },
          select: persistedSelect,
        }),
        ctx.db.aiScopedWorkloadConfigurationOverride.count({
          where: { workloadId, enabled: true, isTombstone: false },
        }),
      ]),
    )
    const workloadRow = workloadRows[0]
    const overrides = workloadRow
      ? [configurationOverrideFromRow(workloadRow, { level: 'WORKLOAD', workloadId })]
      : []
    const effective = resolveAiWorkloadConfiguration({
      workloadId,
      ...(workloadId === 'guest-chat' &&
      process.env.GUEST_CHAT_DEFAULT_MODEL_KEY === 'guest-chat-luna'
        ? { defaultPrimaryModelKey: 'guest-chat-luna' as const }
        : {}),
      overrides,
    })
    const { providerKeyAvailability, providerConnections } = getVisitorProviderSetup()
    const options = AI_PUBLIC_VISITOR_CHAT_ROUTE_KEYS.map((key) => {
      const provider = AI_CENTRAL_MODEL_REGISTRY[key].provider
      return {
        key,
        provider,
        model: AI_CENTRAL_MODEL_REGISTRY[key].model,
        costTier: AI_CENTRAL_MODEL_REGISTRY[key].costTier,
        available: providerKeyAvailability[provider],
      }
    })

    return {
      customerChat: {
        workloadId,
        effective: {
          primaryModelKey: effective.primaryModelKey,
          provider: effective.model.provider,
          model: effective.model.model,
          source: effective.sources.primaryModelKey,
        },
        workloadOverride: storedState(workloadRow),
        modelOptions: options,
        providerConnections,
        providerKeyAvailability,
        scopedExceptionCount,
      },
      limitations: {
        providerExecution: false as const,
        deepSeek: true as const,
        openRouter: false as const,
        priceTierRouting: false as const,
      },
    }
  }),

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
      const operationalInventory = buildAiWorkloadInventory()
      const allModelOptions = workloadIds.map((key) => {
        const provider = AI_CENTRAL_MODEL_REGISTRY[key].provider
        return {
          key,
          kind: AI_CENTRAL_MODEL_REGISTRY[key].kind,
          provider,
          model: AI_CENTRAL_MODEL_REGISTRY[key].model,
          available: providerHasExecutionKey(provider),
        }
      })

      return {
        scope: { tenantId: input.tenantId, venueId: input.venueId },
        readOnly: false as const,
        stagedControlPlane: true as const,
        providerExecution: false as const,
        operationalInventory: {
          entries: operationalInventory,
          omissions: AI_INVENTORY_OMISSIONS,
          measurementStatus:
            'Provider configuration, provider latency, estimated provider cost, and invoice cost are unknown on this read surface.' as const,
        },
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
            modelOptions: allModelOptions.filter((option) =>
              modelIsSelectableForWorkload(option.key, workloadId),
            ),
          }
        }),
      }
    }),

  saveAiWorkloadConfigurationOverride: adminProcedure
    .input(saveInputSchema)
    .mutation(async ({ ctx, input }) => {
      const selectedKeys = [
        ...(input.values.primaryModelKey ? [input.values.primaryModelKey] : []),
        ...(input.values.fallback?.enabled ? input.values.fallback.modelKeys : []),
      ]
      const unavailableProviders = [
        ...new Set(
          selectedKeys
            .map((key) => AI_CENTRAL_MODEL_REGISTRY[key].provider)
            .filter((provider) => !providerHasExecutionKey(provider)),
        ),
      ]
      if (input.enabled && unavailableProviders.length > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot enable this AI route because provider configuration is missing: ${unavailableProviders.join(', ')}`,
        })
      }
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
