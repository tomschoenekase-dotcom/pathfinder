import { describe, expect, it } from 'vitest'

import { assertStagingWorkerReleaseIdentity } from './worker-release-identity'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

describe('staging worker release identity', () => {
  it('accepts matching provider and reviewed release identities', () => {
    expect(
      assertStagingWorkerReleaseIdentity({
        RAILWAY_ENVIRONMENT: 'staging',
        RAILWAY_GIT_COMMIT_SHA: SHA_A,
        PATHFINDER_RELEASE_SHA: SHA_A,
      }),
    ).toBe(SHA_A)
  })

  it.each([
    { RAILWAY_ENVIRONMENT: 'staging' },
    { RAILWAY_ENVIRONMENT: 'staging', PATHFINDER_RELEASE_SHA: 'invalid' },
    {
      RAILWAY_ENVIRONMENT: 'staging',
      RAILWAY_GIT_COMMIT_SHA: SHA_A,
      PATHFINDER_RELEASE_SHA: SHA_B,
    },
  ])('rejects missing, invalid, or conflicting staging identity before startup', (environment) => {
    expect(() => assertStagingWorkerReleaseIdentity(environment)).toThrow(
      'staging-worker-release-identity-invalid',
    )
  })

  it('does not impose the staging admission rule on other environments', () => {
    expect(assertStagingWorkerReleaseIdentity({ RAILWAY_ENVIRONMENT: 'preview' })).toBeNull()
  })
})
