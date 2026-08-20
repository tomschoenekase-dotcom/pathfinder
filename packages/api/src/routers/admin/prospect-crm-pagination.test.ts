import { describe, expect, it } from 'vitest'

import {
  decodeProspectCursor,
  encodeProspectCursor,
  prospectCursorWhere,
} from './prospect-crm-pagination'

describe('prospect composite cursor', () => {
  it('round-trips the stable updatedAt/id ordering boundary', () => {
    const updatedAt = new Date('2026-08-20T12:00:00.000Z')
    const encoded = encodeProspectCursor({ updatedAt, id: 'prospect-009' })
    const decoded = decodeProspectCursor(encoded)

    expect(decoded).toEqual({ updatedAt: updatedAt.toISOString(), id: 'prospect-009' })
    expect(prospectCursorWhere(decoded)).toEqual({
      OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: 'prospect-009' } }],
    })
  })

  it('rejects opaque but malformed cursors', () => {
    expect(() => decodeProspectCursor(Buffer.from('{}').toString('base64url'))).toThrow(
      'Invalid prospect pagination cursor',
    )
  })
})
