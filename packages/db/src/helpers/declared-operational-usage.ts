import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

type UsageClient = Pick<typeof db, 'intakeUpload' | 'mediaIngestionProject' | 'mediaIngestionAsset'>

type ScopeUsage = {
  tenantId: string
  venueId: string
  intakeDeclaredBytes: bigint
  mediaDeclaredBytes: bigint
}

function scopeKey(tenantId: string, venueId: string) {
  return `${tenantId}\u0000${venueId}`
}

function getScope(scopes: Map<string, ScopeUsage>, tenantId: string, venueId: string) {
  const key = scopeKey(tenantId, venueId)
  const current = scopes.get(key)
  if (current) return current
  const created = {
    tenantId,
    venueId,
    intakeDeclaredBytes: 0n,
    mediaDeclaredBytes: 0n,
  }
  scopes.set(key, created)
  return created
}

/**
 * Aggregates database-declared object bytes. This is not an object-store bill,
 * retained-object inventory, transfer total, or dollar-cost calculation.
 */
export async function inspectDeclaredOperationalUsage(now = new Date(), client: UsageClient = db) {
  if (!Number.isFinite(now.getTime())) throw new Error('Usage observation time must be valid.')

  const [intake, projects, assets] = await withTenantIsolationBypass(() =>
    Promise.all([
      client.intakeUpload.groupBy({
        by: ['tenantId', 'venueId'],
        _sum: { byteSize: true },
        _count: { _all: true },
      }),
      client.mediaIngestionProject.findMany({
        select: { id: true, tenantId: true, venueId: true, sourceBytes: true },
      }),
      client.mediaIngestionAsset.groupBy({
        by: ['tenantId', 'projectId'],
        _sum: { bytes: true },
        _count: { _all: true },
      }),
    ]),
  )

  const scopes = new Map<string, ScopeUsage>()
  for (const row of intake) {
    const scope = getScope(scopes, row.tenantId, row.venueId)
    scope.intakeDeclaredBytes = BigInt(row._sum.byteSize ?? 0)
  }

  const projectScopes = new Map<string, { tenantId: string; venueId: string }>()
  for (const project of projects) {
    projectScopes.set(project.id, { tenantId: project.tenantId, venueId: project.venueId })
    const scope = getScope(scopes, project.tenantId, project.venueId)
    scope.mediaDeclaredBytes += project.sourceBytes ?? 0n
  }
  for (const row of assets) {
    const projectScope = projectScopes.get(row.projectId)
    if (!projectScope || projectScope.tenantId !== row.tenantId) {
      throw new Error('Media usage scope could not be reconciled to its project.')
    }
    const scope = getScope(scopes, projectScope.tenantId, projectScope.venueId)
    scope.mediaDeclaredBytes += row._sum.bytes ?? 0n
  }

  return {
    observedAt: now,
    scopeCount: scopes.size,
    scopes: [...scopes.values()].sort(
      (left, right) =>
        left.tenantId.localeCompare(right.tenantId) || left.venueId.localeCompare(right.venueId),
    ),
    limitations: {
      providerInventoryObserved: false as const,
      retentionStateObserved: false as const,
      transferBytesObserved: false as const,
      dollarCostAssigned: false as const,
    },
  }
}
