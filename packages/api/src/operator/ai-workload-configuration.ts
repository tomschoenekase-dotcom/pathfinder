import { AI_CENTRAL_MODEL_REGISTRY, modelIsSelectableForWorkload } from '@pathfinder/ai'
import { configurationValuesFromRow, resolveRuntimeAiWorkloadConfiguration } from '@pathfinder/db'
import { scopeSchema } from '../routers/admin/ai-workload-configuration-inputs'
import { providerHasExecutionKey } from '../routers/admin/ai-provider-connections'
import type { OperatorDatabase } from './audit'

export function venueAiScope(args: { tenantId: string; venueId: string; workloadId: string }) {
  const scope = scopeSchema.parse({
    level: 'VENUE',
    tenantId: args.tenantId,
    venueId: args.venueId,
    workloadId: args.workloadId,
  })
  if (scope.level !== 'VENUE') throw new Error('Venue scope required')
  return scope
}

export function readVenueAiOverride(
  args: { tenantId: string; venueId: string; workloadId: string },
  database: OperatorDatabase,
) {
  const scope = venueAiScope(args)
  return database.aiScopedWorkloadConfigurationOverride.findFirst({
    where: { tenantId: scope.tenantId, venueScopeKey: scope.venueId, workloadId: scope.workloadId },
  })
}

export async function readVenueAiConfiguration(
  args: { tenantId: string; venueId: string; workloadId: string },
  database: OperatorDatabase,
) {
  const scope = venueAiScope(args)
  const [effective, row] = await Promise.all([
    resolveRuntimeAiWorkloadConfiguration(scope, database),
    readVenueAiOverride(args, database),
  ])
  return {
    workloadId: scope.workloadId,
    availableWorkloads: Object.keys(AI_CENTRAL_MODEL_REGISTRY).sort(),
    providerExecution: false as const,
    stagedControlPlane: true as const,
    effective: {
      primaryModelKey: effective.primaryModelKey,
      provider: effective.model.provider,
      model: effective.model.model,
      fallback: effective.fallback,
      timeoutMs: effective.timeoutMs,
      maxAttempts: effective.maxAttempts,
      maxOutputTokens: effective.maxOutputTokens,
      requestBudgetCeilingE8Usd: effective.requestBudgetCeilingE8Usd,
      sources: effective.sources,
    },
    venueOverride: row
      ? {
          revision: row.revision,
          enabled: row.enabled,
          isTombstone: row.isTombstone,
          values: configurationValuesFromRow(row),
          unsafeChangesEnabled: row.unsafeChangesEnabled,
        }
      : null,
    modelOptions: Object.values(AI_CENTRAL_MODEL_REGISTRY)
      .filter((model) => modelIsSelectableForWorkload(model.key, scope.workloadId))
      .map((model) => ({
        key: model.key,
        provider: model.provider,
        model: model.model,
        available: providerHasExecutionKey(model.provider),
      })),
  }
}
