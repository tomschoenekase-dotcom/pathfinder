import { UnrecoverableError } from 'bullmq'
import { describe, expect, it } from 'vitest'

import { embeddingRevisionMatches, parseEmbeddingRevision } from './embedding-revision'

describe('embedding revision tokens', () => {
  it('accepts canonical UTC timestamps and compares exact milliseconds', () => {
    const revision = parseEmbeddingRevision('2026-08-07T18:00:00.123Z')
    expect(embeddingRevisionMatches(new Date('2026-08-07T18:00:00.123Z'), revision)).toBe(true)
    expect(embeddingRevisionMatches(new Date('2026-08-07T18:00:00.124Z'), revision)).toBe(false)
  })

  it.each(['not-a-date', '2026-08-07', '2026-08-07T18:00:00.123+00:00'])(
    'rejects noncanonical revision %s',
    (value) => expect(() => parseEmbeddingRevision(value)).toThrow(UnrecoverableError),
  )
})
