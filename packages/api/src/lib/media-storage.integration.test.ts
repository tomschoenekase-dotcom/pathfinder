import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  abortMediaUpload,
  beginMediaUpload,
  finishMediaUpload,
  listReusableMediaUploadParts,
  MEDIA_UPLOAD_PART_SIZE,
  signMediaUploadPart,
  type MediaStorageTransport,
} from './media-storage'

const integrationDescribe =
  process.env.RUN_MEDIA_STORAGE_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('media storage (disposable S3-compatible integration)', () => {
  const endpoint = process.env.STORAGE_ENDPOINT ?? ''
  const bucket = process.env.STORAGE_BUCKET ?? ''
  const region = process.env.STORAGE_REGION ?? ''
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID ?? ''
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY ?? ''
  let storage: S3Client

  beforeAll(async () => {
    const url = new URL(endpoint)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.port === '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error(
        'Media storage integration requires an exact loopback HTTP endpoint and port.',
      )
    }
    if (!/^pathfinder-disposable-media-[a-z0-9-]+$/.test(bucket)) {
      throw new Error('Media storage integration requires a disposable bucket name.')
    }
    if (!region || !accessKeyId || !secretAccessKey) {
      throw new Error('Media storage integration requires synthetic local configuration.')
    }

    storage = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    })
    await storage.send(new CreateBucketCommand({ Bucket: bucket }))
  })

  afterAll(async () => {
    if (!storage) return
    const incomplete = await storage
      .send(new ListMultipartUploadsCommand({ Bucket: bucket }))
      .catch(() => null)
    for (const upload of incomplete?.Uploads ?? []) {
      if (upload.Key && upload.UploadId) {
        await abortMediaUpload(
          upload.Key,
          upload.UploadId,
          storage as unknown as MediaStorageTransport,
        ).catch(() => undefined)
      }
    }
    await storage
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: 'verified/archive.zip' }))
      .catch(() => undefined)
    await storage.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined)
    storage.destroy()
  })

  it('lists a partial multipart upload, resumes it, and verifies exact completed bytes', async () => {
    const key = 'verified/archive.zip'
    const firstBody = new Uint8Array(MEDIA_UPLOAD_PART_SIZE).fill(97)
    const secondBody = new TextEncoder().encode('disposable media storage proof')
    const expectedBytes = firstBody.byteLength + secondBody.byteLength
    const started = await beginMediaUpload(key, 'application/zip')
    const firstUrl = await signMediaUploadPart(key, started.uploadId, 1)
    const firstResponse = await fetch(firstUrl, { method: 'PUT', body: firstBody })
    expect(firstResponse.ok).toBe(true)
    const firstEtag = firstResponse.headers.get('etag')
    expect(firstEtag).toBeTruthy()

    await expect(
      listReusableMediaUploadParts(
        key,
        started.uploadId,
        expectedBytes,
        storage as unknown as MediaStorageTransport,
      ),
    ).resolves.toEqual([{ partNumber: 1, etag: firstEtag, size: MEDIA_UPLOAD_PART_SIZE }])

    const secondUrl = await signMediaUploadPart(key, started.uploadId, 2)
    const secondResponse = await fetch(secondUrl, { method: 'PUT', body: secondBody })
    expect(secondResponse.ok).toBe(true)
    const secondEtag = secondResponse.headers.get('etag')
    expect(secondEtag).toBeTruthy()

    const completedParts = await listReusableMediaUploadParts(
      key,
      started.uploadId,
      expectedBytes,
      storage as unknown as MediaStorageTransport,
    )
    expect(completedParts).toEqual([
      { partNumber: 1, etag: firstEtag, size: MEDIA_UPLOAD_PART_SIZE },
      { partNumber: 2, etag: secondEtag, size: secondBody.byteLength },
    ])

    await expect(
      finishMediaUpload(
        key,
        started.uploadId,
        completedParts.map(({ partNumber, etag }) => ({ partNumber, etag })),
        expectedBytes,
        5 * 1024 * 1024 * 1024,
        storage as unknown as MediaStorageTransport,
      ),
    ).resolves.toEqual({ bytes: expectedBytes })
  })

  it('aborts an incomplete upload so it is no longer listed', async () => {
    const key = 'incomplete/archive.zip'
    const started = await beginMediaUpload(key, 'application/zip')
    await abortMediaUpload(key, started.uploadId, storage as unknown as MediaStorageTransport)

    const listed = await storage.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
    )
    expect(listed.Uploads ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ Key: key, UploadId: started.uploadId })]),
    )
  })
})
