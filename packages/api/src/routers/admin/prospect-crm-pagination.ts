import { z } from 'zod'

const cursorShape = z
  .object({ updatedAt: z.string().datetime(), id: z.string().min(1).max(191) })
  .strict()

export type ProspectCompositeCursor = z.infer<typeof cursorShape>

export function encodeProspectCursor(cursor: { updatedAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: cursor.updatedAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url')
}

export function decodeProspectCursor(value: string): ProspectCompositeCursor {
  try {
    return cursorShape.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  } catch {
    throw new Error('Invalid prospect pagination cursor')
  }
}

/** Keyset predicate matching `updatedAt DESC, id DESC`. */
export function prospectCursorWhere(cursor: ProspectCompositeCursor) {
  const updatedAt = new Date(cursor.updatedAt)
  return {
    OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: cursor.id } }],
  }
}
