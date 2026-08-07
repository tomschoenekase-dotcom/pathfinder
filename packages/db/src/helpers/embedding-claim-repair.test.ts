import { afterEach, describe, expect, it } from 'vitest'

import { repairCompleteClaimMissingVector } from './embedding-claim-repair'

const originalRailwayEnvironment = process.env.RAILWAY_ENVIRONMENT
const originalDispatchEnabled = process.env.EMBEDDING_DISPATCH_ENABLED

afterEach(() => {
  if (originalRailwayEnvironment === undefined) delete process.env.RAILWAY_ENVIRONMENT
  else process.env.RAILWAY_ENVIRONMENT = originalRailwayEnvironment
  if (originalDispatchEnabled === undefined) delete process.env.EMBEDDING_DISPATCH_ENABLED
  else process.env.EMBEDDING_DISPATCH_ENABLED = originalDispatchEnabled
})

describe('embedding claim repair mutation boundary', () => {
  const params = {
    tenantId: 'tenant',
    venueId: 'venue',
    entityType: 'PLACE' as const,
    entityId: 'place',
    expectedProfile: 'profile',
    actorId: 'operator',
  }

  it('rejects production before opening a transaction', async () => {
    process.env.RAILWAY_ENVIRONMENT = 'production'
    process.env.EMBEDDING_DISPATCH_ENABLED = 'false'
    await expect(repairCompleteClaimMissingVector(params)).rejects.toThrow(
      'RAILWAY_ENVIRONMENT=staging',
    )
  })

  it('rejects a locally enabled dispatcher before opening a transaction', async () => {
    process.env.RAILWAY_ENVIRONMENT = 'staging'
    process.env.EMBEDDING_DISPATCH_ENABLED = 'true'
    await expect(repairCompleteClaimMissingVector(params)).rejects.toThrow(
      'EMBEDDING_DISPATCH_ENABLED=false',
    )
  })
})
