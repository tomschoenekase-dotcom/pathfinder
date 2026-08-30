import { describe, expect, it } from 'vitest'

import { resolveReleaseRevision } from './release-identity'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

describe('resolveReleaseRevision', () => {
  it.each(['RAILWAY_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_SHA', 'GIT_COMMIT_SHA'])(
    'accepts an exact provider revision from %s',
    (key) => {
      expect(resolveReleaseRevision({ [key]: SHA_A.toUpperCase() })).toBe(SHA_A)
    },
  )

  it('accepts the exact reviewed release fallback when provider metadata is absent', () => {
    expect(resolveReleaseRevision({ PATHFINDER_RELEASE_SHA: ` ${SHA_A.toUpperCase()} ` })).toBe(
      SHA_A,
    )
  })

  it('accepts matching provider and reviewed release identities', () => {
    expect(
      resolveReleaseRevision({
        RAILWAY_GIT_COMMIT_SHA: SHA_A,
        PATHFINDER_RELEASE_SHA: SHA_A,
      }),
    ).toBe(SHA_A)
  })

  it.each([
    {},
    { RAILWAY_GIT_COMMIT_SHA: 'abc123' },
    { PATHFINDER_RELEASE_SHA: 'not-a-revision' },
    { RAILWAY_GIT_COMMIT_SHA: SHA_A, PATHFINDER_RELEASE_SHA: SHA_B },
    { RAILWAY_GIT_COMMIT_SHA: SHA_A, VERCEL_GIT_COMMIT_SHA: SHA_B },
    { RAILWAY_GIT_COMMIT_SHA: SHA_A, PATHFINDER_RELEASE_SHA: 'invalid' },
  ])('fails closed for absent, invalid, or conflicting identity: %o', (environment) => {
    expect(resolveReleaseRevision(environment)).toBe('unknown')
  })
})
