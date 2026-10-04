import { createHash } from 'node:crypto'

import { OperatorInvalidCursorError } from './page'

/**
 * Opaque list cursors bound to the query that issued them. A cursor carries a version tag, a short
 * hash of the normalized query (tool, scope, filters, sort) and the handler's last-row position.
 * Reusing it on a different query is refused instead of silently skipping rows.
 */
const VERSION = 'c1'
const HASH_LENGTH = 16
/** Keys that never change which rows match: paging controls only. */
const PAGING_KEYS = new Set(['cursor', 'limit'])

export type CursorQuery = Readonly<{
  tool: string
  /** `tenant:<id>` or `platform`. */
  scope: string
  /** Sort order of the list; a user-selectable sort is passed as a filter instead. */
  sort?: string
  filters: Readonly<Record<string, unknown>>
}>

const WRONG_QUERY = 'This cursor belongs to a different query; restart the list without a cursor.'
const MALFORMED = 'This cursor is not valid; restart the list without a cursor.'

function normalize(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    // Ids are case-sensitive; every other text filter is matched case-insensitively.
    return /(^id$|Ids?$)/u.test(key) ? trimmed : trimmed.toLowerCase()
  }
  if (Array.isArray(value)) return value.map((item) => normalize(key, item))
  if (value && typeof value === 'object') return normalizeRecord(value as Record<string, unknown>)
  return value
}

function normalizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    const value = record[key]
    if (value === undefined || PAGING_KEYS.has(key)) continue
    out[key] = normalize(key, value)
  }
  return out
}

export function queryHash(query: CursorQuery): string {
  const canonical = JSON.stringify({
    v: VERSION,
    tool: query.tool,
    scope: query.scope,
    sort: query.sort ?? null,
    filters: normalizeRecord({ ...query.filters }),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, HASH_LENGTH)
}

/** Wraps a handler position (any non-empty string) into a cursor bound to `query`. */
export function issueBoundCursor(query: CursorQuery, position: string): string {
  return Buffer.from(JSON.stringify({ v: VERSION, q: queryHash(query), p: position })).toString(
    'base64url',
  )
}

/** Returns the handler position, or throws OperatorInvalidCursorError for a cursor not issued for `query`. */
export function readBoundCursor(query: CursorQuery, cursor: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new OperatorInvalidCursorError(MALFORMED)
  }
  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  if (
    !record ||
    record.v !== VERSION ||
    typeof record.q !== 'string' ||
    typeof record.p !== 'string' ||
    record.p.length === 0
  ) {
    throw new OperatorInvalidCursorError(MALFORMED)
  }
  if (record.q !== queryHash(query)) throw new OperatorInvalidCursorError(WRONG_QUERY)
  return record.p
}

/**
 * Applies bound cursors around a list handler: unwraps the incoming cursor into the handler's own
 * position and wraps the outgoing `nextCursor`. A page that has a next cursor is never complete,
 * and a page without one is complete.
 */
export async function withBoundCursor(
  query: CursorQuery,
  args: Record<string, unknown>,
  run: (args: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const incoming = typeof args.cursor === 'string' ? args.cursor : undefined
  const inner =
    incoming === undefined ? args : { ...args, cursor: readBoundCursor(query, incoming) }
  const result = await run(inner)
  if (!result || typeof result !== 'object' || !('nextCursor' in result)) return result
  const page = result as { nextCursor: unknown }
  if (typeof page.nextCursor === 'string') {
    return {
      ...page,
      nextCursor: issueBoundCursor(query, page.nextCursor),
      complete: false,
    }
  }
  return page.nextCursor === null ? { ...page, complete: true } : result
}
