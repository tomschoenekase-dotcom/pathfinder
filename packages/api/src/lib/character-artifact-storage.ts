import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  fingerprintFactoryRequest,
  readCharacterBundle,
  readCharacterRuntimePack,
  type CharacterExportArtifact,
  type CharacterSpec,
} from '@pathfinder/character-factory'

const MAX_ARTIFACT_BYTES = 12_000_000
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u
const SHA256 = /^[a-f0-9]{64}$/u

type StorageCommand = PutObjectCommand | HeadObjectCommand | GetObjectCommand
export type CharacterArtifactTransport = {
  send(command: StorageCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>
}

export type CharacterArtifactReference = {
  kind: 'character-bundle-v1'
  bucket: string
  objectKey: string
  sha256: string
  byteLength: number
  mediaType: 'application/vnd.pathfinder.character+json'
  characterId: string
  characterVersion: number
  versionId: string
}

export class CharacterArtifactStorageError extends Error {
  constructor(
    public readonly code: 'INVALID_REFERENCE' | 'MISSING' | 'INTEGRITY_FAILED' | 'SCOPE_MISMATCH',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CharacterArtifactStorageError'
  }
}

function configuration() {
  const bucket = process.env.STORAGE_BUCKET
  const region = process.env.STORAGE_REGION
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY
  if (!bucket || !region || !accessKeyId || !secretAccessKey)
    throw new Error('Character artifact storage is not configured.')
  return { bucket, region, accessKeyId, secretAccessKey }
}

function defaultTransport(): S3Client {
  const value = configuration()
  return new S3Client({
    region: value.region,
    credentials: { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey },
    ...(process.env.STORAGE_ENDPOINT
      ? { endpoint: process.env.STORAGE_ENDPOINT, forcePathStyle: true }
      : {}),
  })
}

function segment(value: string, name: string): string {
  if (!ID.test(value))
    throw new CharacterArtifactStorageError('INVALID_REFERENCE', `${name} is invalid.`)
  return value
}

function objectKey(scope: {
  tenantId: string
  venueId: string
  characterId: string
  characterVersion: number
  sha256: string
}) {
  if (
    !Number.isSafeInteger(scope.characterVersion) ||
    scope.characterVersion < 1 ||
    !SHA256.test(scope.sha256)
  )
    throw new CharacterArtifactStorageError(
      'INVALID_REFERENCE',
      'Artifact version or checksum is invalid.',
    )
  return `character-factory/${segment(scope.tenantId, 'Tenant ID')}/${segment(scope.venueId, 'Venue ID')}/${segment(scope.characterId, 'Character ID')}/v${scope.characterVersion}/${scope.sha256}.character.json`
}

function isMissing(error: unknown) {
  const value = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
  return (
    value?.name === 'NoSuchKey' ||
    value?.name === 'NotFound' ||
    value?.Code === 'NoSuchKey' ||
    value?.$metadata?.httpStatusCode === 404
  )
}

function isPrecondition(error: unknown) {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412
}

async function boundedSend(transport: CharacterArtifactTransport, command: StorageCommand) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    return await transport.send(command, { abortSignal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function parseReference(value: unknown): CharacterArtifactReference {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CharacterArtifactStorageError('INVALID_REFERENCE', 'Artifact reference is invalid.')
  const candidate = value as Partial<CharacterArtifactReference>
  const keys = Object.keys(candidate).sort().join(',')
  if (
    keys !==
      'bucket,byteLength,characterId,characterVersion,kind,mediaType,objectKey,sha256,versionId' ||
    candidate.kind !== 'character-bundle-v1' ||
    candidate.mediaType !== 'application/vnd.pathfinder.character+json' ||
    typeof candidate.bucket !== 'string' ||
    !ID.test(candidate.bucket) ||
    typeof candidate.objectKey !== 'string' ||
    typeof candidate.sha256 !== 'string' ||
    !SHA256.test(candidate.sha256) ||
    typeof candidate.byteLength !== 'number' ||
    !Number.isSafeInteger(candidate.byteLength) ||
    candidate.byteLength < 1 ||
    candidate.byteLength > MAX_ARTIFACT_BYTES ||
    typeof candidate.characterId !== 'string' ||
    typeof candidate.characterVersion !== 'number' ||
    typeof candidate.versionId !== 'string' ||
    candidate.versionId.length < 1 ||
    candidate.versionId.length > 1_000
  )
    throw new CharacterArtifactStorageError('INVALID_REFERENCE', 'Artifact reference is invalid.')
  segment(candidate.characterId, 'Character ID')
  if (!Number.isSafeInteger(candidate.characterVersion) || candidate.characterVersion < 1)
    throw new CharacterArtifactStorageError('INVALID_REFERENCE', 'Artifact version is invalid.')
  return candidate as CharacterArtifactReference
}

function cancelBody(body: unknown, iterator?: AsyncIterator<Uint8Array>) {
  if (body && typeof body === 'object' && 'destroy' in body && typeof body.destroy === 'function') {
    try {
      body.destroy()
    } catch {
      /* best effort */
    }
  }
  try {
    const returned = iterator?.return?.()
    if (returned && typeof returned.catch === 'function') void returned.catch(() => undefined)
  } catch {
    /* best effort */
  }
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = []
    let total = 0
    const iterator = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    const deadline = Date.now() + 15_000
    let finished = false
    try {
      while (!finished) {
        const remaining = deadline - Date.now()
        if (remaining <= 0)
          throw new CharacterArtifactStorageError(
            'INTEGRITY_FAILED',
            'Stored artifact body timed out.',
          )
        let timer: ReturnType<typeof setTimeout> | undefined
        const item = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new CharacterArtifactStorageError(
                    'INTEGRITY_FAILED',
                    'Stored artifact body timed out.',
                  ),
                ),
              remaining,
            )
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer)
        })
        if (item.done) {
          finished = true
          continue
        }
        const bytes = Uint8Array.from(item.value)
        total += bytes.byteLength
        if (total > MAX_ARTIFACT_BYTES)
          throw new CharacterArtifactStorageError(
            'INTEGRITY_FAILED',
            'Stored artifact exceeds the byte limit.',
          )
        chunks.push(bytes)
      }
    } catch (error) {
      cancelBody(body, iterator)
      throw error
    }
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return joined
  }
  cancelBody(body)
  throw new CharacterArtifactStorageError(
    'INTEGRITY_FAILED',
    'Storage must return a cancellable streaming artifact body.',
  )
}

export function createCharacterArtifactStorage(
  transport: CharacterArtifactTransport = defaultTransport() as CharacterArtifactTransport,
  configuredBucket = configuration().bucket,
) {
  return {
    async put(input: { tenantId: string; venueId: string; artifact: CharacterExportArtifact }) {
      const spec = await readCharacterBundle(input.artifact)
      const key = objectKey({
        tenantId: input.tenantId,
        venueId: input.venueId,
        characterId: spec.characterId,
        characterVersion: spec.version,
        sha256: input.artifact.sha256,
      })
      if (input.artifact.byteLength > MAX_ARTIFACT_BYTES)
        throw new CharacterArtifactStorageError(
          'INTEGRITY_FAILED',
          'Artifact exceeds the byte limit.',
        )
      let versionId: string | undefined
      try {
        const put = (await boundedSend(
          transport,
          new PutObjectCommand({
            Bucket: configuredBucket,
            Key: key,
            Body: input.artifact.bytes,
            ContentLength: input.artifact.byteLength,
            ContentType: input.artifact.mediaType,
            IfNoneMatch: '*',
            Metadata: { 'pathfinder-sha256': input.artifact.sha256 },
          }),
        )) as { VersionId?: string }
        versionId = put.VersionId
      } catch (error) {
        if (!isPrecondition(error)) throw error
        const head = (await boundedSend(
          transport,
          new HeadObjectCommand({ Bucket: configuredBucket, Key: key }),
        )) as { ContentLength?: number; Metadata?: Record<string, string>; VersionId?: string }
        if (
          head.ContentLength !== input.artifact.byteLength ||
          head.Metadata?.['pathfinder-sha256'] !== input.artifact.sha256
        )
          throw new CharacterArtifactStorageError(
            'INTEGRITY_FAILED',
            'Existing content-addressed artifact differs from the submitted bytes.',
            { cause: error },
          )
        versionId = head.VersionId
      }
      if (!versionId)
        throw new CharacterArtifactStorageError(
          'INTEGRITY_FAILED',
          'Versioned character artifact storage is required.',
        )
      const reference = {
        kind: 'character-bundle-v1',
        bucket: configuredBucket,
        objectKey: key,
        sha256: input.artifact.sha256,
        byteLength: input.artifact.byteLength,
        mediaType: input.artifact.mediaType,
        characterId: spec.characterId,
        characterVersion: spec.version,
        versionId,
      } satisfies CharacterArtifactReference
      if (versionId)
        await this.getVerified({
          tenantId: input.tenantId,
          venueId: input.venueId,
          reference,
          expectedSpec: spec,
        })
      return reference
    },

    async getVerified(input: {
      tenantId: string
      venueId: string
      reference: unknown
      expectedSpec?: CharacterSpec
    }) {
      const reference = parseReference(input.reference)
      if (reference.bucket !== configuredBucket)
        throw new CharacterArtifactStorageError(
          'SCOPE_MISMATCH',
          'Artifact bucket is outside the configured storage scope.',
        )
      const expectedKey = objectKey({
        tenantId: input.tenantId,
        venueId: input.venueId,
        characterId: reference.characterId,
        characterVersion: reference.characterVersion,
        sha256: reference.sha256,
      })
      if (reference.objectKey !== expectedKey)
        throw new CharacterArtifactStorageError(
          'SCOPE_MISMATCH',
          'Artifact reference is outside the requested tenant or venue scope.',
        )
      let response: {
        Body?: unknown
        ContentLength?: number
        ContentType?: string
        Metadata?: Record<string, string>
      }
      try {
        response = (await boundedSend(
          transport,
          new GetObjectCommand({
            Bucket: configuredBucket,
            Key: expectedKey,
            VersionId: reference.versionId,
          }),
        )) as typeof response
      } catch (error) {
        if (isMissing(error))
          throw new CharacterArtifactStorageError('MISSING', 'Character artifact is missing.', {
            cause: error,
          })
        throw error
      }
      if (
        response.ContentLength !== reference.byteLength ||
        response.ContentType !== reference.mediaType ||
        response.Metadata?.['pathfinder-sha256'] !== reference.sha256
      ) {
        cancelBody(response.Body)
        throw new CharacterArtifactStorageError(
          'INTEGRITY_FAILED',
          'Stored character artifact metadata does not match its reference.',
        )
      }
      const bytes = await bodyBytes(response.Body)
      const artifact: CharacterExportArtifact = {
        mediaType: reference.mediaType,
        schemaVersion: 1,
        characterId: reference.characterId,
        characterVersion: reference.characterVersion,
        sha256: reference.sha256,
        byteLength: reference.byteLength,
        bytes,
      }
      let spec: CharacterSpec
      try {
        spec = await readCharacterBundle(artifact)
      } catch (error) {
        throw new CharacterArtifactStorageError(
          'INTEGRITY_FAILED',
          'Stored character artifact failed bundle validation.',
          { cause: error },
        )
      }
      if (
        spec.characterId !== reference.characterId ||
        spec.version !== reference.characterVersion ||
        (input.expectedSpec &&
          fingerprintFactoryRequest(spec) !== fingerprintFactoryRequest(input.expectedSpec))
      )
        throw new CharacterArtifactStorageError(
          'INTEGRITY_FAILED',
          'Stored character artifact does not match the exact completed character specification.',
        )
      const decoded = JSON.parse(new TextDecoder().decode(bytes)) as { runtimePack?: unknown }
      const runtimePack =
        decoded.runtimePack === undefined
          ? undefined
          : (await readCharacterRuntimePack(artifact)).runtimePack
      return { reference, spec, bytes, ...(runtimePack ? { runtimePack } : {}) }
    },

    cleanupCancelled(reference: unknown) {
      // Final keys are immutable and may be shared by replayed jobs. Retention policy owns deletion.
      void reference
      return { disposition: 'retained-content-addressed' as const }
    },
  }
}

export async function beginCharacterArtifactUpload(input: {
  tenantId: string
  venueId: string
  characterId: string
  characterVersion: number
  sha256: string
  byteLength: number
}) {
  if (
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 1 ||
    input.byteLength > MAX_ARTIFACT_BYTES
  )
    throw new CharacterArtifactStorageError('INVALID_REFERENCE', 'Artifact byte length is invalid.')
  const storage = configuration()
  const key = objectKey(input)
  const command = new PutObjectCommand({
    Bucket: storage.bucket,
    Key: key,
    ContentLength: input.byteLength,
    ContentType: 'application/vnd.pathfinder.character+json',
    IfNoneMatch: '*',
    Metadata: { 'pathfinder-sha256': input.sha256 },
  })
  const signer = defaultTransport()
  let uploadUrl: string
  try {
    uploadUrl = await getSignedUrl(signer, command, { expiresIn: 15 * 60 })
  } finally {
    signer.destroy()
  }
  return {
    method: 'PUT' as const,
    uploadUrl,
    expiresInSeconds: 15 * 60,
    referenceTemplate: {
      kind: 'character-bundle-v1' as const,
      bucket: storage.bucket,
      objectKey: key,
      sha256: input.sha256,
      byteLength: input.byteLength,
      mediaType: 'application/vnd.pathfinder.character+json' as const,
      characterId: input.characterId,
      characterVersion: input.characterVersion,
    },
  }
}
