import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/ai')>()
  return {
    ...actual,
    generateEmbeddings: vi.fn(async ({ texts }: { texts: string[] }) => ({
      embeddings: texts.map(() => [1, ...Array(1535).fill(0)]),
    })),
    getAiEmbeddingProfile: () => 'fixture-profile',
    AI_EMBEDDING_MODEL_KEYS: { PLACE_CONTENT: 'place', KNOWLEDGE_CONTENT: 'knowledge' },
  }
})
vi.mock('@pathfinder/analytics', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@pathfinder/jobs', () => ({ enqueueEmbedPlace: vi.fn().mockResolvedValue(undefined) }))

import {
  claimIntakeUploadVerificationAction,
  claimIntakeV1FileExtractionDispatch,
  completeIntakeV1FileExtractionDispatch,
  db,
  failIntakeV1FileExtractionDispatch,
  preflightIntakeV1FileExtractionDispatch,
  recordIntakeUploadPrecheckAction,
  reserveIntakeUploadAction,
  reviewIntakeFileExtractionAction,
  settleIntakeUploadAuthoritativeVerificationAction,
  submitIntakeV1Action,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { executeIntakeFileExtraction } from './lib/intake-file-extraction-service'
import { buildIntakeV1PackageCandidate } from './lib/intake-v1-package-candidate'
import { createIntakeV1PackageDraftForAdmin } from './lib/intake-v1-package-draft'

const enabled =
  process.env.RUN_INTAKE_V1_FILE_EXTRACTION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_intake_v1_file_extraction_[a-f0-9]{12}$/u.test(
    process.env.DATABASE_URL ?? '',
  )

function sha256(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

describe.skipIf(!enabled)('V1 file extraction disposable journey', () => {
  afterAll(async () => db.$disconnect())

  it('carries exact verified files through extraction, review, and a review-only draft', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-file-v1-${suffix}`
      const venueId = `venue-file-v1-${suffix}`
      const ownerUserId = `owner-file-v1-${suffix}`
      const actor = { type: 'HUMAN' as const, id: ownerUserId, role: 'MANAGER' as const }
      await db.tenant.create({ data: { id: tenantId, name: 'File V1 fixture', slug: tenantId } })
      await db.user.create({ data: { id: ownerUserId, email: `${ownerUserId}@example.test` } })
      await db.tenantMembership.create({
        data: { tenantId, userId: ownerUserId, role: 'MANAGER', joinedAt: new Date() },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'File V1 venue', slug: venueId },
      })

      async function verifiedUpload(
        fileName: string,
        mimeType: 'text/plain' | 'application/pdf',
        bytes: Buffer,
      ) {
        const objectGeneration = randomUUID()
        const storageVersionId = `fixture-version-${randomUUID()}`
        const reserved = await reserveIntakeUploadAction({
          tenantId,
          venueId,
          actor,
          request: {
            requestId: randomUUID(),
            displayName: fileName,
            fileName,
            mimeType,
            category: 'DOCUMENT',
            byteSize: bytes.byteLength,
            sha256: sha256(bytes),
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
        await recordIntakeUploadPrecheckAction({
          tenantId,
          venueId,
          uploadId: reserved.upload.id,
          actor,
          claimId: precheckClaim,
          verified: {
            objectGeneration,
            storageVersionId,
            mimeType,
            byteSize: bytes.byteLength,
            sha256: sha256(bytes),
          },
          evidence: {
            engine: 'fixture-precheck',
            engineVersion: '1',
            verdictHash: sha256(`precheck:${fileName}`),
            computedByteSize: bytes.byteLength,
            computedSha256: sha256(bytes),
          },
        })
        const malwareClaim = randomUUID()
        await claimIntakeUploadVerificationAction({
          tenantId,
          venueId,
          uploadId: reserved.upload.id,
          actor,
          claimId: malwareClaim,
        })
        await settleIntakeUploadAuthoritativeVerificationAction({
          tenantId,
          venueId,
          uploadId: reserved.upload.id,
          actor,
          claimId: malwareClaim,
          malware: {
            verdict: 'CLEAN',
            engine: 'fixture-malware',
            engineVersion: '1',
            verdictHash: sha256(`clean:${fileName}`),
            computedByteSize: bytes.byteLength,
            computedSha256: sha256(bytes),
          },
        })
        return { ...reserved, bytes, storageVersionId }
      }

      const text = await verifiedUpload(
        'visitor-info.txt',
        'text/plain',
        Buffer.from('The east entrance is step-free and opens at 8 AM.', 'utf8'),
      )
      const failedPdf = await verifiedUpload(
        'broken.pdf',
        'application/pdf',
        Buffer.from('%PDF-1.4\nmalformed fixture', 'utf8'),
      )
      const staleText = await verifiedUpload(
        'stale-lease.txt',
        'text/plain',
        Buffer.from('This stale lease must never retain a receipt.', 'utf8'),
      )
      const submission = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: false,
          drafts: {},
          intakeRunIds: [],
          intakeUploadIds: [text.upload.id, failedPdf.upload.id, staleText.upload.id],
        },
      })
      const revision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: { tenantId, venueId, submissionId: submission.submissionId, revision: 1 },
        include: { members: true },
      })
      const dispatches = await db.intakeV1ProcessingDispatch.findMany({
        where: { tenantId, venueId, revisionId: revision.id, kind: 'FILE_EXTRACTION' },
      })
      expect(dispatches).toHaveLength(3)
      const fetches = new Map<string, number>()

      async function process(uploadId: string, bytes: Buffer, recoverThroughFailure = false) {
        const member = revision.members.find((value) => value.intakeUploadId === uploadId)!
        const dispatch = dispatches.find((value) => value.memberId === member.id)!
        const contenders = await Promise.all([
          claimIntakeV1FileExtractionDispatch({
            dispatchId: dispatch.id,
            leaseOwner: 'fixture-worker-a',
          }),
          claimIntakeV1FileExtractionDispatch({
            dispatchId: dispatch.id,
            leaseOwner: 'fixture-worker-b',
          }),
        ])
        expect(contenders.filter(Boolean)).toHaveLength(1)
        const claimed = contenders.find(Boolean)!
        expect(claimed).not.toBeNull()
        const exactLease = {
          id: claimed.id,
          tenantId: claimed.tenantId,
          venueId: claimed.venueId,
          operationId: claimed.operationId,
          leaseToken: claimed.leaseToken,
          sourceHash: claimed.sourceHash,
        }
        await expect(
          preflightIntakeV1FileExtractionDispatch({
            ...exactLease,
            policyVersion: claimed.policyVersion,
          }),
        ).resolves.toMatchObject({ state: 'EXECUTE' })
        const storage = {
          send: vi.fn(async () => {
            fetches.set(uploadId, (fetches.get(uploadId) ?? 0) + 1)
            return {
              Body: (async function* () {
                yield bytes
              })(),
            }
          }),
        }
        const extracted = await executeIntakeFileExtraction({
          db,
          tenantId,
          venueId,
          runId: claimed!.intakeRunId,
          operationId: claimed!.operationId,
          createdBy: ownerUserId,
          storage,
          fileDispatchLease: exactLease,
        })
        if (recoverThroughFailure) {
          await expect(
            failIntakeV1FileExtractionDispatch({
              ...exactLease,
              error: 'fixture lost the receipt acknowledgement',
            }),
          ).resolves.toMatchObject({
            status: extracted.outcome === 'SUCCEEDED' ? 'COMPLETED' : 'HELD',
          })
        } else {
          await expect(
            completeIntakeV1FileExtractionDispatch({
              ...exactLease,
              receiptId: randomUUID(),
            }),
          ).rejects.toMatchObject({ code: 'CONFLICT' })
          await expect(
            completeIntakeV1FileExtractionDispatch({
              ...exactLease,
              receiptId: extracted.receiptId,
            }),
          ).resolves.toMatchObject({
            status: extracted.outcome === 'SUCCEEDED' ? 'COMPLETED' : 'HELD',
          })
        }
        return { claimed: claimed!, extracted, storage, member }
      }

      const successful = await process(text.upload.id, text.bytes)
      const failed = await process(failedPdf.upload.id, failedPdf.bytes, true)
      expect(successful.extracted).toMatchObject({ outcome: 'SUCCEEDED', replayed: false })
      expect(failed.extracted).toMatchObject({ outcome: 'FAILED', replayed: false })
      expect(fetches.get(text.upload.id)).toBe(1)

      const staleMember = revision.members.find(
        (value) => value.intakeUploadId === staleText.upload.id,
      )!
      const staleDispatch = dispatches.find((value) => value.memberId === staleMember.id)!
      const staleClaim = await claimIntakeV1FileExtractionDispatch({
        dispatchId: staleDispatch.id,
        leaseOwner: 'fixture-stale-worker',
      })
      expect(staleClaim).not.toBeNull()
      const activeStaleRow = await db.intakeV1ProcessingDispatch.findUniqueOrThrow({
        where: { id: staleDispatch.id },
      })
      await expect(
        db.intakeV1ProcessingDispatch.update({
          where: { id: staleDispatch.id },
          data: {
            status: 'COMPLETED',
            fileExtractionReceiptId: successful.extracted.receiptId,
            leaseToken: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
          },
        }),
      ).rejects.toThrow()
      expect(
        await db.intakeV1ProcessingDispatch.findUniqueOrThrow({
          where: { id: staleDispatch.id },
        }),
      ).toEqual(activeStaleRow)
      await db.intakeV1ProcessingDispatch.update({
        where: { id: staleDispatch.id },
        data: { leaseExpiresAt: new Date(0) },
      })
      const staleStorage = {
        send: vi.fn(async () => ({
          Body: (async function* () {
            yield staleText.bytes
          })(),
        })),
      }
      await expect(
        executeIntakeFileExtraction({
          db,
          tenantId,
          venueId,
          runId: staleClaim!.intakeRunId,
          operationId: staleClaim!.operationId,
          createdBy: ownerUserId,
          storage: staleStorage,
          fileDispatchLease: {
            id: staleClaim!.id,
            tenantId: staleClaim!.tenantId,
            venueId: staleClaim!.venueId,
            operationId: staleClaim!.operationId,
            leaseToken: staleClaim!.leaseToken,
            sourceHash: staleClaim!.sourceHash,
          },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(
        await db.intakeFileExtractionReceipt.count({
          where: { tenantId, requestId: staleClaim!.operationId },
        }),
      ).toBe(0)
      await expect(
        executeIntakeFileExtraction({
          db,
          tenantId,
          venueId,
          runId: successful.claimed.intakeRunId,
          operationId: successful.claimed.operationId,
          createdBy: ownerUserId,
          storage: successful.storage,
        }),
      ).resolves.toMatchObject({ replayed: true, receiptId: successful.extracted.receiptId })
      expect(fetches.get(text.upload.id)).toBe(1)

      const successfulReceipt = await db.intakeFileExtractionReceipt.findFirstOrThrow({
        where: { id: successful.extracted.receiptId, tenantId, venueId },
      })
      expect(successfulReceipt).toMatchObject({
        sourceStorageVersionId: text.storageVersionId,
        sourceSha256: sha256(text.bytes),
        outcome: 'SUCCEEDED',
      })
      const successfulDispatchBefore = await db.intakeV1ProcessingDispatch.findUniqueOrThrow({
        where: { id: successful.claimed.id },
      })
      await expect(
        db.intakeV1ProcessingDispatch.update({
          where: { id: successful.claimed.id },
          data: { sourceHash: 'f'.repeat(64) },
        }),
      ).rejects.toThrow()
      await expect(
        db.intakeV1ProcessingDispatch.update({
          where: { id: failed.claimed.id },
          data: { fileExtractionReceiptId: successful.extracted.receiptId },
        }),
      ).rejects.toThrow()
      expect(
        await db.intakeV1ProcessingDispatch.findUniqueOrThrow({
          where: { id: successful.claimed.id },
        }),
      ).toEqual(successfulDispatchBefore)
      await expect(
        completeIntakeV1FileExtractionDispatch({
          id: successful.claimed.id,
          tenantId: successful.claimed.tenantId,
          venueId: successful.claimed.venueId,
          operationId: successful.claimed.operationId,
          leaseToken: successful.claimed.leaseToken,
          sourceHash: 'f'.repeat(64),
          receiptId: successful.extracted.receiptId,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      const beforeReview = await buildIntakeV1PackageCandidate({
        db,
        tenantId,
        venueId,
        submissionId: submission.submissionId,
        revision: 1,
        selectedMemberIds: [successful.member.id],
      })
      expect(beforeReview).toMatchObject({ ready: false })
      expect(beforeReview.members[0]).toMatchObject({ state: 'REVIEW_REQUIRED' })
      const review = await reviewIntakeFileExtractionAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        sourceRunId: successful.claimed.intakeRunId,
        receiptId: successful.extracted.receiptId,
        expectedExtractedTextHash: successfulReceipt.extractedTextHash!,
        decision: 'ACCEPTED_FOR_PROPOSAL',
        proposalTitle: 'Reviewed visitor information',
        proposalNotes: 'The east entrance is step-free and opens at 8 AM.',
        rationale: 'The retained fixture text is exact and useful.',
        createdBy: ownerUserId,
      })
      expect(review).toMatchObject({
        proposalCreated: true,
        autoApproved: false,
        autoApplied: false,
      })
      const ready = await buildIntakeV1PackageCandidate({
        db,
        tenantId,
        venueId,
        submissionId: submission.submissionId,
        revision: 1,
        selectedMemberIds: [successful.member.id],
      })
      expect(ready).toMatchObject({
        ready: true,
        published: false,
        autoApprove: false,
        autoApply: false,
      })
      expect(ready.remainingMemberIds).toContain(failed.member.id)
      const operationId = randomUUID()
      const command = {
        tenantId,
        venueId,
        submissionId: submission.submissionId,
        revision: 1,
        operationId,
        selectedMemberIds: [successful.member.id],
        expectedManifestHash: ready.manifestHash,
        expectedCandidateHash: ready.candidateHash!,
        expectedPayloadHash: ready.payloadHash!,
        partialAcknowledged: true,
      }
      const draft = await createIntakeV1PackageDraftForAdmin({ db, actorId: ownerUserId, command })
      const replay = await createIntakeV1PackageDraftForAdmin({ db, actorId: ownerUserId, command })
      expect(draft.value).toMatchObject({ status: 'DRAFT', replayed: false })
      expect(replay.value).toMatchObject({ id: draft.value.id, replayed: true })
      expect(await db.approvalRequest.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.venuePackage.count({ where: { tenantId, venueId } })).toBe(1)
    })
  })
})
