import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

import type { OffboardingExportStorage } from '@pathfinder/db'

function config() {
  const bucket = process.env.STORAGE_BUCKET
  const region = process.env.STORAGE_REGION
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new Error('Offboarding export storage is not configured.')
  }
  return { bucket, region, accessKeyId, secretAccessKey }
}

function client() {
  const value = config()
  return new S3Client({
    region: value.region,
    credentials: { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey },
    ...(process.env.STORAGE_ENDPOINT
      ? { endpoint: process.env.STORAGE_ENDPOINT, forcePathStyle: true }
      : {}),
  })
}

function precondition(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    '$metadata' in error &&
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412,
  )
}

export function createOffboardingExportStorage(transport = client()): OffboardingExportStorage {
  const storage = config()
  return {
    async putExact(input) {
      try {
        const response = await transport.send(
          new PutObjectCommand({
            Bucket: storage.bucket,
            Key: input.key,
            Body: input.bytes,
            ContentType: 'application/json',
            ContentLength: input.bytes.byteLength,
            IfNoneMatch: '*',
            Metadata: { 'pathfinder-sha256': input.contentHash },
          }),
        )
        if (!response.VersionId)
          throw new Error('Versioned offboarding export storage is required.')
        return { versionId: response.VersionId }
      } catch (error) {
        if (!precondition(error)) throw error
        const head = await transport.send(
          new HeadObjectCommand({ Bucket: storage.bucket, Key: input.key }),
        )
        if (
          head.Metadata?.['pathfinder-sha256'] !== input.contentHash ||
          head.ContentLength !== input.bytes.byteLength ||
          !head.VersionId
        ) {
          throw new Error('Existing offboarding export object does not match the reserved bytes.')
        }
        return { versionId: head.VersionId }
      }
    },
  }
}
