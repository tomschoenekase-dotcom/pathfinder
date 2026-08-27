import { createHash, randomUUID } from 'node:crypto'

import {
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { readControlledVenueMediaDerivative } from '@pathfinder/api/venue-media-delivery'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'

import type * as DatabaseModule from '@pathfinder/db'

import { processVenueMediaDerivativeJob } from './processors/venue-media-derivative'

const CONFIRMATION = 'pathfinder_disposable_venue_media_derivative'
const enabled =
  process.env.RUN_VENUE_MEDIA_DERIVATIVE_DB_INTEGRATION === '1' &&
  process.env.PATHFINDER_DISPOSABLE_VENUE_MEDIA_CONFIRMATION === CONFIRMATION

function assertDisposableBoundary(): void {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '')
  const directDatabaseUrl = new URL(process.env.DIRECT_DATABASE_URL ?? '')
  const storageUrl = new URL(process.env.STORAGE_ENDPOINT ?? '')
  if (
    databaseUrl.toString() !== directDatabaseUrl.toString() ||
    databaseUrl.hostname !== '127.0.0.1' ||
    !/^\/pathfinder_disposable_venue_media_[a-z0-9_]+$/u.test(databaseUrl.pathname) ||
    !databaseUrl.port ||
    storageUrl.protocol !== 'http:' ||
    storageUrl.hostname !== '127.0.0.1' ||
    !storageUrl.port ||
    storageUrl.username ||
    storageUrl.password ||
    process.env.RAILWAY_ENVIRONMENT !== 'preview' ||
    process.env.OUTBOUND_PROVIDER_WORKERS_ENABLED !== 'false'
  ) {
    throw new Error(
      'Shakedown requires exact disposable loopback infrastructure and provider-dark preview scope.',
    )
  }
  if (!/^pathfinder-disposable-intake-[a-z0-9-]+$/u.test(process.env.STORAGE_BUCKET ?? '')) {
    throw new Error('Disposable storage bucket identity is invalid.')
  }
}

describe.runIf(enabled)('controlled venue media derivative disposable shakedown', () => {
  let database: typeof DatabaseModule
  let storage: S3Client
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const tenantId = `tenant-venue-media-${suffix}`
  const venueId = `venue-media-${suffix}`
  const venueSlug = `venue-media-${suffix}`
  let uploadId = ''
  const assetId = randomUUID()
  const derivativeId = randomUUID()
  const sourceGeneration = randomUUID()
  const sourceObjectKey = `intake-quarantine/${randomUUID()}`
  const sourceBytesPromise = sharp({
    create: { width: 1024, height: 640, channels: 3, background: '#246a73' },
  })
    .png()
    .toBuffer()

  beforeAll(async () => {
    assertDisposableBoundary()
    database = await import('@pathfinder/db')
    storage = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT!,
      forcePathStyle: true,
      region: process.env.STORAGE_REGION!,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
      },
    })
    await storage.send(new CreateBucketCommand({ Bucket: process.env.STORAGE_BUCKET! }))
    await storage.send(
      new PutBucketVersioningCommand({
        Bucket: process.env.STORAGE_BUCKET!,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    )
  }, 120_000)

  afterAll(async () => {
    storage?.destroy()
    await database?.db.$disconnect()
  })

  it('migrates, derives, verifies controlled delivery, and revokes delivery immediately', async () => {
    const sourceBytes = await sourceBytesPromise
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
    const put = await storage.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_BUCKET!,
        Key: sourceObjectKey,
        Body: sourceBytes,
        ContentLength: sourceBytes.byteLength,
        ContentType: 'image/png',
        ChecksumSHA256: Buffer.from(sourceSha256, 'hex').toString('base64'),
        Metadata: { 'pf-intake-upload-generation': sourceGeneration },
      }),
    )
    if (!put.VersionId || put.VersionId === 'null') {
      throw new Error('Disposable object storage did not return an immutable source version.')
    }

    await database.db.tenant.create({
      data: { id: tenantId, name: 'Disposable venue media tenant', slug: tenantId },
    })
    await database.db.venue.create({
      data: { id: venueId, tenantId, name: 'Disposable venue media venue', slug: venueSlug },
    })
    const actor = {
      type: 'HUMAN' as const,
      id: 'disposable-shakedown',
      role: 'PLATFORM_ADMIN' as const,
    }
    const reserved = await database.reserveIntakeUploadAction({
      tenantId,
      venueId,
      actor,
      request: {
        requestId: randomUUID(),
        displayName: 'Disposable venue image',
        fileName: 'disposable-venue.png',
        mimeType: 'image/png',
        category: 'PHOTO',
        byteSize: sourceBytes.byteLength,
        sha256: sourceSha256,
      },
      trustedObjectIdentity: { objectKey: sourceObjectKey, objectGeneration: sourceGeneration },
    })
    uploadId = reserved.upload.id
    const precheckClaimId = randomUUID()
    await database.claimIntakeUploadVerificationAction({
      tenantId,
      venueId,
      uploadId,
      actor,
      claimId: precheckClaimId,
    })
    await database.recordIntakeUploadPrecheckAction({
      tenantId,
      venueId,
      uploadId,
      actor,
      claimId: precheckClaimId,
      verified: {
        objectGeneration: sourceGeneration,
        storageVersionId: put.VersionId,
        mimeType: 'image/png',
        byteSize: sourceBytes.byteLength,
        sha256: sourceSha256,
      },
      evidence: {
        engine: 'disposable-image-precheck',
        engineVersion: '1',
        verdictHash: createHash('sha256').update(`precheck:${suffix}`).digest('hex'),
        computedByteSize: sourceBytes.byteLength,
        computedSha256: sourceSha256,
      },
    })
    const authoritativeClaimId = randomUUID()
    await database.claimIntakeUploadVerificationAction({
      tenantId,
      venueId,
      uploadId,
      actor,
      claimId: authoritativeClaimId,
    })
    await database.settleIntakeUploadAuthoritativeVerificationAction({
      tenantId,
      venueId,
      uploadId,
      actor,
      claimId: authoritativeClaimId,
      malware: {
        verdict: 'CLEAN',
        engine: 'disposable-clean-fixture',
        engineVersion: '1',
        verdictHash: createHash('sha256').update(`malware:${suffix}`).digest('hex'),
        computedByteSize: sourceBytes.byteLength,
        computedSha256: sourceSha256,
      },
    })
    await database.db.venueMediaAsset.create({
      data: {
        id: assetId,
        tenantId,
        venueId,
        intakeUploadId: uploadId,
        kind: 'IMAGE',
        semanticDescription: 'A synthetic teal rectangle used only for disposable verification.',
        depictedSubjects: ['synthetic fixture'],
        altText: 'Synthetic teal verification image',
        importance: 'PRIMARY',
        sourceName: 'Disposable shakedown fixture',
        createdBy: 'disposable-shakedown',
      },
    })
    await database.db.venueMediaReview.create({
      data: {
        tenantId,
        venueId,
        assetId,
        sequence: 1,
        action: 'APPROVE_CONTENT_USE',
        rightsBasis: 'VENUE_OWNED',
        rightsStatement: 'Synthetic fixture created by the disposable shakedown.',
        rightsEvidenceSourceId: 'disposable-fixture',
        requestId: randomUUID(),
        actorId: 'disposable-shakedown',
      },
    })
    await database.db.venueMediaDerivative.create({
      data: {
        id: derivativeId,
        tenantId,
        venueId,
        assetId,
        requestId: randomUUID(),
        requestHash: createHash('sha256').update(`derivative:${suffix}`).digest('hex'),
        variant: 'CARD',
        sourceObjectGeneration: sourceGeneration,
        sourceStorageVersionId: put.VersionId,
        approvedReviewSequence: 1,
        createdBy: 'disposable-shakedown',
      },
    })

    await expect(
      processVenueMediaDerivativeJob({ tenantId, venueId, derivativeId }),
    ).resolves.toEqual({ state: 'ready', derivativeId })

    const delivered = await readControlledVenueMediaDerivative({ derivativeId, venueSlug })
    expect(delivered.mimeType).toBe('image/webp')
    expect(delivered.bytes.byteLength).toBeGreaterThan(0)
    expect(createHash('sha256').update(delivered.bytes).digest('hex')).toBe(delivered.sha256)
    await expect(sharp(delivered.bytes).metadata()).resolves.toMatchObject({
      format: 'webp',
      width: 768,
      height: 480,
    })

    await database.db.venueMediaReview.create({
      data: {
        tenantId,
        venueId,
        assetId,
        sequence: 2,
        action: 'WITHDRAW_CONTENT_USE',
        reason: 'Disposable withdrawal proof',
        requestId: randomUUID(),
        actorId: 'disposable-shakedown',
      },
    })
    await expect(readControlledVenueMediaDerivative({ derivativeId, venueSlug })).rejects.toThrow(
      'Venue media is unavailable.',
    )
  }, 120_000)
})
