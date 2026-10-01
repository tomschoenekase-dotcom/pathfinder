/**
 * Every operator list returns `complete`, true only when no further page exists, so a capped page
 * is never mistaken for the whole set. Keep all list handlers on this helper.
 */
export function pageResult<T>(items: T[], nextCursor: string | null) {
  return { items, nextCursor, complete: nextCursor === null }
}

/** A cursor that points outside the caller's own result set (foreign, stale or invented). */
export class OperatorInvalidCursorError extends Error {
  readonly code = 'INVALID_CURSOR'
  constructor() {
    super('Cursor does not belong to this query')
  }
}

/**
 * Prisma resolves a cursor by reading the row it names, so a cursor from another scope would
 * otherwise act as an ordering oracle over rows the caller cannot see. Every list checks that the
 * cursor row satisfies the same predicate as the query before using it.
 */
export async function requireCursorInScope(
  cursor: string | undefined,
  lookup: (cursor: string) => Promise<unknown>,
): Promise<void> {
  if (cursor === undefined) return
  if (!(await lookup(cursor))) throw new OperatorInvalidCursorError()
}

/** Compound keyset cursor for lists ordered by a timestamp that can tie: `<iso>|<id>`. */
export function encodeKeysetCursor(at: Date, id: string): string {
  return `${at.toISOString()}|${id}`
}

export function decodeKeysetCursor(cursor: string): { at: Date; id: string } {
  const separator = cursor.indexOf('|')
  const at = new Date(cursor.slice(0, separator))
  const id = cursor.slice(separator + 1)
  if (separator < 1 || id.length === 0 || Number.isNaN(at.getTime())) {
    throw new OperatorInvalidCursorError()
  }
  return { at, id }
}
