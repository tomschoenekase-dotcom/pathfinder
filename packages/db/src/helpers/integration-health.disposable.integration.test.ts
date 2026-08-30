import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import {
  claimIntakeUploadVerificationAction,
  recordIntakeUploadPrecheckAction,
} from './intake-upload-actions'
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
    await Promise.all([
      db.platformConfig.upsert({
        where: { key: 'global-ai-control-v1' },
        create: {
          key: 'global-ai-control-v1',
          value: {
            schemaVersion: 1,
            paused: true,
            reason: 'private disposable global incident reason',
          },
          updatedBy: 'private-disposable-operator',
        },
        update: {
          value: {
            schemaVersion: 1,
            paused: true,
            reason: 'private disposable global incident reason',
          },
          updatedBy: 'private-disposable-operator',
        },
      }),
      db.platformConfig.upsert({
        where: { key: 'ai-provider-health-control-v1' },
        create: {
          key: 'ai-provider-health-control-v1',
          value: {
            schemaVersion: 1,
            overrides: [
              {
                provider: 'openai',
                reason: 'private disposable provider incident reason',
                expiresAt: '2030-01-01T13:00:00.000Z',
              },
            ],
          },
          updatedBy: 'private-disposable-operator',
        },
        update: {
          value: {
            schemaVersion: 1,
            overrides: [
              {
                provider: 'openai',
                reason: 'private disposable provider incident reason',
                expiresAt: '2030-01-01T13:00:00.000Z',
              },
            ],
          },
          updatedBy: 'private-disposable-operator',
        },
      }),
    ])
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
    const objectGenerationA = randomUUID()
    await db.intakeUpload.createMany({
      data: [
        {
          tenantId: tenantA,
          venueId: venueA,
          requestId: randomUUID(),
          requestHash: 'b'.repeat(64),
          displayName: 'Verified storage proof',
          fileName: 'proof-a.txt',
          mimeType: 'image/png',
          byteSize: 1,
          sha256: 'c'.repeat(64),
          objectKey: `private/${tenantA}/proof-a.txt`,
          objectGeneration: objectGenerationA,
          requestedBy: 'disposable-proof',
          requestedByRole: 'PLATFORM_ADMIN',
        },
        {
          tenantId: tenantB,
          venueId: venueB,
          requestId: randomUUID(),
          requestHash: 'd'.repeat(64),
          displayName: 'Unverified storage proof',
          fileName: 'proof-b.txt',
          mimeType: 'image/png',
          byteSize: 1,
          sha256: 'e'.repeat(64),
          objectKey: `private/${tenantB}/proof-b.txt`,
          objectGeneration: randomUUID(),
          requestedBy: 'disposable-proof',
          requestedByRole: 'PLATFORM_ADMIN',
        },
      ],
    })
    const uploadA = await db.intakeUpload.findFirstOrThrow({
      where: { tenantId: tenantA, venueId: venueA },
      select: { id: true },
    })
    const verificationClaimId = randomUUID()
    const actor = {
      type: 'HUMAN' as const,
      id: 'disposable-proof',
      role: 'PLATFORM_ADMIN' as const,
    }
    await claimIntakeUploadVerificationAction({
      tenantId: tenantA,
      venueId: venueA,
      uploadId: uploadA.id,
      actor,
      claimId: verificationClaimId,
    })
    await recordIntakeUploadPrecheckAction({
      tenantId: tenantA,
      venueId: venueA,
      uploadId: uploadA.id,
      actor,
      claimId: verificationClaimId,
      verified: {
        objectGeneration: objectGenerationA,
        storageVersionId: 'private-storage-version-a',
        mimeType: 'image/png',
        byteSize: 1,
        sha256: 'c'.repeat(64),
      },
      evidence: {
        engine: 'disposable-storage-proof',
        engineVersion: '1',
        verdictHash: 'f'.repeat(64),
        computedByteSize: 1,
        computedSha256: 'c'.repeat(64),
      },
    })
    await db.analyticsEvent.createMany({
      data: [
        {
          tenantId: tenantA,
          venueId: venueA,
          eventType: 'session.started',
          occurredAt: new Date('2030-01-01T10:00:00.000Z'),
        },
        {
          tenantId: tenantB,
          venueId: venueB,
          eventType: 'session.started',
          occurredAt: new Date('2030-01-01T10:00:00.000Z'),
        },
      ],
    })
    await db.jobRecord.createMany({
      data: [
        {
          queue: 'disposable-daily-rollup',
          jobName: 'daily-rollup-process',
          tenantId: tenantA,
          status: 'COMPLETE',
          startedAt: new Date('2030-01-01T10:30:00.000Z'),
          completedAt: new Date('2030-01-01T10:31:00.000Z'),
        },
        {
          queue: 'disposable-daily-rollup',
          jobName: 'daily-rollup-process',
          tenantId: tenantB,
          status: 'FAILED',
          error: 'private analytics failure detail',
          failureDisposition: 'ATTEMPTS_EXHAUSTED',
          terminalAt: new Date('2030-01-01T10:31:00.000Z'),
          startedAt: new Date('2030-01-01T10:30:00.000Z'),
          completedAt: new Date('2030-01-01T10:31:00.000Z'),
        },
      ],
    })
  })

  afterAll(async () => {
    if (!safeTarget) return
    // Intake and content evidence is append-only by design. The outer proof removes the exact
    // disposable database container instead of weakening lifecycle guards for fixture cleanup.
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
        expect.objectContaining({ integration: 'OBJECT_STORAGE', state: 'HEALTHY' }),
        expect.objectContaining({ integration: 'ANALYTICS_PIPELINE', state: 'HEALTHY' }),
        expect.objectContaining({
          integration: 'GLOBAL_AI_ADMISSION',
          state: 'OFFLINE',
          errorCategory: 'GLOBAL_AI_PAUSED',
        }),
        expect.objectContaining({
          integration: 'AI_PROVIDERS',
          state: 'OFFLINE',
          errorCategory: 'GLOBAL_AI_PAUSED',
        }),
      ]),
    )
    expect(healthA.controlPlane).toMatchObject({
      globalAiAdmission: { state: 'PAUSED', admissionOpen: false, configured: true },
      providerRouting: {
        state: 'DEGRADED',
        routingAvailable: true,
        configured: true,
        activeExclusions: [{ provider: 'openai', expiresAt: '2030-01-01T13:00:00.000Z' }],
      },
      boundaries: {
        incidentReasonIncluded: false,
        operatorIdentityIncluded: false,
        mutationAuthorized: false,
        automaticRecoveryAuthorized: false,
      },
    })
    expect(healthB.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ integration: 'GMAIL', state: 'DEGRADED' }),
        expect.objectContaining({
          integration: 'EMBEDDINGS',
          state: 'DEGRADED',
          lastSuccessAt: null,
          lastFailureAt: expect.any(String),
        }),
        expect.objectContaining({
          integration: 'OBJECT_STORAGE',
          state: 'DEGRADED',
          errorCategory: 'NO_VERIFIED_OBJECT',
        }),
        expect.objectContaining({
          integration: 'ANALYTICS_PIPELINE',
          state: 'DEGRADED',
          errorCategory: 'ATTEMPTS_EXHAUSTED',
        }),
      ]),
    )
    expect(JSON.stringify([healthA, healthB])).not.toMatch(
      /@example\.invalid|SYNTHETIC_AUTH_FAILURE|Disposable failure evidence|synthetic-provider-failure|private-storage-version-a|private analytics failure detail|private disposable global incident reason|private disposable provider incident reason|private-disposable-operator/u,
    )
  })
})
