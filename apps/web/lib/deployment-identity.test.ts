import { describe, expect, it } from 'vitest'

import { deploymentIdentity } from './deployment-identity'

describe('deploymentIdentity', () => {
  it('uses the reviewed exact release fallback and rejects provider drift', () => {
    const revision = 'a'.repeat(40)
    expect(deploymentIdentity({ PATHFINDER_RELEASE_SHA: revision })).toMatchObject({ revision })
    expect(
      deploymentIdentity({
        RAILWAY_GIT_COMMIT_SHA: 'b'.repeat(40),
        PATHFINDER_RELEASE_SHA: revision,
      }),
    ).toMatchObject({ revision: 'unknown' })
  })

  it('returns only bounded non-secret resource identity', () => {
    expect(
      deploymentIdentity({
        RAILWAY_ENVIRONMENT: 'staging',
        DATABASE_RESOURCE_ID: 'database-id',
        REDIS_RESOURCE_ID: 'redis-id',
        STORAGE_RESOURCE_ID: 'storage-id',
        DATABASE_URL: 'secret-database-url',
      }),
    ).toEqual({
      environment: 'staging',
      revision: 'unknown',
      resources: { database: 'database-id', redis: 'redis-id', storage: 'storage-id' },
    })
  })
})
