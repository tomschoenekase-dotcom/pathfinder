import { createHash } from 'node:crypto'

import { SourceConnectionConfigSchema, type SourceConnectionConfig } from './source-connections'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Approval hash excludes the approval receipt itself, so any URL/mapping/policy edit invalidates it. */
export function sourceConnectionConfigHash(config: SourceConnectionConfig): string {
  const body = { ...SourceConnectionConfigSchema.parse(config) }
  delete body.approval
  return createHash('sha256').update(canonical(body)).digest('hex')
}

export function sourceConnectionSnapshotHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}
