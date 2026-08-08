import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  finishMediaUpload,
  MEDIA_UPLOAD_PART_SIZE,
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
        { send } as MediaStorageTransport,
      ),
    ).rejects.toThrow(/could not be verified/)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('aborts a failed completion and preserves abort failure context', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('complete failed'))
      .mockRejectedValueOnce(new Error('abort failed'))

    await expect(
      finishMediaUpload(
        'staging/project.zip',
        'upload-1',
        [{ partNumber: 1, etag: 'one' }],
        10,
        20,
        { send } as MediaStorageTransport,
      ),
    ).rejects.toThrow(/complete failed; multipart abort also failed/)
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(AbortMultipartUploadCommand)
  })

  it('rethrows the original completion error after a successful abort', async () => {
    const completionError = new Error('complete failed')
    const send = vi.fn().mockRejectedValueOnce(completionError).mockResolvedValueOnce({})

    await expect(
      finishMediaUpload(
        'staging/project.zip',
        'upload-1',
        [{ partNumber: 1, etag: 'one' }],
        10,
        20,
        { send } as MediaStorageTransport,
      ),
    ).rejects.toBe(completionError)
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(AbortMultipartUploadCommand)
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
        { send } as MediaStorageTransport,
      ),
    ).rejects.toThrow(/empty; object removal also failed/)
  })
})
