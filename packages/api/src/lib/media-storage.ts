import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export const MEDIA_UPLOAD_PART_SIZE = 16 * 1024 * 1024
export const MEDIA_UPLOAD_GENERATION_METADATA_KEY = 'pf-media-upload-generation'

type MediaStorageCommand =
  | AbortMultipartUploadCommand
  | CompleteMultipartUploadCommand
  | CreateMultipartUploadCommand
  | DeleteObjectCommand
  | HeadObjectCommand
  | ListPartsCommand
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

export function canonicalMediaUploadEtag(etag: string): string {
  const trimmed = etag.trim()
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed
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

export async function beginMediaUpload(
  key: string,
  contentType: string,
  generation?: string,
  storage: MediaStorageTransport = client() as unknown as MediaStorageTransport,
) {
  const { bucket } = storageConfig()
  const result = (await storage.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ...(generation ? { Metadata: { [MEDIA_UPLOAD_GENERATION_METADATA_KEY]: generation } } : {}),
    }),
  )) as { UploadId?: string }

  if (!result.UploadId) throw new Error('Storage did not return an upload ID.')
  return { uploadId: result.UploadId, partSize: MEDIA_UPLOAD_PART_SIZE }
}

export class MediaUploadCompletionUnconfirmedError extends Error {
  constructor(cause?: unknown) {
    super('Media upload completion could not be confirmed.', { cause })
    this.name = 'MediaUploadCompletionUnconfirmedError'
  }
}

export type CompletedMediaUploadInspection =
  | { state: 'verified'; bytes: number; versionId: string | undefined }
  | { state: 'missing' }
  | { state: 'identity-mismatch' }
  | { state: 'invalid'; reason: string; versionId: string | undefined }

function isMissingMediaObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as {
    name?: unknown
    Code?: unknown
    code?: unknown
    $metadata?: { httpStatusCode?: unknown }
  }
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.Code === 'NoSuchKey' ||
    candidate.code === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  )
}

export async function inspectCompletedMediaUpload(
  key: string,
  expectedBytes: number,
  maxBytes: number,
  expectedGeneration?: string,
  versionId?: string,
  storage: MediaStorageTransport = client() as unknown as MediaStorageTransport,
): Promise<CompletedMediaUploadInspection> {
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
  let result: {
    ContentLength?: number
    VersionId?: string
    Metadata?: Record<string, string>
  }
  try {
    result = (await storage.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
    )) as typeof result
  } catch (error) {
    if (isMissingMediaObject(error)) return { state: 'missing' }
    throw error
  }

  const inspectedVersionId = versionId ?? result.VersionId
  if (
    expectedGeneration &&
    result.Metadata?.[MEDIA_UPLOAD_GENERATION_METADATA_KEY] !== expectedGeneration
  ) {
    return { state: 'identity-mismatch' }
  }
  const bytes = result.ContentLength
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes)) {
    return {
      state: 'invalid',
      reason: 'Completed media upload returned an invalid size',
      versionId: inspectedVersionId,
    }
  }
  if (bytes <= 0) {
    return {
      state: 'invalid',
      reason: 'Completed media upload is empty',
      versionId: inspectedVersionId,
    }
  }
  if (bytes > maxBytes) {
    return {
      state: 'invalid',
      reason: `Completed media upload exceeds the ${maxBytes}-byte limit`,
      versionId: inspectedVersionId,
    }
  }
  if (bytes !== expectedBytes) {
    return {
      state: 'invalid',
      reason: `Completed media upload size ${bytes} does not match the declared ${expectedBytes} bytes`,
      versionId: inspectedVersionId,
    }
  }
  return { state: 'verified', bytes, versionId: inspectedVersionId }
}

export async function signMediaUploadPart(key: string, uploadId: string, partNumber: number) {
  const { bucket } = storageConfig()
  return getSignedUrl(
    client(),
    new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: 60 * 60 },
  )
}

export type ReusableMediaUploadPart = {
  partNumber: number
  etag: string
  size: number
}

export async function listMediaUploadParts(
  key: string,
  uploadId: string,
  expectedPartCount: number,
  storage: MediaStorageTransport = client() as unknown as MediaStorageTransport,
): Promise<ReusableMediaUploadPart[]> {
  const { bucket } = storageConfig()
  if (!Number.isSafeInteger(expectedPartCount) || expectedPartCount <= 0) {
    throw new Error('Expected media upload part count must be a positive safe integer.')
  }
  const parts = new Map<number, ReusableMediaUploadPart>()
  const seenMarkers = new Set<string>()
  let partNumberMarker: string | undefined

  for (;;) {
    const result = (await storage.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: partNumberMarker,
        MaxParts: Math.min(1000, expectedPartCount),
      }),
    )) as {
      Parts?: Array<{ PartNumber?: number; ETag?: string; Size?: number }>
      IsTruncated?: boolean
      NextPartNumberMarker?: string
    }

    for (const part of result.Parts ?? []) {
      if (
        !Number.isSafeInteger(part.PartNumber) ||
        part.PartNumber === undefined ||
        part.PartNumber < 1 ||
        part.PartNumber > expectedPartCount ||
        typeof part.ETag !== 'string' ||
        part.ETag.length === 0 ||
        !Number.isSafeInteger(part.Size) ||
        part.Size === undefined ||
        part.Size <= 0
      ) {
        throw new Error('Storage returned invalid multipart resume metadata.')
      }
      if (parts.has(part.PartNumber)) {
        throw new Error('Storage returned duplicate multipart resume metadata.')
      }
      parts.set(part.PartNumber, {
        partNumber: part.PartNumber,
        etag: part.ETag,
        size: part.Size,
      })
    }

    if (!result.IsTruncated) break
    const nextMarker = result.NextPartNumberMarker
    if (!nextMarker || seenMarkers.has(nextMarker)) {
      throw new Error('Storage returned invalid multipart resume pagination.')
    }
    seenMarkers.add(nextMarker)
    partNumberMarker = nextMarker
  }

  return [...parts.values()].sort((left, right) => left.partNumber - right.partNumber)
}

export async function listReusableMediaUploadParts(
  key: string,
  uploadId: string,
  expectedBytes: number,
  storage: MediaStorageTransport = client() as unknown as MediaStorageTransport,
): Promise<ReusableMediaUploadPart[]> {
  const expectedCount = mediaUploadPartCount(expectedBytes)
  const parts = await listMediaUploadParts(key, uploadId, expectedCount, storage)
  return parts.filter((part) => {
    const expectedSize =
      part.partNumber === expectedCount
        ? expectedBytes - MEDIA_UPLOAD_PART_SIZE * (expectedCount - 1)
        : MEDIA_UPLOAD_PART_SIZE
    return part.size === expectedSize
  })
}

export async function finishMediaUpload(
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
  expectedBytes: number,
  maxBytes: number,
  expectedGeneration?: string,
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
  let completionError: unknown
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
    completionError = error
  }

  if (completionError !== undefined && !expectedGeneration) {
    throw new MediaUploadCompletionUnconfirmedError(completionError)
  }

  let inspection: CompletedMediaUploadInspection
  try {
    inspection = await inspectCompletedMediaUpload(
      key,
      expectedBytes,
      maxBytes,
      expectedGeneration,
      completedVersionId,
      storage,
    )
  } catch (error) {
    throw new MediaUploadCompletionUnconfirmedError(
      completionError === undefined ? error : new AggregateError([completionError, error]),
    )
  }

  if (inspection.state === 'verified') return { bytes: inspection.bytes }
  if (inspection.state === 'missing') {
    throw new MediaUploadCompletionUnconfirmedError(completionError)
  }
  if (inspection.state === 'identity-mismatch') {
    throw new Error('Completed media upload generation does not match the active attempt.')
  }
  return rejectInvalidMediaObject(storage, key, inspection.reason, inspection.versionId)
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
