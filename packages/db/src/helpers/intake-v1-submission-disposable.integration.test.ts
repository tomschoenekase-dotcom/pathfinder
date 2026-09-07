import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  claimIntakeUploadVerificationAction,
  createIntakeProposal,
  db,
  recordIntakeUploadPrecheckAction,
  reserveIntakeUploadAction,
  saveIntakeSubmissionDraft,
  settleIntakeUploadAuthoritativeVerificationAction,
  submitIntakeV1Action,
  withTenantIsolationBypass,
} from '../index'

const enabled =
  process.env.RUN_INTAKE_V1_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('intake V1 disposable aggregate', () => {
  afterAll(async () => db.$disconnect())

  it('atomically materializes a selected draft and preserves exact initial replay after amendment', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-v1-${suffix}`
      const venueId = `venue-v1-${suffix}`
      const ownerUserId = `owner-v1-${suffix}`
      await db.tenant.create({ data: { id: tenantId, name: 'V1 fixture', slug: tenantId } })
      await db.user.create({
        data: { id: ownerUserId, email: `${ownerUserId}@example.test`, fullName: 'V1 owner' },
      })
      await db.tenantMembership.create({
        data: { tenantId, userId: ownerUserId, role: 'MANAGER', joinedAt: new Date() },
      })
      await db.venue.create({ data: { id: venueId, tenantId, name: 'V1 venue', slug: venueId } })
      await db.intakeSubmissionDraft.create({
        data: {
          tenantId,
          venueId,
          ownerUserId,
          sourceKind: 'NOTES',
          content: { kind: 'NOTES', notes: 'Canonical private review note.' },
        },
      })
      const operationId = randomUUID()
      const selection = {
        operationId,
        partialAcknowledged: false,
        drafts: { NOTES: { include: true, expectedRevision: 1 } },
        intakeRunIds: [],
        intakeUploadIds: [],
      }
      const initial = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        selection,
      })
      expect(initial).toMatchObject({
        revision: 1,
        replayed: false,
        status: 'AWAITING_CANONICAL_REVIEW',
      })
      const member = await db.intakeV1SubmissionMember.findFirstOrThrow({
        where: {
          revisionId: {
            in: (
              await db.intakeV1SubmissionRevision.findMany({
                where: { submissionId: initial.submissionId },
                select: { id: true },
              })
            ).map((revision) => revision.id),
          },
        },
        select: { intakeRunId: true },
      })
      const amended = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: false,
          drafts: {},
          intakeRunIds: member.intakeRunId ? [member.intakeRunId] : [],
          intakeUploadIds: [],
        },
        amend: { submissionId: initial.submissionId, expectedCurrentRevision: 1 },
      })
      expect(amended.revision).toBe(2)
      const replay = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        selection,
      })
      expect(replay).toMatchObject({
        submissionId: initial.submissionId,
        revision: 1,
        replayed: true,
        manifestHash: initial.manifestHash,
      })
      await expect(
        submitIntakeV1Action({
          tenantId,
          venueId,
          ownerUserId,
          actorRole: 'MANAGER',
          selection: {
            ...selection,
            operationId: randomUUID(),
            partialAcknowledged: true,
            drafts: { NOTES: { include: true, expectedRevision: 1 } },
          },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      await db.intakeSubmissionDraft.create({
        data: {
          tenantId,
          venueId,
          ownerUserId,
          sourceKind: 'WEBSITE',
          content: {
            kind: 'WEBSITE',
            displayName: 'Fixture site',
            websiteUri: 'https://fixture.example.test',
          },
        },
      })
      const concurrentSelection = {
        operationId: randomUUID(),
        partialAcknowledged: false,
        drafts: { WEBSITE: { include: true, expectedRevision: 1 } },
        intakeRunIds: [],
        intakeUploadIds: [],
      }
      const concurrent = await Promise.all([
        submitIntakeV1Action({
          tenantId,
          venueId,
          ownerUserId,
          actorRole: 'MANAGER',
          selection: concurrentSelection,
        }),
        submitIntakeV1Action({
          tenantId,
          venueId,
          ownerUserId,
          actorRole: 'MANAGER',
          selection: concurrentSelection,
        }),
      ])
      expect(new Set(concurrent.map((result) => result.submissionId)).size).toBe(1)
      expect(concurrent.filter((result) => !result.replayed)).toHaveLength(1)

      const amendInputs = [randomUUID(), randomUUID()].map((operationId) => ({
        operationId,
        partialAcknowledged: false,
        drafts: {},
        intakeRunIds: [member.intakeRunId!],
        intakeUploadIds: [],
      }))
      const amendRace = await Promise.allSettled(
        amendInputs.map((raceSelection) =>
          submitIntakeV1Action({
            tenantId,
            venueId,
            ownerUserId,
            actorRole: 'MANAGER',
            selection: raceSelection,
            amend: { submissionId: initial.submissionId, expectedCurrentRevision: 2 },
          }),
        ),
      )
      expect(amendRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(amendRace.filter((result) => result.status === 'rejected')).toHaveLength(1)

      const reopened = await saveIntakeSubmissionDraft({
        tenantId,
        venueId,
        ownerUserId,
        sourceKind: 'WEBSITE',
        expectedRevision: 0,
        content: { kind: 'WEBSITE', displayName: '', websiteUri: '' },
      })
      const partial = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: true,
          drafts: { WEBSITE: { include: true, expectedRevision: reopened.revision } },
          intakeRunIds: [member.intakeRunId!],
          intakeUploadIds: [],
        },
      })
      expect(partial.criticalMissing).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DRAFT_INCOMPLETE', sourceKind: 'WEBSITE' }),
        ]),
      )
      expect(
        (
          await db.intakeSubmissionDraft.findUniqueOrThrow({
            where: {
              tenantId_venueId_ownerUserId_sourceKind: {
                tenantId,
                venueId,
                ownerUserId,
                sourceKind: 'WEBSITE',
              },
            },
            select: { submittedAt: true },
          })
        ).submittedAt,
      ).toBeNull()

      const outsiderId = `outsider-v1-${suffix}`
      await db.user.create({
        data: { id: outsiderId, email: `${outsiderId}@example.test`, fullName: 'V1 outsider' },
      })
      await db.tenantMembership.create({
        data: { tenantId, userId: outsiderId, role: 'MANAGER', joinedAt: new Date() },
      })
      await expect(
        submitIntakeV1Action({
          tenantId,
          venueId,
          ownerUserId: outsiderId,
          actorRole: 'MANAGER',
          selection: {
            operationId: randomUUID(),
            partialAcknowledged: false,
            drafts: {},
            intakeRunIds: [member.intakeRunId!],
            intakeUploadIds: [],
          },
          amend: { submissionId: initial.submissionId, expectedCurrentRevision: 3 },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        submitIntakeV1Action({
          tenantId: `other-${tenantId}`,
          venueId,
          ownerUserId,
          actorRole: 'MANAGER',
          selection: {
            operationId: randomUUID(),
            partialAcknowledged: false,
            drafts: {},
            intakeRunIds: [member.intakeRunId!],
            intakeUploadIds: [],
          },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      const outsiderRun = await createIntakeProposal({
        db,
        tenantId,
        venueId,
        actor: { type: 'HUMAN', id: outsiderId, role: 'MANAGER' },
        requestId: randomUUID(),
        proposal: {
          kind: 'WEBSITE',
          displayName: 'Other owner source',
          websiteUri: 'https://other-owner.example.test',
        },
      })
      await expect(
        submitIntakeV1Action({
          tenantId,
          venueId,
          ownerUserId,
          actorRole: 'MANAGER',
          selection: {
            operationId: randomUUID(),
            partialAcknowledged: false,
            drafts: {},
            intakeRunIds: [outsiderRun.id],
            intakeUploadIds: [],
          },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      const uploadActor = { type: 'HUMAN' as const, id: ownerUserId, role: 'MANAGER' as const }
      const uploadBytes = Buffer.from('V1 canonical upload source', 'utf8')
      const uploadSha256 = createHash('sha256').update(uploadBytes).digest('hex')
      const objectGeneration = randomUUID()
      const storageVersionId = `v1-storage-${suffix}`
      const reserved = await reserveIntakeUploadAction({
        tenantId,
        venueId,
        actor: uploadActor,
        request: {
          requestId: randomUUID(),
          displayName: 'V1 verified upload',
          fileName: 'v1-source.txt',
          mimeType: 'text/plain',
          category: 'DOCUMENT',
          byteSize: uploadBytes.byteLength,
          sha256: uploadSha256,
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
        actor: uploadActor,
        claimId: precheckClaim,
      })
      await expect(
        recordIntakeUploadPrecheckAction({
          tenantId,
          venueId,
          uploadId: reserved.upload.id,
          actor: uploadActor,
          claimId: precheckClaim,
          verified: {
            objectGeneration: randomUUID(),
            storageVersionId,
            mimeType: 'text/plain',
            byteSize: uploadBytes.byteLength,
            sha256: uploadSha256,
          },
          evidence: {
            engine: 'v1-fixture-precheck',
            engineVersion: '1',
            verdictHash: createHash('sha256').update('stale-generation').digest('hex'),
            computedByteSize: uploadBytes.byteLength,
            computedSha256: uploadSha256,
          },
        }),
      ).rejects.toMatchObject({ code: 'VERIFICATION_MISMATCH' })
      await expect(
        recordIntakeUploadPrecheckAction({
          tenantId,
          venueId,
          uploadId: reserved.upload.id,
          actor: uploadActor,
          claimId: precheckClaim,
          verified: {
            objectGeneration,
            storageVersionId,
            mimeType: 'text/plain',
            byteSize: uploadBytes.byteLength,
            sha256: 'a'.repeat(64),
          },
          evidence: {
            engine: 'v1-fixture-precheck',
            engineVersion: '1',
            verdictHash: createHash('sha256').update('stale-sha').digest('hex'),
            computedByteSize: uploadBytes.byteLength,
            computedSha256: 'a'.repeat(64),
          },
        }),
      ).rejects.toMatchObject({ code: 'VERIFICATION_MISMATCH' })
      await recordIntakeUploadPrecheckAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor: uploadActor,
        claimId: precheckClaim,
        verified: {
          objectGeneration,
          storageVersionId,
          mimeType: 'text/plain',
          byteSize: uploadBytes.byteLength,
          sha256: uploadSha256,
        },
        evidence: {
          engine: 'v1-fixture-precheck',
          engineVersion: '1',
          verdictHash: createHash('sha256').update('v1-precheck-passed').digest('hex'),
          computedByteSize: uploadBytes.byteLength,
          computedSha256: uploadSha256,
        },
      })
      const malwareClaim = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor: uploadActor,
        claimId: malwareClaim,
      })
      await settleIntakeUploadAuthoritativeVerificationAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor: uploadActor,
        claimId: malwareClaim,
        malware: {
          verdict: 'CLEAN',
          engine: 'v1-fixture-malware',
          engineVersion: '1',
          verdictHash: createHash('sha256').update('v1-malware-clean').digest('hex'),
          computedByteSize: uploadBytes.byteLength,
          computedSha256: uploadSha256,
        },
      })
      const verifiedUpload = await db.intakeUpload.findUniqueOrThrow({
        where: { id: reserved.upload.id },
        select: { intakeRunId: true },
      })
      expect(verifiedUpload.intakeRunId).toBeTruthy()
      const uploadSubmission = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: false,
          drafts: {},
          intakeRunIds: [],
          intakeUploadIds: [reserved.upload.id],
        },
      })
      const uploadRevision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: { submissionId: uploadSubmission.submissionId, revision: 1 },
        include: { members: true },
      })
      expect(uploadRevision.members).toEqual([
        expect.objectContaining({ kind: 'INTAKE_UPLOAD', intakeUploadId: reserved.upload.id }),
      ])
      await expect(
        submitIntakeV1Action({
          tenantId,
          venueId,
          ownerUserId,
          actorRole: 'MANAGER',
          selection: {
            operationId: randomUUID(),
            partialAcknowledged: true,
            drafts: {},
            intakeRunIds: [verifiedUpload.intakeRunId!],
            intakeUploadIds: [reserved.upload.id],
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

      const revision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: { submissionId: initial.submissionId },
        select: { id: true },
      })
      const v1Member = await db.intakeV1SubmissionMember.findFirstOrThrow({
        where: { revisionId: revision.id },
        select: { id: true },
      })
      await expect(
        db.intakeV1SubmissionRevision.update({
          where: { id: revision.id },
          data: { manifestHash: 'a'.repeat(64) },
        }),
      ).rejects.toThrow()
      await expect(
        db.intakeV1SubmissionMember.delete({ where: { id: v1Member.id } }),
      ).rejects.toThrow()

      const rollbackDraft = await saveIntakeSubmissionDraft({
        tenantId,
        venueId,
        ownerUserId,
        sourceKind: 'WEBSITE',
        expectedRevision: reopened.revision,
        content: {
          kind: 'WEBSITE',
          displayName: 'Rollback site',
          websiteUri: 'https://rollback.example.test',
        },
      })
      const beforeRuns = await db.intakeRun.count({
        where: { tenantId, venueId, sourceKind: 'WEBSITE' },
      })
      const beforeEvidence = await db.intakeEvidenceRecord.count({ where: { tenantId, venueId } })
      const injectedClient = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== '$transaction') return Reflect.get(target, property, receiver)
          return async (callback: (transaction: typeof db) => Promise<unknown>) => {
            return target.$transaction(async (realTransaction) =>
              callback(
                new Proxy(realTransaction as typeof db, {
                  get(transactionTarget, transactionProperty, transactionReceiver) {
                    if (transactionProperty !== 'intakeV1Submission')
                      return Reflect.get(
                        transactionTarget,
                        transactionProperty,
                        transactionReceiver,
                      )
                    return new Proxy(transactionTarget.intakeV1Submission, {
                      get(delegate, delegateProperty, delegateReceiver) {
                        if (delegateProperty === 'create')
                          return async () => {
                            throw new Error('deliberate aggregate persistence failure')
                          }
                        return Reflect.get(delegate, delegateProperty, delegateReceiver)
                      },
                    })
                  },
                }),
              ),
            )
          }
        },
      })
      await expect(
        submitIntakeV1Action({
          client: injectedClient,
          tenantId,
          venueId,
          ownerUserId,
          actorRole: 'MANAGER',
          selection: {
            operationId: randomUUID(),
            partialAcknowledged: false,
            drafts: { WEBSITE: { include: true, expectedRevision: rollbackDraft.revision } },
            intakeRunIds: [],
            intakeUploadIds: [],
          },
        }),
      ).rejects.toThrow('deliberate aggregate persistence failure')
      expect(
        await db.intakeRun.count({ where: { tenantId, venueId, sourceKind: 'WEBSITE' } }),
      ).toBe(beforeRuns)
      expect(await db.intakeEvidenceRecord.count({ where: { tenantId, venueId } })).toBe(
        beforeEvidence,
      )
      expect(
        await db.intakeSubmissionDraft.findUniqueOrThrow({
          where: {
            tenantId_venueId_ownerUserId_sourceKind: {
              tenantId,
              venueId,
              ownerUserId,
              sourceKind: 'WEBSITE',
            },
          },
          select: { submittedAt: true, revision: true },
        }),
      ).toMatchObject({ submittedAt: null, revision: rollbackDraft.revision })
    })
  })
})
