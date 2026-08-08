import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  beginMediaUpload,
  canonicalMediaUploadEtag,
  finishMediaUpload,
  inspectCompletedMediaUpload,
  listReusableMediaUploadParts,
  MEDIA_UPLOAD_GENERATION_METADATA_KEY,
  MEDIA_UPLOAD_PART_SIZE,
  MediaUploadCompletionUnconfirmedError,
  mediaUploadPartCount,
  normalizeMediaUploadParts,
  type MediaStorageTransport,
} from './media-storage'

describe('media storage contract', () => {
  beforeEach(() => {
    vi.stubEnv('STORAGE_BUCKET', 'disposable-media')
    vi.stubEnv('STORAGE_REGION', 'us-east-1')
    vi.stubEnv('STORAGE_ACCESS_KEY_ID', 'synthetic-access')
    vi.stubEnv('STORAGE_SECRET_ACCESS_KEY', 'synthetic-secret')
  })

  afterEach(() => vi.unstubAllEnvs())

  it('derives a bounded multipart contract from declared bytes', () => {
    expect(mediaUploadPartCount(MEDIA_UPLOAD_PART_SIZE)).toBe(1)
    expect(mediaUploadPartCount(MEDIA_UPLOAD_PART_SIZE + 1)).toBe(2)
    expect(() => mediaUploadPartCount(0)).toThrow(/positive safe integer/)
  })

  it('binds a new multipart upload to its immutable generation metadata', async () => {
    const send = vi.fn().mockResolvedValue({ UploadId: 'upload-1' })
    await expect(
      beginMediaUpload('staging/project/attempt/archive.zip', 'application/zip', 'attempt-1', {
        send,
      }),
    ).resolves.toEqual({ uploadId: 'upload-1', partSize: MEDIA_UPLOAD_PART_SIZE })

    const command = send.mock.calls[0]?.[0]
    expect(command).toBeInstanceOf(CreateMultipartUploadCommand)
    expect((command as CreateMultipartUploadCommand).input.Metadata).toEqual({
      [MEDIA_UPLOAD_GENERATION_METADATA_KEY]: 'attempt-1',
    })
  })

  it('normalizes a complete contiguous part set and rejects gaps or duplicates', () => {
    expect(
      normalizeMediaUploadParts(
        [
          { partNumber: 2, etag: 'two' },
          { partNumber: 1, etag: 'one' },
        ],
        2,
      ),
    ).toEqual([
      { partNumber: 1, etag: 'one' },
      { partNumber: 2, etag: 'two' },
    ])
    expect(() =>
      normalizeMediaUploadParts(
        [
          { partNumber: 1, etag: 'one' },
          { partNumber: 1, etag: 'duplicate' },
        ],
        2,
      ),
    ).toThrow(/contiguous/)
    expect(() => normalizeMediaUploadParts([{ partNumber: 1, etag: 'one' }], 2)).toThrow(
      /exactly 2/,
    )
  })

  it('canonicalizes transport quoting without changing the storage ETag value', () => {
    expect(canonicalMediaUploadEtag('  "etag-value"  ')).toBe('etag-value')
    expect(canonicalMediaUploadEtag('etag-value')).toBe('etag-value')
  })

  it('lists paginated reusable parts and excludes parts with the wrong byte length', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Parts: [
          { PartNumber: 1, ETag: 'one', Size: MEDIA_UPLOAD_PART_SIZE },
          { PartNumber: 2, ETag: 'wrong-size', Size: 1 },
        ],
        IsTruncated: true,
        NextPartNumberMarker: '2',
      })
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 3, ETag: 'three', Size: 7 }],
        IsTruncated: false,
      })

    await expect(
      listReusableMediaUploadParts(
        'staging/project.zip',
        'upload-1',
        MEDIA_UPLOAD_PART_SIZE * 2 + 7,
        { send } as MediaStorageTransport,
      ),
    ).resolves.toEqual([
      { partNumber: 1, etag: 'one', size: MEDIA_UPLOAD_PART_SIZE },
      { partNumber: 3, etag: 'three', size: 7 },
    ])

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ListPartsCommand)
    expect((send.mock.calls[1]?.[0] as ListPartsCommand).input.PartNumberMarker).toBe('2')
  })

  it('rejects invalid multipart resume metadata and non-advancing pagination', async () => {
    await expect(
      listReusableMediaUploadParts('staging/project.zip', 'upload-1', 10, {
        send: vi.fn().mockResolvedValue({
          Parts: [{ PartNumber: 1, ETag: undefined, Size: 10 }],
        }),
      }),
    ).rejects.toThrow(/invalid multipart resume metadata/)

    const send = vi
      .fn()
      .mockResolvedValueOnce({ IsTruncated: true, NextPartNumberMarker: '1' })
      .mockResolvedValueOnce({ IsTruncated: true, NextPartNumberMarker: '1' })
    await expect(
      listReusableMediaUploadParts('staging/project.zip', 'upload-1', 10, { send }),
    ).rejects.toThrow(/invalid multipart resume pagination/)
  })

  it('completes, inspects, and returns the exact server-observed size', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ VersionId: 'completed-version' })
      .mockResolvedValueOnce({ ContentLength: 10, VersionId: 'inspected-version' })
    const storage = { send } as MediaStorageTransport

    await expect(
      finishMediaUpload(
        'staging/project.zip',
        'upload-1',
        [{ partNumber: 1, etag: 'one' }],
        10,
        20,
        undefined,
        storage,
      ),
    ).resolves.toEqual({ bytes: 10 })

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(CompleteMultipartUploadCommand)
    const inspection = send.mock.calls[1]?.[0]
    expect(inspection).toBeInstanceOf(HeadObjectCommand)
    expect((inspection as HeadObjectCommand).input.VersionId).toBe('completed-version')
  })

  it.each([1, 5 * 1024 * 1024 * 1024])('accepts the inclusive byte boundary: %s', async (bytes) => {
    const send = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ ContentLength: bytes })
    await expect(
      finishMediaUpload(
        'staging/project.zip',
        'upload-1',
        [{ partNumber: 1, etag: 'one' }],
        bytes,
        5 * 1024 * 1024 * 1024,
        undefined,
        { send } as MediaStorageTransport,
      ),
    ).resolves.toEqual({ bytes })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it.each([
    { bytes: 0, expected: 10, maximum: 20, message: 'empty' },
    { bytes: 21, expected: 20, maximum: 20, message: 'exceeds' },
    { bytes: 11, expected: 10, maximum: 20, message: 'does not match' },
  ])('removes a confirmed invalid completed object: $message', async (testCase) => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ VersionId: 'completed-version' })
      .mockResolvedValueOnce({ ContentLength: testCase.bytes, VersionId: 'inspected-version' })
      .mockResolvedValueOnce({})
    const storage = { send } as MediaStorageTransport

    await expect(
      finishMediaUpload(
        'staging/project.zip',
        'upload-1',
        [{ partNumber: 1, etag: 'one' }],
        testCase.expected,
        testCase.maximum,
        undefined,
        storage,
      ),
    ).rejects.toThrow(testCase.message)

    const deletion = send.mock.calls[2]?.[0]
    expect(deletion).toBeInstanceOf(DeleteObjectCommand)
    expect((deletion as DeleteObjectCommand).input).toMatchObject({
      Bucket: 'disposable-media',
      Key: 'staging/project.zip',
      VersionId: 'completed-version',
    })
  })

  it('fails closed without deleting when object inspection is unavailable', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ VersionId: 'completed-version' })
      .mockRejectedValueOnce(new Error('head unavailable'))

    await expect(
      finishMediaUpload(
        'staging/project.zip',
        'upload-1',
        [{ partNumber: 1, etag: 'one' }],
        10,
        20,
        undefined,
        { send } as MediaStorageTransport,
      ),
    ).rejects.toBeInstanceOf(MediaUploadCompletionUnconfirmedError)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('reconciles a dropped completion response through exact generation metadata', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('complete failed'))
      .mockResolvedValueOnce({
        ContentLength: 10,
        Metadata: { [MEDIA_UPLOAD_GENERATION_METADATA_KEY]: 'attempt-1' },
      })

    await expect(
      finishMediaUpload(
        'staging/project.zip',
        'upload-1',
        [{ partNumber: 1, etag: 'one' }],
        10,
        20,
        'attempt-1',
        { send } as MediaStorageTransport,
      ),
    ).resolves.toEqual({ bytes: 10 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(HeadObjectCommand)
  })

  it('leaves an unproven completion unresolved without aborting it', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('complete failed'))
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFound' }))

    await expect(
      finishMediaUpload(
        'staging/project.zip',
        'upload-1',
        [{ partNumber: 1, etag: 'one' }],
        10,
        20,
        'attempt-1',
        { send } as MediaStorageTransport,
      ),
    ).rejects.toBeInstanceOf(MediaUploadCompletionUnconfirmedError)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not trust an object with the wrong generation during reconciliation', async () => {
    const send = vi.fn().mockResolvedValue({
      ContentLength: 10,
      Metadata: { [MEDIA_UPLOAD_GENERATION_METADATA_KEY]: 'another-attempt' },
    })
    await expect(
      inspectCompletedMediaUpload('staging/project.zip', 10, 20, 'attempt-1', undefined, {
        send,
      } as MediaStorageTransport),
    ).resolves.toEqual({ state: 'identity-mismatch' })
  })

  it('keeps a legacy completion ambiguous without inspecting a reusable key', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('complete failed'))
    await expect(
      finishMediaUpload(
        'staging/project.zip',
        'upload-1',
        [{ partNumber: 1, etag: 'one' }],
        10,
        20,
        undefined,
        { send } as MediaStorageTransport,
      ),
    ).rejects.toBeInstanceOf(MediaUploadCompletionUnconfirmedError)
    expect(send).toHaveBeenCalledOnce()
  })

  it('preserves the validation reason when invalid-object removal fails', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ContentLength: 0 })
      .mockRejectedValueOnce(new Error('delete failed'))

    await expect(
      finishMediaUpload(
        'staging/project.zip',
        'upload-1',
        [{ partNumber: 1, etag: 'one' }],
        10,
        20,
        undefined,
        { send } as MediaStorageTransport,
      ),
    ).rejects.toThrow(/empty; object removal also failed/)
  })
})
