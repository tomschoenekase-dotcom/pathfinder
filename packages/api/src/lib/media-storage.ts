import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export const MEDIA_UPLOAD_PART_SIZE = 16 * 1024 * 1024

type MediaStorageCommand =
  | AbortMultipartUploadCommand
  | CompleteMultipartUploadCommand
  | CreateMultipartUploadCommand
  | DeleteObjectCommand
  | HeadObjectCommand
  | UploadPartCommand

export type MediaStorageTransport = {
  send(command: MediaStorageCommand): Promise<unknown>
}

export function mediaUploadPartCount(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error('Media upload size must be a positive safe integer.')
  }
  return Math.ceil(bytes / MEDIA_UPLOAD_PART_SIZE)
}

export function normalizeMediaUploadParts(
  parts: Array<{ partNumber: number; etag: string }>,
  expectedCount: number,
) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) {
    throw new Error('Expected media upload part count must be a positive safe integer.')
  }
  if (parts.length !== expectedCount) {
    throw new Error(`Media upload requires exactly ${expectedCount} completed parts.`)
  }
  const normalized = [...parts].sort((left, right) => left.partNumber - right.partNumber)
  for (let index = 0; index < normalized.length; index++) {
    if (normalized[index]?.partNumber !== index + 1) {
      throw new Error('Media upload parts must contain each contiguous part number exactly once.')
    }
  }
  return normalized
}

function storageConfig() {
  const bucket = process.env.STORAGE_BUCKET
  const region = process.env.STORAGE_REGION
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY

  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new Error('Media storage is not configured.')
  }

  return { bucket, region, accessKeyId, secretAccessKey }
}

function client(): S3Client {
  const config = storageConfig()
  return new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(process.env.STORAGE_ENDPOINT
      ? { endpoint: process.env.STORAGE_ENDPOINT, forcePathStyle: true }
      : {}),
  })
}

export async function beginMediaUpload(key: string, contentType: string) {
  const { bucket } = storageConfig()
  const result = await client().send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
  )

  if (!result.UploadId) throw new Error('Storage did not return an upload ID.')
  return { uploadId: result.UploadId, partSize: MEDIA_UPLOAD_PART_SIZE }
}

export async function signMediaUploadPart(key: string, uploadId: string, partNumber: number) {
  const { bucket } = storageConfig()
  return getSignedUrl(
    client(),
    new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: 60 * 60 },
  )
}

export async function finishMediaUpload(
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
  expectedBytes: number,
  maxBytes: number,
  storage: MediaStorageTransport = client() as unknown as MediaStorageTransport,
) {
  const { bucket } = storageConfig()
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new Error('Expected media upload size must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Media upload byte limit must be a positive safe integer.')
  }
  if (expectedBytes > maxBytes) {
    throw new Error('Expected media upload size exceeds the configured byte limit.')
  }

  let completedVersionId: string | undefined
  try {
    const result = (await storage.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
        },
      }),
    )) as { VersionId?: string }
    completedVersionId = result.VersionId
  } catch (error) {
    try {
      await abortMediaUpload(key, uploadId, storage)
    } catch (abortError) {
      const message = error instanceof Error ? error.message : 'Media upload completion failed.'
      throw new AggregateError([error, abortError], `${message}; multipart abort also failed.`)
    }
    throw error
  }

  let bytes: number | undefined
  let inspectedVersionId: string | undefined
  try {
    const result = (await storage.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: completedVersionId,
      }),
    )) as {
      ContentLength?: number
      VersionId?: string
    }
    bytes = result.ContentLength
    inspectedVersionId = result.VersionId
  } catch (error) {
    throw new Error('Completed media upload size could not be verified.', { cause: error })
  }

  const versionId = completedVersionId ?? inspectedVersionId

  if (typeof bytes !== 'number') {
    return rejectInvalidMediaObject(
      storage,
      key,
      'Completed media upload returned an invalid size',
      versionId,
    )
  }
  if (!Number.isSafeInteger(bytes)) {
    return rejectInvalidMediaObject(
      storage,
      key,
      'Completed media upload returned an invalid size',
      versionId,
    )
  }
  if (bytes <= 0) {
    return rejectInvalidMediaObject(storage, key, 'Completed media upload is empty', versionId)
  }
  if (bytes > maxBytes) {
    return rejectInvalidMediaObject(
      storage,
      key,
      `Completed media upload exceeds the ${maxBytes}-byte limit`,
      versionId,
    )
  }
  if (bytes !== expectedBytes) {
    return rejectInvalidMediaObject(
      storage,
      key,
      `Completed media upload size ${bytes} does not match the declared ${expectedBytes} bytes`,
      versionId,
    )
  }

  return { bytes }
}

async function rejectInvalidMediaObject(
  storage: MediaStorageTransport,
  key: string,
  reason: string,
  versionId?: string,
): Promise<never> {
  try {
    await deleteMediaObject(key, versionId, storage)
  } catch (error) {
    throw new Error(`${reason}; object removal also failed.`, { cause: error })
  }
  throw new Error(`${reason} and the object was removed.`)
}

export async function abortMediaUpload(
  key: string,
  uploadId: string,
  storage: MediaStorageTransport = client() as unknown as MediaStorageTransport,
): Promise<void> {
  const { bucket } = storageConfig()
  await storage.send(
    new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
  )
}

export async function deleteMediaObject(
  key: string,
  versionId?: string,
  storage: MediaStorageTransport = client() as unknown as MediaStorageTransport,
): Promise<void> {
  const { bucket } = storageConfig()
  await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }))
}
