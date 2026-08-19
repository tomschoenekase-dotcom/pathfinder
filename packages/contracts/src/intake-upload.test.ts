import { describe, expect, it } from 'vitest'

import {
  INTAKE_UPLOAD_MAX_BYTES,
  IntakeUploadReserveRequest,
  IntakeUploadVerifiedTransport,
} from './intake-upload'

const sha256 = 'a'.repeat(64)

describe('intake upload browser-safe contracts', () => {
  it.each([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/tiff',
  ])('accepts allowlisted MIME %s', (mimeType) => {
    expect(
      IntakeUploadReserveRequest.safeParse({
        requestId: 'e686bd50-8f62-4acd-bf3d-bcb56e66029b',
        displayName: 'Visitor guide',
        fileName: 'guide.pdf',
        mimeType,
        category: 'DOCUMENT',
        byteSize: INTAKE_UPLOAD_MAX_BYTES,
        sha256,
      }).success,
    ).toBe(true)
  })

  it.each(['image/svg+xml', 'image/gif', 'text/html', 'application/octet-stream'])(
    'rejects non-allowlisted or active MIME %s',
    (mimeType) => {
      expect(
        IntakeUploadReserveRequest.safeParse({
          requestId: 'e686bd50-8f62-4acd-bf3d-bcb56e66029b',
          displayName: 'Unsafe',
          fileName: 'unsafe.bin',
          mimeType,
          category: 'OTHER',
          byteSize: 1,
          sha256,
        }).success,
      ).toBe(false)
    },
  )

  it('enforces the byte ceiling, UUID generation, lowercase hash, and strict shape', () => {
    const base = {
      objectGeneration: 'e686bd50-8f62-4acd-bf3d-bcb56e66029b',
      storageVersionId: 'version-1',
      mimeType: 'application/pdf',
      byteSize: INTAKE_UPLOAD_MAX_BYTES,
      sha256,
    }
    expect(IntakeUploadVerifiedTransport.safeParse(base).success).toBe(true)
    expect(
      IntakeUploadVerifiedTransport.safeParse({ ...base, byteSize: INTAKE_UPLOAD_MAX_BYTES + 1 })
        .success,
    ).toBe(false)
    expect(
      IntakeUploadVerifiedTransport.safeParse({ ...base, sha256: 'A'.repeat(64) }).success,
    ).toBe(false)
    expect(IntakeUploadVerifiedTransport.safeParse({ ...base, extra: true }).success).toBe(false)
  })
})
