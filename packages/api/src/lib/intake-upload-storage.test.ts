import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  INTAKE_UPLOAD_GENERATION_METADATA_KEY,
  INTAKE_UPLOAD_URL_EXPIRES_SECONDS,
  deleteInvalidIntakeUploadVersion,
  createIntakeUploadObjectKey,
  inspectIntakeUpload,
  intakeUploadChecksumBase64,
  signIntakeUploadPut,
  beginIntakeUploadMultipart,
  completeIntakeUploadMultipart,
  listIntakeUploadMultipartParts,
  signIntakeUploadPart,
  type IntakeUploadSigner,
  type IntakeUploadStorageTransport,
} from './intake-upload-storage'

const checksumHex = 'ab'.repeat(32)
const checksumBase64 = Buffer.from(checksumHex, 'hex').toString('base64')

describe('intake upload storage contract', () => {
  beforeEach(() => {
    process.env.STORAGE_BUCKET = 'disposable-private-bucket'
    process.env.STORAGE_REGION = 'us-east-1'
    process.env.STORAGE_ACCESS_KEY_ID = 'synthetic-access-key'
    process.env.STORAGE_SECRET_ACCESS_KEY = 'synthetic-secret-key'
  })

  afterEach(() => {
    delete process.env.STORAGE_BUCKET
    delete process.env.STORAGE_REGION
    delete process.env.STORAGE_ACCESS_KEY_ID
    delete process.env.STORAGE_SECRET_ACCESS_KEY
  })

  it('signs a fifteen-minute create-only PUT bound to exact metadata, MIME, bytes, and checksum', async () => {
    const signer = vi.fn<IntakeUploadSigner>(async () => 'https://signed.invalid/opaque')
    const result = await signIntakeUploadPut({
      key: 'staging/intake-quarantine/opaque-id',
      generation: 'generation-1',
      contentType: 'application/pdf',
      bytes: 123,
      checksumSha256: checksumHex,
      client: {} as S3Client,
      signer,
    })

    expect(result).toEqual({
      url: 'https://signed.invalid/opaque',
      expiresInSeconds: INTAKE_UPLOAD_URL_EXPIRES_SECONDS,
      requiredHeaders: {
        'content-type': 'application/pdf',
        'if-none-match': '*',
        'x-amz-checksum-sha256': checksumBase64,
        [`x-amz-meta-${INTAKE_UPLOAD_GENERATION_METADATA_KEY}`]: 'generation-1',
      },
    })
    const command = signer.mock.calls[0]?.[1]
    expect(command).toBeInstanceOf(PutObjectCommand)
    expect(command?.input).toEqual({
      Bucket: 'disposable-private-bucket',
      Key: 'staging/intake-quarantine/opaque-id',
      ContentLength: 123,
      ContentType: 'application/pdf',
      ChecksumSHA256: checksumBase64,
      IfNoneMatch: '*',
      Metadata: { [INTAKE_UPLOAD_GENERATION_METADATA_KEY]: 'generation-1' },
    })
    expect(signer.mock.calls[0]?.[2]).toEqual({
      expiresIn: 900,
      signableHeaders: new Set(['content-type']),
      unhoistableHeaders: new Set([
        'x-amz-checksum-sha256',
        'x-amz-meta-pf-intake-upload-generation',
      ]),
    })
  })

  it('starts, resumes, signs, and completes an exact checksum-bound multipart transport', async () => {
    const send = vi
      .fn<IntakeUploadStorageTransport['send']>()
      .mockResolvedValueOnce({ UploadId: 'multipart-1' })
      .mockResolvedValueOnce({
        Parts: [
          {
            PartNumber: 1,
            ETag: 'etag-1',
            ChecksumSHA256: checksumBase64,
            Size: 16 * 1024 * 1024,
          },
          { PartNumber: 2, ETag: 'etag-2', ChecksumSHA256: checksumBase64, Size: 5 },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ VersionId: 'version-1' })
    const started = await beginIntakeUploadMultipart({
      key: 'staging/intake-quarantine/opaque-id',
      generation: 'generation-1',
      contentType: 'video/mp4',
      storage: { send },
    })
    expect(started).toMatchObject({ uploadId: 'multipart-1', partSize: 16 * 1024 * 1024 })
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(CreateMultipartUploadCommand)

    const signer = vi.fn(async (client: S3Client, command: UploadPartCommand, options: unknown) => {
      void client
      void command
      void options
      return Promise.resolve('https://signed.invalid/part')
    })
    const signed = await signIntakeUploadPart({
      key: 'staging/intake-quarantine/opaque-id',
      uploadId: 'multipart-1',
      partNumber: 1,
      checksumSha256: checksumHex,
      client: {} as S3Client,
      signer: signer as never,
    })
    expect(signed.requiredHeaders).toEqual({ 'x-amz-checksum-sha256': checksumBase64 })
    expect(signer.mock.calls[0]?.[1]).toBeInstanceOf(UploadPartCommand)

    const parts = await listIntakeUploadMultipartParts({
      key: 'staging/intake-quarantine/opaque-id',
      uploadId: 'multipart-1',
      expectedBytes: 16 * 1024 * 1024 + 5,
      storage: { send },
    })
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(ListPartsCommand)
    expect(parts).toHaveLength(2)
    await expect(
      completeIntakeUploadMultipart({
        key: 'staging/intake-quarantine/opaque-id',
        uploadId: 'multipart-1',
        parts,
        storage: { send },
      }),
    ).resolves.toEqual({ versionId: 'version-1' })
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(CompleteMultipartUploadCommand)
  })

  it('produces an SDK signature carrying the immutable PUT constraints', async () => {
    const result = await signIntakeUploadPut({
      key: 'staging/intake-quarantine/opaque-id',
      generation: 'generation-1',
      contentType: 'application/pdf',
      bytes: 123,
      checksumSha256: checksumHex,
    })
    const signed = new URL(result.url)
    const parameters = new Map(
      [...signed.searchParams.entries()].map(([key, value]) => [key.toLowerCase(), value]),
    )
    expect(parameters.get('x-amz-expires')).toBe('900')
    expect(parameters.has('x-amz-checksum-sha256')).toBe(false)
    expect(parameters.has('x-amz-meta-pf-intake-upload-generation')).toBe(false)
    expect(parameters.get('x-amz-signedheaders')?.split(';')).toEqual(
      expect.arrayContaining([
        'content-length',
        'content-type',
        'host',
        'if-none-match',
        'x-amz-checksum-sha256',
        'x-amz-meta-pf-intake-upload-generation',
      ]),
    )
  })

  it('rejects non-canonical checksums before signing', async () => {
    const signer = vi.fn<IntakeUploadSigner>()
    await expect(
      signIntakeUploadPut({
        key: 'opaque',
        generation: 'generation-1',
        contentType: 'image/png',
        bytes: 1,
        checksumSha256: 'ABC',
        client: {} as S3Client,
        signer,
      }),
    ).rejects.toThrow('64 lowercase hexadecimal')
    expect(signer).not.toHaveBeenCalled()
  })

  it('HEADs with checksum mode and verifies every persisted invariant', async () => {
    const send = vi.fn<IntakeUploadStorageTransport['send']>(async () => ({
      VersionId: 'immutable-version-1',
      ContentLength: 123,
      ContentType: 'application/pdf',
      ChecksumSHA256: checksumBase64,
      Metadata: { [INTAKE_UPLOAD_GENERATION_METADATA_KEY]: 'generation-1' },
    }))
    const result = await inspectIntakeUpload({
      key: 'opaque',
      generation: 'generation-1',
      contentType: 'application/pdf',
      bytes: 123,
      checksumSha256: checksumHex,
      storage: { send } as IntakeUploadStorageTransport,
    })
    expect(result).toEqual({ state: 'verified', versionId: 'immutable-version-1' })
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand)
    expect((send.mock.calls[0]?.[0] as HeadObjectCommand).input).toEqual({
      Bucket: 'disposable-private-bucket',
      Key: 'opaque',
      ChecksumMode: 'ENABLED',
    })
  })

  it.each([
    [
      {
        ContentLength: 123,
        ContentType: 'application/pdf',
        ChecksumSHA256: checksumBase64,
        Metadata: { [INTAKE_UPLOAD_GENERATION_METADATA_KEY]: 'generation-1' },
      },
      'version',
    ],
    [
      {
        VersionId: 'v1',
        ContentLength: 123,
        ContentType: 'application/pdf',
        ChecksumSHA256: checksumBase64,
        Metadata: { [INTAKE_UPLOAD_GENERATION_METADATA_KEY]: 'wrong' },
      },
      'generation',
    ],
    [
      {
        VersionId: 'v1',
        ContentLength: 124,
        ContentType: 'application/pdf',
        ChecksumSHA256: checksumBase64,
        Metadata: { [INTAKE_UPLOAD_GENERATION_METADATA_KEY]: 'generation-1' },
      },
      'bytes',
    ],
    [
      {
        VersionId: 'v1',
        ContentLength: 123,
        ContentType: 'image/png',
        ChecksumSHA256: checksumBase64,
        Metadata: { [INTAKE_UPLOAD_GENERATION_METADATA_KEY]: 'generation-1' },
      },
      'mime',
    ],
    [
      {
        VersionId: 'v1',
        ContentLength: 123,
        ContentType: 'application/pdf',
        ChecksumSHA256: 'wrong',
        Metadata: { [INTAKE_UPLOAD_GENERATION_METADATA_KEY]: 'generation-1' },
      },
      'checksum',
    ],
  ] as const)('rejects an object with a mismatched %s invariant', async (head, reason) => {
    const result = await inspectIntakeUpload({
      key: 'opaque',
      generation: 'generation-1',
      contentType: 'application/pdf',
      bytes: 123,
      checksumSha256: checksumHex,
      storage: { send: vi.fn(async () => head) },
    })
    expect(result).toEqual({
      state: 'invalid',
      versionId: 'VersionId' in head ? head.VersionId : null,
      reason,
    })
  })

  it('distinguishes a missing object while propagating unavailable storage', async () => {
    await expect(
      inspectIntakeUpload({
        key: 'opaque',
        generation: 'g',
        contentType: 'image/png',
        bytes: 1,
        checksumSha256: checksumHex,
        storage: {
          send: vi.fn(async () => {
            throw Object.assign(new Error('gone'), { name: 'NoSuchKey' })
          }),
        },
      }),
    ).resolves.toEqual({ state: 'missing' })

    await expect(
      inspectIntakeUpload({
        key: 'opaque',
        generation: 'g',
        contentType: 'image/png',
        bytes: 1,
        checksumSha256: checksumHex,
        storage: {
          send: vi.fn(async () => {
            throw new Error('storage unavailable')
          }),
        },
      }),
    ).rejects.toThrow('storage unavailable')
  })

  it('defers a multipart composite checksum to the streaming full-file verifier', async () => {
    await expect(
      inspectIntakeUpload({
        key: 'opaque',
        generation: 'generation-1',
        contentType: 'video/mp4',
        bytes: 123,
        checksumSha256: checksumHex,
        storage: {
          send: vi.fn(async () => ({
            VersionId: 'version-1',
            ContentLength: 123,
            ContentType: 'video/mp4',
            ChecksumSHA256: 'composite-checksum-2',
            Metadata: {
              [INTAKE_UPLOAD_GENERATION_METADATA_KEY]: 'generation-1',
              'pf-intake-upload-multipart': 'true',
            },
          })),
        },
      }),
    ).resolves.toEqual({ state: 'verified', versionId: 'version-1' })
  })

  it('deletes only an explicitly supplied immutable version', async () => {
    const send = vi.fn<IntakeUploadStorageTransport['send']>(async () => ({}))
    await deleteInvalidIntakeUploadVersion({ key: 'opaque', versionId: 'v1', storage: { send } })
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectCommand)
    expect((send.mock.calls[0]?.[0] as DeleteObjectCommand).input).toEqual({
      Bucket: 'disposable-private-bucket',
      Key: 'opaque',
      VersionId: 'v1',
    })
    await expect(
      deleteInvalidIntakeUploadVersion({ key: 'opaque', versionId: '', storage: { send } }),
    ).rejects.toThrow('immutable object version')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('converts only a canonical hexadecimal SHA-256 value', () => {
    expect(intakeUploadChecksumBase64(checksumHex)).toBe(checksumBase64)
  })

  it('creates a deployment-scoped opaque key with no filename component', () => {
    process.env.RAILWAY_ENVIRONMENT = 'preview'
    const key = createIntakeUploadObjectKey()
    expect(key).toMatch(
      /^preview\/intake-quarantine\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    expect(key).not.toContain('.pdf')
    delete process.env.RAILWAY_ENVIRONMENT
  })
})
