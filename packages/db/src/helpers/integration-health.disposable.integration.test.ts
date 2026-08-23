import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { readUnifiedIntegrationHealth } from './integration-health'

const enabled = process.env.RUN_PLATFORM_INTEGRATION_HEALTH_DB_INTEGRATION === '1'

describe.skipIf(!enabled)('unified integration health (disposable PostgreSQL)', () => {
  const suffix = randomUUID()
  const tenantA = `integration-health-a-${suffix}`
  const tenantB = `integration-health-b-${suffix}`
  const venueA = `integration-health-venue-a-${suffix}`
  const venueB = `integration-health-venue-b-${suffix}`
  const placeA = `integration-health-place-a-${suffix}`
  const placeB = `integration-health-place-b-${suffix}`
  const healthyMailboxId = `integration-health-mailbox-ok-${suffix}`
  const failedMailboxId = `integration-health-mailbox-failed-${suffix}`
  let safeTarget = false

  beforeAll(async () => {
    const databaseUrl = new URL(process.env.DATABASE_URL ?? '')
    if (
      !['localhost', '127.0.0.1'].includes(databaseUrl.hostname) ||
      !databaseUrl.pathname.slice(1).startsWith('pathfinder_disposable_')
    ) {
      throw new Error('Integration health proof requires an exact loopback disposable database.')
    }
    safeTarget = true

    await db.tenant.createMany({
      data: [
        { id: tenantA, name: 'Integration health A', slug: tenantA },
        { id: tenantB, name: 'Integration health B', slug: tenantB },
      ],
    })
    await db.venue.createMany({
      data: [
        { id: venueA, tenantId: tenantA, name: 'Integration health venue A', slug: venueA },
        { id: venueB, tenantId: tenantB, name: 'Integration health venue B', slug: venueB },
      ],
    })
    const createdPlaceA = await db.place.create({
      data: { id: placeA, tenantId: tenantA, venueId: venueA, name: 'Place A', type: 'exhibit' },
    })
    await db.place.create({
      data: { id: placeB, tenantId: tenantB, venueId: venueB, name: 'Place B', type: 'exhibit' },
    })
    await db.embeddingWorkClaim.create({
      data: {
        id: randomUUID(),
        tenantId: tenantA,
        venueId: venueA,
        entityType: 'PLACE',
        entityId: placeA,
        contentUpdatedAt: createdPlaceA.updatedAt,
        sourceHash: 'a'.repeat(64),
        embeddingProfile: 'disposable:test:1536',
        status: 'COMPLETE',
        completedAt: new Date('2030-01-01T11:00:00.000Z'),
      },
    })
    const failedDispatch = await db.embeddingDispatch.updateMany({
      where: { id: `place:${placeB}`, tenantId: tenantB, venueId: venueB },
      data: { attempts: 1, lastError: 'synthetic-provider-failure' },
    })
    expect(failedDispatch.count).toBe(1)
    await db.correspondenceProviderAccount.createMany({
      data: [
        {
          id: healthyMailboxId,
          provider: 'GMAIL',
          externalAccountId: healthyMailboxId,
          mailboxAddress: `${healthyMailboxId}@example.invalid`,
          connectionStatus: 'CONNECTED',
          lastSuccessfulSyncAt: new Date('2030-01-01T11:00:00.000Z'),
          createdBy: 'disposable-proof',
          updatedBy: 'disposable-proof',
        },
        {
          id: failedMailboxId,
          provider: 'GMAIL',
          externalAccountId: failedMailboxId,
          mailboxAddress: `${failedMailboxId}@example.invalid`,
          connectionStatus: 'CONNECTED',
          lastHealthCheckAt: new Date('2030-01-01T11:30:00.000Z'),
          healthErrorCode: 'SYNTHETIC_AUTH_FAILURE',
          healthErrorSummary: 'Disposable failure evidence',
          createdBy: 'disposable-proof',
          updatedBy: 'disposable-proof',
        },
      ],
    })
  })

  afterAll(async () => {
    if (!safeTarget) return
    await db.correspondenceProviderAccount.deleteMany({
      where: { id: { in: [healthyMailboxId, failedMailboxId] } },
    })
    await db.embeddingDispatch.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await db.embeddingWorkClaim.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await db.place.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await db.venue.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await db.$disconnect()
  })

  it('keeps tenant embedding evidence isolated while aggregating secret-free shared mailbox health', async () => {
    const now = new Date('2030-01-01T12:00:00.000Z')
    const [healthA, healthB] = await Promise.all([
      readUnifiedIntegrationHealth({ clientId: tenantA, venueIds: [venueA] }, db, now),
      readUnifiedIntegrationHealth({ clientId: tenantB, venueIds: [venueB] }, db, now),
    ])

    expect(healthA.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ integration: 'GMAIL', state: 'DEGRADED' }),
        expect.objectContaining({
          integration: 'EMBEDDINGS',
          state: 'HEALTHY',
          lastSuccessAt: expect.any(String),
          lastFailureAt: null,
        }),
      ]),
    )
    expect(healthB.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ integration: 'GMAIL', state: 'DEGRADED' }),
        expect.objectContaining({
          integration: 'EMBEDDINGS',
          state: 'DEGRADED',
          lastSuccessAt: null,
          lastFailureAt: expect.any(String),
        }),
      ]),
    )
    expect(JSON.stringify([healthA, healthB])).not.toMatch(
      /@example\.invalid|SYNTHETIC_AUTH_FAILURE|Disposable failure evidence|synthetic-provider-failure/u,
    )
  })
})
