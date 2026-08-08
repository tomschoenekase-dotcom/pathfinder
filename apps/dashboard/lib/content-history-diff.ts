export type ChangedField = { key: string; before: unknown; after: unknown }

type Snapshot = Record<string, unknown> | null

const IDENTITY_FIELDS = new Set(['id', 'tenantId', 'venueId'])

function asSnapshot(value: unknown): Snapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function changedSnapshotFields(beforeValue: unknown, afterValue: unknown): ChangedField[] {
  const before = asSnapshot(beforeValue)
  const after = asSnapshot(afterValue)
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])

  return [...keys]
    .filter((key) => !IDENTITY_FIELDS.has(key))
    .filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]))
    .sort()
    .map((key) => ({ key, before: before?.[key], after: after?.[key] }))
}

export function currentDeletedVersions<
  T extends { entityType: string; entityId: string; afterState: unknown },
>(versions: T[]): T[] {
  const seen = new Set<string>()
  const deleted: T[] = []
  for (const version of versions) {
    const key = `${version.entityType}:${version.entityId}`
    if (seen.has(key)) continue
    seen.add(key)
    if (version.afterState === null) deleted.push(version)
  }
  return deleted
}
