import { describe, expect, it } from 'vitest'

import {
  INTAKE_UPLOAD_MAX_BYTES,
  IntakeUploadReserveRequest,
  IntakeUploadVerifiedTransport,
  resolveIntakeUploadClientRecovery,
  resolveIntakeUploadClientVerification,
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

  it.each([
    ['OBJECT_MISSING', 'could not finish receiving'],
    ['GENERATION_MISMATCH', 'did not match'],
    ['MIME_MISMATCH', 'did not match'],
    ['SIZE_MISMATCH', 'did not match'],
    ['HASH_MISMATCH', 'did not match'],
    ['UNSAFE_FILE', 'did not pass the required safety checks'],
  ])('maps rejected code %s to one non-retry replacement action', (rejectionCode, reason) => {
    expect(resolveIntakeUploadClientRecovery({ status: 'REJECTED', rejectionCode })).toMatchObject({
      kind: 'CHOOSE_REPLACEMENT',
      required: true,
      actionLabel: 'Choose a replacement',
      reason: expect.stringContaining(reason),
      retrySameSubmission: false,
    })
  })

  it('keeps a client-cancelled upload out of the required recovery queue', () => {
    expect(
      resolveIntakeUploadClientRecovery({
        status: 'REJECTED',
        rejectionCode: 'CLIENT_CANCELLED',
      }),
    ).toEqual({
      kind: 'NONE',
      required: false,
      actionLabel: null,
      reason: 'You cancelled this upload. It does not block onboarding.',
      retrySameSubmission: false,
    })
  })

  it('keeps a live verification lease non-actionable', () => {
    expect(
      resolveIntakeUploadClientVerification({
        status: 'VERIFYING',
        verificationLeaseActive: true,
      }),
    ).toMatchObject({ kind: 'IN_PROGRESS', required: false, retrySameSubmission: false })
  })

  it('makes an expired verification safely resumable', () => {
    expect(resolveIntakeUploadClientVerification({ status: 'VERIFYING' })).toEqual({
      kind: 'RESUME_CHECK',
      required: true,
      actionLabel: 'Resume file check',
      reason: 'The saved file check stopped before it finished.',
      retrySameSubmission: true,
    })
  })

  it('keeps Torchiko-managed security checks non-actionable for the customer', () => {
    expect(
      resolveIntakeUploadClientVerification({
        status: 'VERIFYING',
        managedByTorchiko: true,
      }),
    ).toMatchObject({ kind: 'WAIT_FOR_TORCHIKO', required: false, retrySameSubmission: false })
    expect(resolveIntakeUploadClientVerification({ status: 'PRECHECK_PASSED' })).toMatchObject({
      kind: 'WAIT_FOR_TORCHIKO',
      required: false,
      retrySameSubmission: false,
    })
  })

  it('does not invent verification work for terminal states', () => {
    expect(resolveIntakeUploadClientVerification({ status: 'AWAITING_REVIEW' })).toMatchObject({
      kind: 'NONE',
      required: false,
    })
  })
})
