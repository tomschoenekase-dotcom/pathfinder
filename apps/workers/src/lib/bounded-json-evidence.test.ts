import { describe, expect, it } from 'vitest'

import { selectJsonEvidencePrefix } from './bounded-json-evidence'

describe('selectJsonEvidencePrefix', () => {
  it('selects a chronological prefix at the exact ASCII byte limit', () => {
    const items = [{ text: 'one' }, { text: 'two' }, { text: 'three' }]
    const limit = Buffer.byteLength(JSON.stringify(items.slice(0, 2)), 'utf8')

    expect(selectJsonEvidencePrefix(items, limit)).toEqual({
      items: items.slice(0, 2),
      jsonUtf8Bytes: limit,
      omitted: 1,
    })
  })

  it('counts UTF-8 emoji and escaped quotes/backslashes exactly', () => {
    const items = [{ text: '🧭 "north" \\ gallery' }, { text: 'ordinary' }]
    const limit = Buffer.byteLength(JSON.stringify(items.slice(0, 1)), 'utf8')

    expect(selectJsonEvidencePrefix(items, limit)).toMatchObject({
      items: items.slice(0, 1),
      jsonUtf8Bytes: limit,
      omitted: 1,
    })
  })

  it('returns an empty prefix when the first item would overflow', () => {
    const items = [{ text: 'too large' }]
    expect(selectJsonEvidencePrefix(items, 2)).toEqual({
      items: [],
      jsonUtf8Bytes: 2,
      omitted: 1,
    })
  })

  it('returns the exact empty-array size', () => {
    expect(selectJsonEvidencePrefix([], 2)).toEqual({ items: [], jsonUtf8Bytes: 2, omitted: 0 })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, 1, 0, -2])(
    'rejects invalid byte budget %s',
    (budget) => {
      expect(() => selectJsonEvidencePrefix([], budget)).toThrow(RangeError)
    },
  )

  it('does not mutate readonly input records or ordering', () => {
    const items = Object.freeze([{ text: 'first' }, { text: 'second' }])
    const before = JSON.stringify(items)
    const result = selectJsonEvidencePrefix(items, 2)

    expect(JSON.stringify(items)).toBe(before)
    expect(result.items).toEqual([])
  })
})
