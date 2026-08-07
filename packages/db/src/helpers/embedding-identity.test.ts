import { describe, expect, it } from 'vitest'

import { embeddingSourceHash } from './embedding-identity'

describe('embeddingSourceHash', () => {
  it('is stable and domain-separated by entity type', () => {
    const place = embeddingSourceHash('place', 'same canonical text')
    expect(place).toMatch(/^[a-f0-9]{64}$/)
    expect(place).toBe(embeddingSourceHash('place', 'same canonical text'))
    expect(place).not.toBe(embeddingSourceHash('knowledge-entry', 'same canonical text'))
  })
})
