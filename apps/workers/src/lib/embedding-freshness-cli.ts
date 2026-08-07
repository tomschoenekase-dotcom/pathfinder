import { EMBEDDING_FRESHNESS_CANARY_MAX, insertEmbeddingFreshnessCanary } from '@pathfinder/db'
import { CONTENT_EMBEDDING_MAX_ATTEMPTS } from '@pathfinder/jobs/embedding-policy'

import {
  ACTIONABLE_EMBEDDING_FRESHNESS_REASONS,
  type ActionableEmbeddingFreshnessReason,
  auditEmbeddingFreshness,
} from './embedding-freshness'

type AuditCommand = {
  mode: 'audit'
  tenantId: string
  venueId?: string
  scanCap?: number
}

type CanaryCommand = {
  mode: 'canary'
  tenantId: string
  venueId: string
  scanCap?: number
  entityType: 'PLACE' | 'KNOWLEDGE_ENTRY'
  reason: ActionableEmbeddingFreshnessReason
  limit: number
  dispatcherDisabledAsserted: true
}

export type EmbeddingFreshnessCommand = AuditCommand | CanaryCommand

function readArguments(argv: string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Expected --name value arguments; invalid token ${key ?? '<missing>'}`)
    }
    if (values.has(key)) throw new Error(`Duplicate argument ${key}`)
    values.set(key, value)
  }
  return values
}

function positiveInteger(value: string | undefined, name: string, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`)
  }
  return parsed
}

export function parseEmbeddingFreshnessArgs(
  argv: string[],
  environment: NodeJS.ProcessEnv,
): EmbeddingFreshnessCommand {
  const args = readArguments(argv)
  const tenantId = args.get('--tenant-id')
  if (!tenantId) throw new Error('--tenant-id is required')
  const venueId = args.get('--venue-id')
  const scanCapValue = args.get('--scan-cap')
  const scanCap = scanCapValue ? positiveInteger(scanCapValue, '--scan-cap', 10_000) : undefined
  const reasonValue = args.get('--canary-reason')

  if (!reasonValue)
    return {
      mode: 'audit',
      tenantId,
      ...(venueId ? { venueId } : {}),
      ...(scanCap ? { scanCap } : {}),
    }

  if (environment.RAILWAY_ENVIRONMENT !== 'staging') {
    throw new Error('Canary mode requires RAILWAY_ENVIRONMENT=staging')
  }
  if (environment.EMBEDDING_DISPATCH_ENABLED !== 'false') {
    throw new Error('Canary mode requires explicit EMBEDDING_DISPATCH_ENABLED=false')
  }
  if (!venueId) throw new Error('Canary mode requires --venue-id')
  if (!(ACTIONABLE_EMBEDDING_FRESHNESS_REASONS as readonly string[]).includes(reasonValue)) {
    throw new Error('--canary-reason must be an actionable freshness reason')
  }
  const entityType = args.get('--entity-type')
  if (entityType !== 'PLACE' && entityType !== 'KNOWLEDGE_ENTRY') {
    throw new Error('Canary mode requires --entity-type PLACE or KNOWLEDGE_ENTRY')
  }
  const limit = positiveInteger(
    args.get('--canary-limit'),
    '--canary-limit',
    EMBEDDING_FRESHNESS_CANARY_MAX,
  )
  const confirmedEntities = positiveInteger(
    args.get('--confirm-canary-entities'),
    '--confirm-canary-entities',
    EMBEDDING_FRESHNESS_CANARY_MAX,
  )
  if (confirmedEntities !== limit) {
    throw new Error(`--confirm-canary-entities must equal --canary-limit (${limit})`)
  }
  if (args.get('--confirm-dispatcher-disabled') !== 'true') {
    throw new Error('Canary mode requires --confirm-dispatcher-disabled true')
  }

  return {
    mode: 'canary',
    tenantId,
    venueId,
    ...(scanCap ? { scanCap } : {}),
    entityType,
    reason: reasonValue as ActionableEmbeddingFreshnessReason,
    limit,
    dispatcherDisabledAsserted: true,
  }
}

export async function runEmbeddingFreshnessCommand(command: EmbeddingFreshnessCommand) {
  const audit = await auditEmbeddingFreshness({
    tenantId: command.tenantId,
    ...(command.venueId ? { venueId: command.venueId } : {}),
    ...(command.scanCap ? { scanCap: command.scanCap } : {}),
  })
  if (command.mode === 'audit') return { mode: 'audit' as const, audit }
  if (audit.truncated) throw new Error('Canary selection refuses a truncated audit')

  const selected = audit.actionableCandidates
    .filter(
      (candidate) =>
        candidate.entityType === command.entityType && candidate.primaryReason === command.reason,
    )
    .sort((a, b) => a.entityId.localeCompare(b.entityId))
    .slice(0, command.limit)
  const result =
    selected.length === 0
      ? { inserted: [] as string[], skipped: [] as string[] }
      : await insertEmbeddingFreshnessCanary({
          tenantId: command.tenantId,
          venueId: command.venueId,
          targets: selected.map((candidate) => ({
            entityType: candidate.entityType,
            entityId: candidate.entityId,
            contentUpdatedAt: candidate.contentUpdatedAt,
          })),
        })

  return {
    mode: 'canary' as const,
    audit,
    selection: {
      entityType: command.entityType,
      reason: command.reason,
      requestedLimit: command.limit,
      selectedIds: selected.map((candidate) => candidate.entityId),
    },
    dispatch: result,
    providerEstimate: {
      insertedEntities: result.inserted.length,
      configuredAttemptsPerJob: CONTENT_EMBEDDING_MAX_ATTEMPTS,
      attemptsIfOneJobPerEntity: result.inserted.length * CONTENT_EMBEDDING_MAX_ATTEMPTS,
      hardUpperBound: false,
      limitation:
        'Existing or duplicate BullMQ jobs are not observable from this database-only tool.',
    },
    dispatcherDisablement: {
      localProcessEnvDisabled: true,
      operatorAssertedWorkerDisabled: command.dispatcherDisabledAsserted,
      independentlyVerified: false,
    },
  }
}
