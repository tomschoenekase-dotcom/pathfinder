import { createHash } from 'node:crypto'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import sharp from 'sharp'

import { currentDeploymentStorageKey } from '@pathfinder/api/deployment-storage-key'
import { db, withTenantIsolationBypass, writeAuditLogStrict } from '@pathfinder/db'
import type { VenueMediaDerivativeJobPayload } from '@pathfinder/jobs'

const UNVERSIONED_SOURCE_PREFIX = 'unversioned-sha256:'
const MAX_SOURCE_BYTES = 25 * 1024 * 1024
const MAX_INPUT_PIXELS = 40_000_000

export const VENUE_MEDIA_DERIVATIVE_POLICY = Object.freeze({
  CARD: { width: 768, height: 768, quality: 78, maximumBytes: 900_000 },
  DETAIL: { width: 1600, height: 1600, quality: 82, maximumBytes: 2_500_000 },
})

type DerivativeVariant = keyof typeof VENUE_MEDIA_DERIVATIVE_POLICY

type Storage = Pick<S3Client, 'send'>

function storageConfig() {
  const bucket = process.env.STORAGE_BUCKET
  const region = process.env.STORAGE_REGION
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new Error('Venue media derivative storage is not configured.')
  }
  return { bucket, region, accessKeyId, secretAccessKey }
}

function storageClient(): S3Client {
  const config = storageConfig()
  return new S3Client({
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    ...(process.env.STORAGE_ENDPOINT
      ? { endpoint: process.env.STORAGE_ENDPOINT, forcePathStyle: true }
      : {}),
  })
}

async function readBoundedSource(
  body: AsyncIterable<Uint8Array>,
  declaredBytes: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes <= 0 ||
    declaredBytes > MAX_SOURCE_BYTES
  ) {
    throw new Error('Venue media source exceeds the controlled derivative byte limit.')
  }
  const chunks: Buffer[] = []
  let observed = 0
  for await (const chunk of body) {
    const bytes = Buffer.from(chunk)
    observed += bytes.byteLength
    if (observed > declaredBytes || observed > MAX_SOURCE_BYTES) {
      throw new Error('Venue media source exceeded its verified byte identity while reading.')
    }
    chunks.push(bytes)
  }
  if (observed !== declaredBytes) {
    throw new Error('Venue media source did not match its verified byte identity.')
  }
  return Buffer.concat(chunks, observed)
}

export async function createVenueMediaDerivative(
  source: Buffer,
  variant: DerivativeVariant,
): Promise<{ bytes: Buffer; width: number; height: number; sha256: string }> {
  const policy = VENUE_MEDIA_DERIVATIVE_POLICY[variant]
  const image = sharp(source, {
    failOn: 'warning',
    limitInputPixels: MAX_INPUT_PIXELS,
    pages: 1,
  })
  const input = await image.metadata()
  if ((input.pages ?? 1) !== 1) throw new Error('Animated venue media is not supported.')
  const { data, info } = await image
    .rotate()
    .resize({
      width: policy.width,
      height: policy.height,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: policy.quality, effort: 4, smartSubsample: true })
    .toBuffer({ resolveWithObject: true })
  if (data.byteLength <= 0 || data.byteLength > policy.maximumBytes) {
    throw new Error(`Venue media ${variant.toLowerCase()} derivative exceeds its output budget.`)
  }
  if (!info.width || !info.height || info.format !== 'webp') {
    throw new Error('Venue media derivative returned invalid browser metadata.')
  }
  return {
    bytes: data,
    width: info.width,
    height: info.height,
    sha256: createHash('sha256').update(data).digest('hex'),
  }
}

function sourceVersion(versionId: string): { VersionId?: string } {
  if (new RegExp(`^${UNVERSIONED_SOURCE_PREFIX}[a-f0-9]{64}$`, 'u').test(versionId)) return {}
  if (versionId.startsWith(UNVERSIONED_SOURCE_PREFIX)) {
    throw new Error('Venue media source has an invalid versionless identity.')
  }
  return { VersionId: versionId }
}

async function failClosed(
  payload: VenueMediaDerivativeJobPayload,
  derivativeId: string,
  failureCode: 'RIGHTS_NOT_CURRENT' | 'SOURCE_IDENTITY_CHANGED',
): Promise<void> {
  await withTenantIsolationBypass(() =>
    db.venueMediaDerivative.updateMany({
      where: {
        id: derivativeId,
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        status: 'PENDING',
      },
      data: { status: 'FAILED', failureCode, completedAt: new Date() },
    }),
  )
}

export async function processVenueMediaDerivativeJob(
  payload: VenueMediaDerivativeJobPayload,
  dependencies: { storage?: Storage } = {},
): Promise<{ state: 'ready' | 'already-terminal' | 'failed-closed'; derivativeId: string }> {
  const derivative = await withTenantIsolationBypass(() =>
    db.venueMediaDerivative.findFirst({
      where: {
        id: payload.derivativeId,
        tenantId: payload.tenantId,
        venueId: payload.venueId,
      },
      select: {
        id: true,
        variant: true,
        status: true,
        sourceObjectGeneration: true,
        sourceStorageVersionId: true,
        approvedReviewSequence: true,
        asset: {
          select: {
            intakeUpload: {
              select: {
                objectKey: true,
                objectGeneration: true,
                storageVersionId: true,
                byteSize: true,
                status: true,
                verifiedAt: true,
              },
            },
            reviews: {
              orderBy: { sequence: 'desc' },
              take: 1,
              select: { sequence: true, action: true, rightsBasis: true },
            },
          },
        },
      },
    }),
  )
  if (!derivative) throw new Error('Venue media derivative identity was not found.')
  if (derivative.status !== 'PENDING') {
    return { state: 'already-terminal', derivativeId: derivative.id }
  }
  const latest = derivative.asset.reviews[0]
  if (
    !latest ||
    latest.sequence !== derivative.approvedReviewSequence ||
    latest.action !== 'APPROVE_CONTENT_USE' ||
    latest.rightsBasis === null
  ) {
    await failClosed(payload, derivative.id, 'RIGHTS_NOT_CURRENT')
    return { state: 'failed-closed', derivativeId: derivative.id }
  }
  const upload = derivative.asset.intakeUpload
  if (
    upload.status !== 'AWAITING_REVIEW' ||
    upload.verifiedAt === null ||
    upload.objectGeneration !== derivative.sourceObjectGeneration ||
    upload.storageVersionId !== derivative.sourceStorageVersionId
  ) {
    await failClosed(payload, derivative.id, 'SOURCE_IDENTITY_CHANGED')
    return { state: 'failed-closed', derivativeId: derivative.id }
  }

  const config = storageConfig()
  const storage = dependencies.storage ?? storageClient()
  const source = (await storage.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: upload.objectKey,
      ...sourceVersion(derivative.sourceStorageVersionId),
    }),
  )) as { Body?: AsyncIterable<Uint8Array> }
  if (!source.Body || !(Symbol.asyncIterator in source.Body)) {
    throw new Error('Venue media source bytes are unavailable.')
  }
  const sourceBytes = await readBoundedSource(source.Body, upload.byteSize)
  const output = await createVenueMediaDerivative(sourceBytes, derivative.variant)
  const objectKey = currentDeploymentStorageKey(
    `venue-media-derivatives/${payload.tenantId}/${payload.venueId}/${derivative.id}/${derivative.variant.toLowerCase()}.webp`,
  )
  const stored = (await storage.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: output.bytes,
      ContentType: 'image/webp',
      ContentLength: output.bytes.byteLength,
      CacheControl: 'private, max-age=0, no-store',
      ChecksumSHA256: Buffer.from(output.sha256, 'hex').toString('base64'),
      Metadata: {
        'pf-venue-media-derivative-id': derivative.id,
        'pf-source-generation': derivative.sourceObjectGeneration,
        'pf-approved-review-sequence': String(derivative.approvedReviewSequence),
      },
    }),
  )) as { VersionId?: string }
  const storageVersionId = stored.VersionId ?? `${UNVERSIONED_SOURCE_PREFIX}${output.sha256}`

  const finalized = await withTenantIsolationBypass(() =>
    db.$transaction(async (tx) => {
      const current = await tx.venueMediaDerivative.findFirst({
        where: {
          id: derivative.id,
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          status: 'PENDING',
        },
        select: {
          approvedReviewSequence: true,
          asset: {
            select: {
              reviews: {
                orderBy: { sequence: 'desc' },
                take: 1,
                select: { sequence: true, action: true, rightsBasis: true },
              },
            },
          },
        },
      })
      const currentReview = current?.asset.reviews[0]
      if (
        !current ||
        !currentReview ||
        currentReview.sequence !== current.approvedReviewSequence ||
        currentReview.action !== 'APPROVE_CONTENT_USE' ||
        currentReview.rightsBasis === null
      ) {
        if (current) {
          await tx.venueMediaDerivative.update({
            where: { id: derivative.id },
            data: {
              status: 'FAILED',
              failureCode: 'RIGHTS_NOT_CURRENT',
              completedAt: new Date(),
            },
          })
        }
        return false
      }
      await tx.venueMediaDerivative.update({
        where: { id: derivative.id },
        data: {
          status: 'READY',
          objectKey,
          storageVersionId,
          mimeType: 'image/webp',
          width: output.width,
          height: output.height,
          byteSize: output.bytes.byteLength,
          sha256: output.sha256,
          completedAt: new Date(),
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: payload.tenantId,
          actorId: 'system:venue-media-derivative-worker',
          actorRole: 'SYSTEM',
          action: 'venue_media.derivative_ready',
          targetType: 'VenueMediaDerivative',
          targetId: derivative.id,
          afterState: {
            venueId: payload.venueId,
            variant: derivative.variant,
            mimeType: 'image/webp',
            width: output.width,
            height: output.height,
            byteSize: output.bytes.byteLength,
            sha256: output.sha256,
            sourceObjectGeneration: derivative.sourceObjectGeneration,
            approvedReviewSequence: derivative.approvedReviewSequence,
          },
        },
        tx,
      )
      return true
    }),
  )

  if (!finalized) {
    await storage.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
        ...(stored.VersionId ? { VersionId: stored.VersionId } : {}),
      }),
    )
    return { state: 'failed-closed', derivativeId: derivative.id }
  }
  return { state: 'ready', derivativeId: derivative.id }
}
