import {
  assessRetentionReadiness,
  RETENTION_DATA_INVENTORY,
  RETENTION_DISPOSITION_PREVIEW_VERSION,
  type RetentionDispositionBlocker,
  type RetentionDispositionInventoryItem,
  type RetentionDispositionPreview,
  type RetentionInventoryEntry,
  type RetentionPolicySet,
} from '@pathfinder/contracts'

import { PLATFORM_TABLES, SHARED_SCOPE_TABLES, TENANTED_TABLES } from '../tenanted-tables'

type CountDelegate = {
  count(args: { where: { tenantId: string } }): Promise<number>
}

export type RetentionDispositionPreviewClient = {
  tenant: {
    findUnique(args: {
      where: { id: string }
      select: { id: true }
    }): Promise<{ id: string } | null>
  }
} & Record<string, unknown>

export type RetentionDispositionPreviewInput = Readonly<{
  tenantId: string
  policy?: RetentionPolicySet | null
  generatedAt?: Date
  countBatchSize?: number
}>

const DEFAULT_COUNT_BATCH_SIZE = 12

function delegateName(model: string): string {
  return `${model.slice(0, 1).toLowerCase()}${model.slice(1)}`
}

function inventoryByModel(): ReadonlyMap<string, RetentionInventoryEntry> {
  return new Map(RETENTION_DATA_INVENTORY.map((entry) => [entry.model, entry]))
}

function itemMetadata(
  model: string,
  registry: ReadonlyMap<string, RetentionInventoryEntry>,
): Pick<
  RetentionDispositionInventoryItem,
  | 'decisionKey'
  | 'lifecycle'
  | 'deletionBoundary'
  | 'containsPersonalData'
  | 'clientExportEligible'
  | 'notes'
> {
  const entry = registry.get(model)
  return entry
    ? {
        decisionKey: entry.decisionKey,
        lifecycle: entry.lifecycle,
        deletionBoundary: entry.deletionBoundary,
        containsPersonalData: entry.containsPersonalData,
        clientExportEligible: entry.clientExportEligible,
        notes: entry.notes,
      }
    : {
        decisionKey: null,
        lifecycle: null,
        deletionBoundary: null,
        containsPersonalData: null,
        clientExportEligible: null,
        notes: 'No owner/legal retention classification exists for this model.',
      }
}

async function countTenantLinkedModels(
  client: RetentionDispositionPreviewClient,
  tenantId: string,
  models: readonly string[],
  batchSize: number,
): Promise<ReadonlyMap<string, number | null>> {
  const counts = new Map<string, number | null>()
  for (let offset = 0; offset < models.length; offset += batchSize) {
    const batch = models.slice(offset, offset + batchSize)
    const results = await Promise.allSettled(
      batch.map(async (model) => {
        const delegate = client[delegateName(model)] as CountDelegate | undefined
        if (!delegate || typeof delegate.count !== 'function') {
          throw new Error(`Prisma count delegate unavailable for ${model}`)
        }
        return delegate.count({ where: { tenantId } })
      }),
    )
    results.forEach((result, index) => {
      const model = batch[index]!
      counts.set(
        model,
        result.status === 'fulfilled' && Number.isSafeInteger(result.value) && result.value >= 0
          ? result.value
          : null,
      )
    })
  }
  return counts
}

function pushBlocker(
  blockers: RetentionDispositionBlocker[],
  blocker: RetentionDispositionBlocker,
) {
  if (!blockers.includes(blocker)) blockers.push(blocker)
}

/**
 * Produces a full-client, read-only inventory. It performs no revocation, deletion,
 * anonymization, object-store request, provider request, approval, or policy persistence.
 */
export async function previewRetentionDispositionAction(
  input: RetentionDispositionPreviewInput,
  client: RetentionDispositionPreviewClient,
): Promise<RetentionDispositionPreview> {
  const tenantId = input.tenantId.trim()
  if (!tenantId) throw new Error('A tenant id is required for retention disposition preview.')
  const batchSize = input.countBatchSize ?? DEFAULT_COUNT_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 25) {
    throw new Error('Retention disposition count batch size must be between 1 and 25.')
  }

  const tenant = await client.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })
  const tenantExists = tenant?.id === tenantId
  const tenantLinkedModels = [...TENANTED_TABLES, ...SHARED_SCOPE_TABLES]
  const counts = tenantExists
    ? await countTenantLinkedModels(client, tenantId, tenantLinkedModels, batchSize)
    : new Map(tenantLinkedModels.map((model) => [model, 0]))
  const registry = inventoryByModel()

  const inventory: RetentionDispositionInventoryItem[] = [
    {
      model: 'Tenant',
      scopeClass: 'TENANT_ROOT',
      countState: 'EXACT',
      rowCount: tenantExists ? '1' : '0',
      ...itemMetadata('Tenant', registry),
    },
    ...TENANTED_TABLES.map((model) => {
      const count = counts.get(model) ?? null
      return {
        model,
        scopeClass: 'TENANT_DIRECT' as const,
        countState: count === null ? ('UNAVAILABLE' as const) : ('EXACT' as const),
        rowCount: count === null ? null : String(count),
        ...itemMetadata(model, registry),
      }
    }),
    ...SHARED_SCOPE_TABLES.map((model) => {
      const count = counts.get(model) ?? null
      return {
        model,
        scopeClass: 'SHARED_TENANT_LINK' as const,
        countState: count === null ? ('UNAVAILABLE' as const) : ('EXACT' as const),
        rowCount: count === null ? null : String(count),
        ...itemMetadata(model, registry),
      }
    }),
    ...PLATFORM_TABLES.filter((model) => model !== 'Tenant').map((model) => ({
      model,
      scopeClass: 'PLATFORM_UNSCOPED' as const,
      countState: 'UNSCOPED' as const,
      rowCount: null,
      ...itemMetadata(model, registry),
    })),
  ]

  const policy = assessRetentionReadiness(input.policy ?? null)
  const unavailableCountModels = inventory.filter(
    (item) => item.countState === 'UNAVAILABLE',
  ).length
  const tenantLinkedUnclassifiedModels = inventory.filter(
    (item) => item.scopeClass !== 'PLATFORM_UNSCOPED' && item.decisionKey === null,
  ).length
  const exactTenantLinkedRows = inventory.reduce(
    (total, item) => total + (item.countState === 'EXACT' ? BigInt(item.rowCount ?? '0') : 0n),
    0n,
  )
  const blockers: RetentionDispositionBlocker[] = []
  if (!tenantExists) pushBlocker(blockers, 'TENANT_NOT_FOUND')
  if (!policy.ready) pushBlocker(blockers, 'UNRESOLVED_POLICY')
  if (tenantLinkedUnclassifiedModels > 0) pushBlocker(blockers, 'UNCLASSIFIED_TENANT_DATA')
  if (PLATFORM_TABLES.some((model) => model !== 'Tenant'))
    pushBlocker(blockers, 'PLATFORM_UNSCOPED_DATA')
  if (RETENTION_DATA_INVENTORY.some((entry) => entry.lifecycle === 'EXTERNAL_REFERENCE'))
    pushBlocker(blockers, 'EXTERNAL_ARTIFACTS_NOT_COUNTED')
  if (unavailableCountModels > 0) pushBlocker(blockers, 'COUNT_UNAVAILABLE')
  pushBlocker(blockers, 'NO_REVIEWED_EXECUTOR')

  return {
    schemaVersion: RETENTION_DISPOSITION_PREVIEW_VERSION,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    scope: { tenantId, venueIds: null, fullTenantOnly: true },
    mode: 'READ_ONLY_NO_EFFECT',
    tenantExists,
    policy,
    coverage: {
      exactCountedModels: inventory.filter((item) => item.countState === 'EXACT').length,
      unavailableCountModels,
      tenantLinkedUnclassifiedModels,
      platformUnscopedModels: inventory.filter((item) => item.scopeClass === 'PLATFORM_UNSCOPED')
        .length,
      policyMappedModels: inventory.filter((item) => item.decisionKey !== null).length,
      exactTenantLinkedRows: exactTenantLinkedRows.toString(),
    },
    inventory,
    blockers,
    boundaries: {
      readyForExecution: false,
      destructiveActionAvailable: false,
      anonymizationActionAvailable: false,
      approvalGrantAvailable: false,
      externalArtifactsCounted: false,
      providerRecordsCounted: false,
      backupRestoreTreatmentResolved: false,
    },
  }
}
