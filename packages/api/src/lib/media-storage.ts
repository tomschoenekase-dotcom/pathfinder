import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const PART_SIZE = 16 * 1024 * 1024

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

function client() {
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
  return { uploadId: result.UploadId, partSize: PART_SIZE }
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
) {
  const { bucket } = storageConfig()
  await client().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
      },
    }),
  )
}
