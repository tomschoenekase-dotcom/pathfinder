import { createHash } from 'node:crypto'

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'

import { db } from '@pathfinder/db'

const UNVERSIONED_IDENTITY = /^unversioned-sha256:[a-f0-9]{64}$/u
const MAX_DERIVATIVE_BYTES = 2_500_000

type Storage = Pick<S3Client, 'send'>
type DeliveryDb = Pick<typeof db, 'venueMediaDerivative'>
type VenueScope = { id: string; tenantId: string }

function storageConfig() {
  const bucket = process.env.STORAGE_BUCKET
  const region = process.env.STORAGE_REGION
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new Error('Venue media delivery storage is not configured.')
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

async function readExactDerivative(
  body: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  expectedSha256: string,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    expectedBytes > MAX_DERIVATIVE_BYTES ||
    !/^[a-f0-9]{64}$/u.test(expectedSha256)
  ) {
    throw new Error('Venue media derivative has invalid retained identity.')
  }
  const chunks: Buffer[] = []
  const hash = createHash('sha256')
  let observed = 0
  for await (const chunk of body) {
    const bytes = Buffer.from(chunk)
    observed += bytes.byteLength
    if (observed > expectedBytes || observed > MAX_DERIVATIVE_BYTES) {
      throw new Error('Venue media derivative exceeded its retained byte identity.')
    }
    hash.update(bytes)
    chunks.push(bytes)
  }
  if (observed !== expectedBytes || hash.digest('hex') !== expectedSha256) {
    throw new Error('Venue media derivative failed integrity verification.')
  }
  return Buffer.concat(chunks, observed)
}

export class VenueMediaDeliveryUnavailableError extends Error {
  constructor() {
    super('Venue media is unavailable.')
    this.name = 'VenueMediaDeliveryUnavailableError'
  }
}

async function resolveVenueScope(venueSlug: string): Promise<VenueScope | null> {
  const [venue] = await db.$queryRaw<VenueScope[]>`
    SELECT id, tenant_id AS "tenantId"
    FROM venues
    WHERE slug = ${venueSlug} AND is_active = true
    LIMIT 1
  `
  return venue ?? null
}

export async function readControlledVenueMediaDerivative(input: {
  derivativeId: string
  venueSlug: string
  db?: DeliveryDb
  storage?: Storage
  resolveVenueScope?: (venueSlug: string) => Promise<VenueScope | null>
}): Promise<{ bytes: Buffer; mimeType: 'image/webp'; sha256: string }> {
  const database = input.db ?? db
  const venue = await (input.resolveVenueScope ?? resolveVenueScope)(input.venueSlug)
  if (!venue) throw new VenueMediaDeliveryUnavailableError()
  const derivative = await database.venueMediaDerivative.findFirst({
    where: {
      id: input.derivativeId,
      tenantId: venue.tenantId,
      venueId: venue.id,
      status: 'READY',
    },
    select: {
      approvedReviewSequence: true,
      objectKey: true,
      storageVersionId: true,
      mimeType: true,
      byteSize: true,
      sha256: true,
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
  const latest = derivative?.asset.reviews[0]
  if (
    !derivative ||
    !latest ||
    latest.sequence !== derivative.approvedReviewSequence ||
    latest.action !== 'APPROVE_CONTENT_USE' ||
    latest.rightsBasis === null ||
    !derivative.objectKey ||
    !derivative.storageVersionId ||
    derivative.mimeType !== 'image/webp' ||
    !derivative.byteSize ||
    !derivative.sha256
  ) {
    throw new VenueMediaDeliveryUnavailableError()
  }

  const config = storageConfig()
  const version = UNVERSIONED_IDENTITY.test(derivative.storageVersionId)
    ? {}
    : { VersionId: derivative.storageVersionId }
  const result = (await (input.storage ?? storageClient()).send(
    new GetObjectCommand({ Bucket: config.bucket, Key: derivative.objectKey, ...version }),
  )) as { Body?: AsyncIterable<Uint8Array> }
  if (!result.Body || !(Symbol.asyncIterator in result.Body)) {
    throw new VenueMediaDeliveryUnavailableError()
  }
  try {
    return {
      bytes: await readExactDerivative(result.Body, derivative.byteSize, derivative.sha256),
      mimeType: 'image/webp',
      sha256: derivative.sha256,
    }
  } catch {
    throw new VenueMediaDeliveryUnavailableError()
  }
}
