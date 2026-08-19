import { randomUUID } from 'node:crypto'

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { currentDeploymentStorageKey } from './deployment-storage-key'
import { INTAKE_UPLOAD_MULTIPART_PART_BYTES } from '@pathfinder/contracts/intake-upload'

export const INTAKE_UPLOAD_URL_EXPIRES_SECONDS = 15 * 60
export const INTAKE_UPLOAD_GENERATION_METADATA_KEY = 'pf-intake-upload-generation'
export const INTAKE_UPLOAD_MULTIPART_METADATA_KEY = 'pf-intake-upload-multipart'

type IntakeUploadStorageCommand =
  | PutObjectCommand
  | HeadObjectCommand
  | GetObjectCommand
  | DeleteObjectCommand
  | CreateMultipartUploadCommand
  | UploadPartCommand
  | ListPartsCommand
  | CompleteMultipartUploadCommand
  | AbortMultipartUploadCommand

export type IntakeUploadStorageTransport = {
  send(
    command: IntakeUploadStorageCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>
}

export type IntakeUploadSigner = (
  client: S3Client,
  command: PutObjectCommand,
  options: {
    expiresIn: number
    signableHeaders: Set<string>
    unhoistableHeaders: Set<string>
  },
) => Promise<string>

function storageConfig() {
  const bucket = process.env.STORAGE_BUCKET
  const region = process.env.STORAGE_REGION
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY

  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new Error('Intake upload storage is not configured.')
  }

  return { bucket, region, accessKeyId, secretAccessKey }
}

function storageClient(): S3Client {
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

function assertSha256Hex(checksumSha256: string): void {
  if (!/^[a-f0-9]{64}$/.test(checksumSha256)) {
    throw new Error('Intake upload SHA-256 must be 64 lowercase hexadecimal characters.')
  }
}

export function intakeUploadChecksumBase64(checksumSha256: string): string {
  assertSha256Hex(checksumSha256)
  return Buffer.from(checksumSha256, 'hex').toString('base64')
}

/** Creates a non-semantic object key. Never pass a user-provided filename here. */
export function createIntakeUploadObjectKey(): string {
  return currentDeploymentStorageKey(`intake-quarantine/${randomUUID()}`)
}

export async function signIntakeUploadPut(input: {
  key: string
  generation: string
  contentType: string
  bytes: number
  checksumSha256: string
  client?: S3Client
  signer?: IntakeUploadSigner
}): Promise<{ url: string; expiresInSeconds: number; requiredHeaders: Record<string, string> }> {
  if (!input.key) throw new Error('Intake upload object key is required.')
  if (!input.generation) throw new Error('Intake upload generation is required.')
  if (!input.contentType) throw new Error('Intake upload content type is required.')
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
    throw new Error('Intake upload size must be a positive safe integer.')
  }

  const checksumBase64 = intakeUploadChecksumBase64(input.checksumSha256)
  const config = storageConfig()
  const client = input.client ?? storageClient()
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: input.key,
    ContentLength: input.bytes,
    ContentType: input.contentType,
    ChecksumSHA256: checksumBase64,
    IfNoneMatch: '*',
    Metadata: { [INTAKE_UPLOAD_GENERATION_METADATA_KEY]: input.generation },
  })
  const checksumHeader = 'x-amz-checksum-sha256'
  const generationHeader = `x-amz-meta-${INTAKE_UPLOAD_GENERATION_METADATA_KEY}`
  const url = await (input.signer ?? getSignedUrl)(client, command, {
    expiresIn: INTAKE_UPLOAD_URL_EXPIRES_SECONDS,
    // The S3 signer intentionally excludes content-type unless explicitly opted in.
    signableHeaders: new Set(['content-type']),
    // Keep these constraints as required signed request headers, rather than hoisted URL fields.
    unhoistableHeaders: new Set([checksumHeader, generationHeader]),
  })

  return {
    url,
    expiresInSeconds: INTAKE_UPLOAD_URL_EXPIRES_SECONDS,
    requiredHeaders: {
      'content-type': input.contentType,
      'if-none-match': '*',
      [checksumHeader]: checksumBase64,
      [generationHeader]: input.generation,
    },
  }
}

export async function beginIntakeUploadMultipart(input: {
  key: string
  generation: string
  contentType: string
  storage?: IntakeUploadStorageTransport
}) {
  const config = storageConfig()
  const storage = input.storage ?? (storageClient() as unknown as IntakeUploadStorageTransport)
  const result = (await storage.send(
    new CreateMultipartUploadCommand({
      Bucket: config.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ChecksumAlgorithm: 'SHA256',
      Metadata: {
        [INTAKE_UPLOAD_GENERATION_METADATA_KEY]: input.generation,
        [INTAKE_UPLOAD_MULTIPART_METADATA_KEY]: 'true',
      },
    }),
  )) as { UploadId?: string }
  if (!result.UploadId) throw new Error('Storage did not return a multipart upload ID.')
  return { uploadId: result.UploadId, partSize: INTAKE_UPLOAD_MULTIPART_PART_BYTES }
}

export async function signIntakeUploadPart(input: {
  key: string
  uploadId: string
  partNumber: number
  checksumSha256: string
  client?: S3Client
  signer?: typeof getSignedUrl
}) {
  if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > 10_000)
    throw new Error('Multipart part number is invalid.')
  const config = storageConfig()
  const checksumBase64 = intakeUploadChecksumBase64(input.checksumSha256)
  const command = new UploadPartCommand({
    Bucket: config.bucket,
    Key: input.key,
    UploadId: input.uploadId,
    PartNumber: input.partNumber,
    ChecksumSHA256: checksumBase64,
  })
  const url = await (input.signer ?? getSignedUrl)(input.client ?? storageClient(), command, {
    expiresIn: INTAKE_UPLOAD_URL_EXPIRES_SECONDS,
    unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
  })
  return {
    url,
    expiresInSeconds: INTAKE_UPLOAD_URL_EXPIRES_SECONDS,
    requiredHeaders: { 'x-amz-checksum-sha256': checksumBase64 },
  }
}

export type IntakeUploadCompletedPart = {
  partNumber: number
  etag: string
  checksumSha256: string
  size: number
}

export async function listIntakeUploadMultipartParts(input: {
  key: string
  uploadId: string
  expectedBytes: number
  storage?: IntakeUploadStorageTransport
}): Promise<IntakeUploadCompletedPart[]> {
  const config = storageConfig()
  const storage = input.storage ?? (storageClient() as unknown as IntakeUploadStorageTransport)
  const expectedCount = Math.ceil(input.expectedBytes / INTAKE_UPLOAD_MULTIPART_PART_BYTES)
  const parts = new Map<number, IntakeUploadCompletedPart>()
  let marker: string | undefined
  const seen = new Set<string>()
  for (;;) {
    const result = (await storage.send(
      new ListPartsCommand({
        Bucket: config.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumberMarker: marker,
        MaxParts: Math.min(1000, expectedCount),
      }),
    )) as {
      Parts?: Array<{
        PartNumber?: number
        ETag?: string
        ChecksumSHA256?: string
        Size?: number
      }>
      IsTruncated?: boolean
      NextPartNumberMarker?: string
    }
    for (const part of result.Parts ?? []) {
      const number = part.PartNumber
      const expectedSize =
        number === expectedCount
          ? input.expectedBytes - INTAKE_UPLOAD_MULTIPART_PART_BYTES * (expectedCount - 1)
          : INTAKE_UPLOAD_MULTIPART_PART_BYTES
      if (
        !number ||
        number < 1 ||
        number > expectedCount ||
        parts.has(number) ||
        typeof part.ETag !== 'string' ||
        !part.ETag ||
        typeof part.ChecksumSHA256 !== 'string' ||
        !part.ChecksumSHA256 ||
        part.Size !== expectedSize
      )
        throw new Error('Storage returned invalid multipart resume metadata.')
      parts.set(number, {
        partNumber: number,
        etag: part.ETag,
        checksumSha256: part.ChecksumSHA256,
        size: part.Size,
      })
    }
    if (!result.IsTruncated) break
    if (!result.NextPartNumberMarker || seen.has(result.NextPartNumberMarker))
      throw new Error('Storage returned invalid multipart resume pagination.')
    marker = result.NextPartNumberMarker
    seen.add(marker)
  }
  return [...parts.values()].sort((left, right) => left.partNumber - right.partNumber)
}

export async function completeIntakeUploadMultipart(input: {
  key: string
  uploadId: string
  parts: IntakeUploadCompletedPart[]
  storage?: IntakeUploadStorageTransport
}) {
  const config = storageConfig()
  const storage = input.storage ?? (storageClient() as unknown as IntakeUploadStorageTransport)
  const result = (await storage.send(
    new CompleteMultipartUploadCommand({
      Bucket: config.bucket,
      Key: input.key,
      UploadId: input.uploadId,
      MultipartUpload: {
        Parts: input.parts.map((part) => ({
          PartNumber: part.partNumber,
          ETag: part.etag,
          ChecksumSHA256: part.checksumSha256,
        })),
      },
    }),
  )) as { VersionId?: string }
  return { versionId: result.VersionId ?? null }
}

function isMissingMultipart(error: unknown) {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; Code?: unknown }
  return candidate.name === 'NoSuchUpload' || candidate.Code === 'NoSuchUpload'
}

export async function abortIntakeUploadMultipart(input: {
  key: string
  uploadId: string
  storage?: IntakeUploadStorageTransport
}): Promise<void> {
  const config = storageConfig()
  const storage = input.storage ?? (storageClient() as unknown as IntakeUploadStorageTransport)
  try {
    await storage.send(
      new AbortMultipartUploadCommand({
        Bucket: config.bucket,
        Key: input.key,
        UploadId: input.uploadId,
      }),
    )
  } catch (error) {
    if (!isMissingMultipart(error)) throw error
  }
}

export type IntakeUploadInspection =
  | { state: 'verified'; versionId: string }
  | { state: 'missing' }
  | {
      state: 'invalid'
      versionId: string | null
      reason: 'version' | 'generation' | 'bytes' | 'mime' | 'checksum'
    }

function isMissingObject(error: unknown): boolean {
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

export async function inspectIntakeUpload(input: {
  key: string
  generation: string
  contentType: string
  bytes: number
  checksumSha256: string
  storage?: IntakeUploadStorageTransport
  signal?: AbortSignal
}): Promise<IntakeUploadInspection> {
  const config = storageConfig()
  const storage = input.storage ?? (storageClient() as unknown as IntakeUploadStorageTransport)
  const expectedChecksum = intakeUploadChecksumBase64(input.checksumSha256)
  let result: {
    VersionId?: string
    ContentLength?: number
    ContentType?: string
    ChecksumSHA256?: string
    Metadata?: Record<string, string>
  }
  try {
    result = (await storage.send(
      new HeadObjectCommand({ Bucket: config.bucket, Key: input.key, ChecksumMode: 'ENABLED' }),
      input.signal ? { abortSignal: input.signal } : undefined,
    )) as typeof result
  } catch (error) {
    if (isMissingObject(error)) return { state: 'missing' }
    throw error
  }

  const versionId =
    typeof result.VersionId === 'string' && result.VersionId ? result.VersionId : null
  if (!versionId) return { state: 'invalid', versionId: null, reason: 'version' }
  if (result.Metadata?.[INTAKE_UPLOAD_GENERATION_METADATA_KEY] !== input.generation) {
    return { state: 'invalid', versionId, reason: 'generation' }
  }
  if (result.ContentLength !== input.bytes) return { state: 'invalid', versionId, reason: 'bytes' }
  if (result.ContentType !== input.contentType)
    return { state: 'invalid', versionId, reason: 'mime' }
  if (
    result.Metadata?.[INTAKE_UPLOAD_MULTIPART_METADATA_KEY] !== 'true' &&
    result.ChecksumSHA256 !== expectedChecksum
  ) {
    return { state: 'invalid', versionId, reason: 'checksum' }
  }
  return { state: 'verified', versionId }
}

export async function deleteInvalidIntakeUploadVersion(input: {
  key: string
  versionId: string
  storage?: IntakeUploadStorageTransport
  signal?: AbortSignal
}): Promise<void> {
  if (!input.versionId) {
    throw new Error('A confirmed immutable object version is required for intake upload deletion.')
  }
  const config = storageConfig()
  const storage = input.storage ?? (storageClient() as unknown as IntakeUploadStorageTransport)
  await storage.send(
    new DeleteObjectCommand({ Bucket: config.bucket, Key: input.key, VersionId: input.versionId }),
    input.signal ? { abortSignal: input.signal } : undefined,
  )
}

export async function readIntakeUploadVersion(input: {
  key: string
  versionId: string
  storage?: IntakeUploadStorageTransport
  signal?: AbortSignal
}): Promise<AsyncIterable<Uint8Array>> {
  if (!input.versionId) throw new Error('An immutable intake upload version is required.')
  const config = storageConfig()
  const storage = input.storage ?? (storageClient() as unknown as IntakeUploadStorageTransport)
  const result = (await storage.send(
    new GetObjectCommand({ Bucket: config.bucket, Key: input.key, VersionId: input.versionId }),
    input.signal ? { abortSignal: input.signal } : undefined,
  )) as { Body?: AsyncIterable<Uint8Array> }
  if (!result.Body || !(Symbol.asyncIterator in result.Body)) {
    throw new Error('The immutable intake upload bytes are unavailable.')
  }
  return result.Body
}
