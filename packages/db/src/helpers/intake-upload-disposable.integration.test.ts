import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  bindIntakeUploadMultipartAction,
  cancelIntakeUploadMultipartAction,
  claimIntakeUploadVerificationAction,
  db,
  recordIntakeUploadPrecheckAction,
  recordIntakeFileExtractionReceiptAction,
  reserveIntakeUploadAction,
  settleIntakeUploadAuthoritativeVerificationAction,
  withTenantIsolationBypass,
} from '../index'

const enabled =
  process.env.RUN_INTAKE_UPLOAD_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('intake upload authoritative disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('settles exact receipts, cited evidence, events, and an idempotent terminal replay', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-upload-${suffix}`
      const venueId = `venue-upload-${suffix}`
      const userId = `user-upload-${suffix}`
      const actor = { type: 'HUMAN' as const, id: userId, role: 'STAFF' as const }
      const bytes = Buffer.from('sanitized disposable upload fixture', 'utf8')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const objectGeneration = randomUUID()

      await db.tenant.create({
        data: { id: tenantId, name: 'Disposable upload tenant', slug: tenantId },
      })
      await db.user.create({
        data: { id: userId, email: `${userId}@example.test`, fullName: 'Upload Tester' },
      })
      await db.tenantMembership.create({
        data: { tenantId, userId, role: 'STAFF', joinedAt: new Date() },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Disposable Upload Venue', slug: venueId },
      })

      const reserved = await reserveIntakeUploadAction({
        tenantId,
        venueId,
        actor,
        request: {
          requestId: randomUUID(),
          displayName: 'Sanitized fixture',
          fileName: 'fixture.txt',
          mimeType: 'text/plain',
          category: 'DOCUMENT',
          byteSize: bytes.byteLength,
          sha256,
        },
        trustedObjectIdentity: {
          objectKey: `intake-quarantine/${randomUUID()}`,
          objectGeneration,
        },
      })
      const precheckClaim = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: precheckClaim,
      })
      const precheckVerdictHash = createHash('sha256').update('precheck-passed').digest('hex')
      await recordIntakeUploadPrecheckAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: precheckClaim,
        verified: {
          objectGeneration,
          storageVersionId: `version-${suffix}`,
          mimeType: 'text/plain',
          byteSize: bytes.byteLength,
          sha256,
        },
        evidence: {
          engine: 'disposable-magic-bytes',
          engineVersion: '1',
          verdictHash: precheckVerdictHash,
          computedByteSize: bytes.byteLength,
          computedSha256: sha256,
        },
      })

      const authoritativeClaim = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: authoritativeClaim,
      })
      const malware = {
        verdict: 'CLEAN' as const,
        engine: 'disposable-clamav',
        engineVersion: '1',
        verdictHash: createHash('sha256').update('malware-clean').digest('hex'),
        computedByteSize: bytes.byteLength,
        computedSha256: sha256,
      }
      const settled = await settleIntakeUploadAuthoritativeVerificationAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: authoritativeClaim,
        malware,
      })
      expect(settled).toMatchObject({
        replayed: false,
        nextAction: 'PATHFINDER_REVIEW',
        upload: { status: 'AWAITING_REVIEW' },
      })

      const replay = await settleIntakeUploadAuthoritativeVerificationAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: authoritativeClaim,
        malware,
      })
      expect(replay).toMatchObject({ replayed: true, nextAction: 'PATHFINDER_REVIEW' })

      const upload = await db.intakeUpload.findUniqueOrThrow({
        where: { id: reserved.upload.id },
        select: {
          status: true,
          verificationClaimId: true,
          verificationLeaseUntil: true,
          verifiedAt: true,
          intakeRunId: true,
        },
      })
      expect(upload).toMatchObject({
        status: 'AWAITING_REVIEW',
        verificationClaimId: null,
        verificationLeaseUntil: null,
      })
      expect(upload.verifiedAt).toBeInstanceOf(Date)
      expect(upload.intakeRunId).toBeTruthy()
      const receipts = await db.intakeUploadVerificationReceipt.findMany({
        where: { tenantId, venueId, uploadId: reserved.upload.id },
        select: { kind: true, verdict: true },
      })
      expect(receipts).toHaveLength(3)
      expect(receipts).toEqual(
        expect.arrayContaining([
          { kind: 'MALWARE', verdict: 'CLEAN' },
          { kind: 'PRECHECK', verdict: 'PASSED' },
          { kind: 'RESOURCE_SAFETY', verdict: 'PASSED' },
        ]),
      )
      const extractionOperationId = randomUUID()
      const extractedText = bytes.toString('utf8')
      const extractionInput = {
        operationId: extractionOperationId,
        tenantId,
        venueId,
        runId: upload.intakeRunId!,
        uploadId: reserved.upload.id,
        requestHash: createHash('sha256')
          .update(`disposable-text-extraction:${suffix}`)
          .digest('hex'),
        outcome: 'SUCCEEDED' as const,
        sourceObjectGeneration: objectGeneration,
        sourceStorageVersionId: `version-${suffix}`,
        sourceSha256: sha256,
        sourceByteSize: bytes.byteLength,
        sourceMimeType: 'text/plain' as const,
        extractor: 'pathfinder-utf8-document' as const,
        extractorVersion: '1' as const,
        extractedText,
        extractedTextHash: createHash('sha256').update(extractedText).digest('hex'),
        extractedCharacterCount: [...extractedText].length,
        extractedLineCount: extractedText.split('\n').length,
        createdBy: userId,
      }
      expect(await recordIntakeFileExtractionReceiptAction(extractionInput)).toMatchObject({
        replayed: false,
        reviewRequired: true,
        packageDraftCreated: false,
        autoApproved: false,
        autoApplied: false,
        autoPublished: false,
      })
      expect(await recordIntakeFileExtractionReceiptAction(extractionInput)).toMatchObject({
        replayed: true,
        reviewRequired: true,
      })
      await expect(
        db.intakeFileExtractionReceipt.update({
          where: { id: extractionOperationId },
          data: { extractedLineCount: 2 },
        }),
      ).rejects.toThrow(/append-only/u)
      await expect(
        db.intakeFileExtractionReceipt.delete({ where: { id: extractionOperationId } }),
      ).rejects.toThrow(/append-only/u)
      expect(
        await db.intakePackageHandoff.count({
          where: { tenantId, venueId, runId: upload.intakeRunId! },
        }),
      ).toBe(0)
      expect(
        await db.intakeEvidenceRecord.count({
          where: { tenantId, venueId, runId: upload.intakeRunId! },
        }),
      ).toBe(1)
      expect(
        await db.intakeRunEvent.count({
          where: { tenantId, venueId, runId: upload.intakeRunId! },
        }),
      ).toBe(3)
      expect(await db.intakeRun.count({ where: { tenantId, venueId } })).toBe(1)
      expect(
        await db.onboardingMilestoneEvent.findMany({
          where: { tenantId, venueId },
          select: { eventType: true, sourceId: true, category: true },
        }),
      ).toEqual([
        {
          eventType: 'FIRST_USEFUL_MATERIAL',
          sourceId: reserved.upload.id,
          category: 'DOCUMENT',
        },
      ])

      const cancelledReservation = await reserveIntakeUploadAction({
        tenantId,
        venueId,
        actor,
        request: {
          requestId: randomUUID(),
          displayName: 'Cancelled multipart fixture',
          fileName: 'cancelled-fixture.mp4',
          mimeType: 'video/mp4',
          category: 'VIDEO_AUDIO',
          byteSize: 33 * 1024 * 1024,
          sha256: createHash('sha256').update('cancelled multipart fixture').digest('hex'),
        },
        trustedObjectIdentity: {
          objectKey: `intake-quarantine/${randomUUID()}`,
          objectGeneration: randomUUID(),
        },
      })
      await bindIntakeUploadMultipartAction({
        tenantId,
        venueId,
        uploadId: cancelledReservation.upload.id,
        actor,
        multipartUploadId: `multipart-${suffix}`,
      })
      await cancelIntakeUploadMultipartAction({
        tenantId,
        venueId,
        uploadId: cancelledReservation.upload.id,
        actor,
        multipartUploadId: `multipart-${suffix}`,
      })
      const cancelledUpload = await db.intakeUpload.findUniqueOrThrow({
        where: { id: cancelledReservation.upload.id },
        select: {
          status: true,
          rejectionCode: true,
          multipartUploadId: true,
          multipartAbortedAt: true,
        },
      })
      expect(cancelledUpload).toMatchObject({
        status: 'REJECTED',
        rejectionCode: 'CLIENT_CANCELLED',
        multipartUploadId: `multipart-${suffix}`,
      })
      expect(cancelledUpload.multipartAbortedAt).toBeInstanceOf(Date)
    })
  }, 30_000)
})
