import { describe, expect, it } from 'vitest'

import { classifyPublicVenueLookupError } from './public-venue-error'

describe('classifyPublicVenueLookupError', () => {
  it('recognizes server-side not-found errors', () => {
    expect(classifyPublicVenueLookupError({ code: 'NOT_FOUND' })).toBe('not-found')
  })

  it('recognizes browser-side unavailable errors', () => {
    expect(classifyPublicVenueLookupError({ data: { code: 'SERVICE_UNAVAILABLE' } })).toBe(
      'temporarily-unavailable',
    )
  })

  it('does not disguise unexpected failures as venue availability states', () => {
    expect(classifyPublicVenueLookupError(new Error('database offline'))).toBe('other')
  })
})
