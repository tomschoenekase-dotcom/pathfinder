import { createHash } from 'node:crypto'

export const compareCodePoints = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0
const canonicalJson = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonicalJson).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => compareCodePoints(a, b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
          .join(',')}}`
      : JSON.stringify(value)
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')

/** Shared manifest identity; object key order from PostgreSQL JSONB is irrelevant. */
export const intakeV1ManifestHash = (manifest: unknown): string => digest(manifest)
