import { createHash, randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'

import { describe, expect, it } from 'vitest'
import { INTAKE_UPLOAD_MULTIPART_PART_BYTES } from '@pathfinder/contracts/intake-upload'

import { verifyIntakeUploadBytes } from './intake-upload-byte-verifier'
import {
  deleteInvalidIntakeUploadVersion,
  inspectIntakeUpload,
  readIntakeUploadVersion,
  signIntakeUploadPut,
  beginIntakeUploadMultipart,
  completeIntakeUploadMultipart,
  listIntakeUploadMultipartParts,
  signIntakeUploadPart,
} from './intake-upload-storage'

const integrationDescribe =
  process.env.RUN_LOCAL_STAGING_INTAKE_INTEGRATION === '1' ? describe : describe.skip

function fixtureBytes(): Array<{
  mimeType: Parameters<typeof verifyIntakeUploadBytes>[0]['mimeType']
  bytes: Uint8Array
}> {
  const text = (value: string) => new TextEncoder().encode(value)
  return [
    {
      mimeType: 'application/pdf',
      bytes: text(
        '%PDF-1.7\n1 0 obj\n<<>>\nendobj\nxref\n0 1\n0000000000 65535 f\ntrailer\n<<>>\nstartxref\n0\n%%EOF',
      ),
    },
    {
      mimeType: 'image/jpeg',
      bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 1, 0xff, 0xd9]),
    },
    {
      mimeType: 'image/png',
      bytes: Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0,
        0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0,
      ]),
    },
    { mimeType: 'image/webp', bytes: text('RIFF\u0004\u0000\u0000\u0000WEBP') },
    {
      mimeType: 'image/tiff',
      bytes: Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0]),
    },
    {
      mimeType: 'image/heic',
      bytes: Uint8Array.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
    },
    {
      mimeType: 'image/heif',
      bytes: Uint8Array.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31]),
    },
  ]
}

function isPcLocalStagingEndpoint(endpoint: URL): boolean {
  if (endpoint.protocol !== 'http:' || endpoint.port !== '59000') return false
  if (endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost') return true
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .some(
      (entry) => entry.family === 'IPv4' && !entry.internal && entry.address === endpoint.hostname,
    )
}

function assertPcLocalStagingEndpoint(): void {
  const endpoint = new URL(process.env.STORAGE_ENDPOINT ?? '')
  if (!isPcLocalStagingEndpoint(endpoint)) {
    throw new Error('Local staging intake integration requires MinIO port 59000 on this exact PC.')
  }
  if (process.env.STORAGE_BUCKET !== 'pathfinder-local-staging') {
    throw new Error('Local staging intake integration requires the exact PC-local staging bucket.')
  }
}

integrationDescribe('PC-local intake upload storage', () => {
  it('resumes and completes a checksum-bound multipart video', async () => {
    assertPcLocalStagingEndpoint()
    const generation = randomUUID()
    const key = `staging/integration/intake/${randomUUID()}`
    const bytes = new Uint8Array(INTAKE_UPLOAD_MULTIPART_PART_BYTES + 17)
    bytes.set([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex')
    const started = await beginIntakeUploadMultipart({
      key,
      generation,
      contentType: 'video/mp4',
    })
    for (let partNumber = 1; partNumber <= 2; partNumber++) {
      const start = (partNumber - 1) * INTAKE_UPLOAD_MULTIPART_PART_BYTES
      const part = bytes.slice(start, Math.min(bytes.byteLength, start + started.partSize))
      const partChecksum = createHash('sha256').update(part).digest('hex')
      const signed = await signIntakeUploadPart({
        key,
        uploadId: started.uploadId,
        partNumber,
        checksumSha256: partChecksum,
      })
      const response = await fetch(signed.url, {
        method: 'PUT',
        headers: signed.requiredHeaders,
        body: part,
      })
      expect(response.status).toBe(200)
    }
    const parts = await listIntakeUploadMultipartParts({
      key,
      uploadId: started.uploadId,
      expectedBytes: bytes.byteLength,
    })
    expect(parts.map((part) => part.partNumber)).toEqual([1, 2])
    await completeIntakeUploadMultipart({ key, uploadId: started.uploadId, parts })
    const inspection = await inspectIntakeUpload({
      key,
      generation,
      contentType: 'video/mp4',
      bytes: bytes.byteLength,
      checksumSha256,
    })
    expect(inspection.state).toBe('verified')
    if (inspection.state !== 'verified') throw new Error('Expected completed multipart version.')
    const stored = await readIntakeUploadVersion({ key, versionId: inspection.versionId })
    await expect(
      verifyIntakeUploadBytes({
        bytes: stored,
        mimeType: 'video/mp4',
        expectedBytes: bytes.byteLength,
        expectedSha256: checksumSha256,
        storageVersionId: inspection.versionId,
        objectGeneration: generation,
      }),
    ).resolves.toMatchObject({ passed: true })
    await deleteInvalidIntakeUploadVersion({ key, versionId: inspection.versionId })
  })

  it.each(fixtureBytes())(
    'stores and verifies an immutable $mimeType upload',
    async ({ mimeType, bytes }) => {
      assertPcLocalStagingEndpoint()

      const generation = randomUUID()
      const key = `staging/integration/intake/${randomUUID()}`
      const checksumSha256 = createHash('sha256').update(bytes).digest('hex')
      const signed = await signIntakeUploadPut({
        key,
        generation,
        contentType: mimeType,
        bytes: bytes.byteLength,
        checksumSha256,
      })
      const response = await fetch(signed.url, {
        method: 'PUT',
        headers: signed.requiredHeaders,
        body: bytes,
      })
      expect(response.status).toBe(200)

      const inspection = await inspectIntakeUpload({
        key,
        generation,
        contentType: mimeType,
        bytes: bytes.byteLength,
        checksumSha256,
      })
      expect(inspection.state).toBe('verified')
      if (inspection.state !== 'verified') throw new Error('Expected a verified immutable version.')

      const storedBytes = await readIntakeUploadVersion({ key, versionId: inspection.versionId })
      await expect(
        verifyIntakeUploadBytes({
          bytes: storedBytes,
          mimeType,
          expectedBytes: bytes.byteLength,
          expectedSha256: checksumSha256,
          storageVersionId: inspection.versionId,
          objectGeneration: generation,
        }),
      ).resolves.toMatchObject({ passed: true, reason: 'PASSED' })

      await deleteInvalidIntakeUploadVersion({ key, versionId: inspection.versionId })
    },
  )
})
