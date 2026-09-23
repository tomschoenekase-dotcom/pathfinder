import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { salesPrepareInput } from './prospect-sales-contract'

const base = { venueId: 'SYN-venue', expectedSnapshotHash: 'a'.repeat(64) }
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

describe('optional selected writing reference boundary', () => {
  it('allows preparation while Tom has not supplied a reference', () => {
    expect(salesPrepareInput.parse(base)).toEqual(base)
  })
  it('requires actual selected bytes; a source locator alone cannot fetch an unavailable file', () => {
    const text = 'Synthetic guidance café 🌿'
    const reference = { label: 'Test guidance', sourceRef: 'file:owner-selected',
      text, sha256: sha(text) }
    expect(salesPrepareInput.parse({ ...base, writingReference: reference })
      .writingReference).toEqual(reference)
    expect(salesPrepareInput.safeParse({ ...base,
      writingReference: { ...reference, text: undefined } }).success).toBe(false)
    expect(salesPrepareInput.safeParse({ ...base,
      writingReference: { ...reference, sha256: 'bad' } }).success).toBe(false)
  })
})
