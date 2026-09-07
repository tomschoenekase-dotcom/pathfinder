import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  claimIntakeUploadVerificationAction,
  claimIntakeV1WebsiteResearchDispatch,
  createIntakeProposal,
  db,
  recordIntakeUploadPrecheckAction,
  recordWebsiteResearchReceiptAction,
  reserveIntakeUploadAction,
  assertIntakeV1WebsiteResearchDispatchActive,
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
      const websiteRevision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: { submissionId: concurrent[0]!.submissionId, revision: 1 },
      })
      const websiteDispatch = await db.intakeV1ProcessingDispatch.findFirstOrThrow({
        where: { revisionId: websiteRevision.id },
      })
      expect(websiteDispatch).toMatchObject({
        kind: 'WEBSITE_RESEARCH',
        status: 'PENDING',
        attempts: 0,
      })
      const carriedWebsite = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: false,
          drafts: {},
          intakeRunIds: [websiteDispatch.intakeRunId],
          intakeUploadIds: [],
        },
      })
      const carriedRevision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: { submissionId: carriedWebsite.submissionId, revision: 1 },
      })
      const carriedDispatch = await db.intakeV1ProcessingDispatch.findFirstOrThrow({
        where: { revisionId: carriedRevision.id },
      })
      const independentWebsite = await createIntakeProposal({
        db,
        tenantId,
        venueId,
        actor: { type: 'HUMAN', id: ownerUserId, role: 'MANAGER' },
        requestId: randomUUID(),
        proposal: {
          kind: 'WEBSITE',
          displayName: 'Independent site',
          websiteUri: 'https://independent.example.test',
        },
      })
      const independentSubmission = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: false,
          drafts: {},
          intakeRunIds: [independentWebsite.id],
          intakeUploadIds: [],
        },
      })
      const independentRevision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: { submissionId: independentSubmission.submissionId, revision: 1 },
      })
      const independentDispatch = await db.intakeV1ProcessingDispatch.findFirstOrThrow({
        where: { revisionId: independentRevision.id },
      })
      const competingClaims = await Promise.all([
        claimIntakeV1WebsiteResearchDispatch({
          dispatchId: websiteDispatch.id,
          leaseOwner: 'v1-disposable-worker-a',
        }),
        claimIntakeV1WebsiteResearchDispatch({
          dispatchId: carriedDispatch.id,
          leaseOwner: 'v1-disposable-worker-b',
        }),
        claimIntakeV1WebsiteResearchDispatch({
          dispatchId: independentDispatch.id,
          leaseOwner: 'v1-disposable-worker-c',
        }),
      ])
      expect(competingClaims.filter(Boolean)).toHaveLength(2)
      expect(competingClaims[2]).toMatchObject({ intakeRunId: independentWebsite.id })
      const claimedWebsite = competingClaims.slice(0, 2).find(Boolean)!
      expect(claimedWebsite).toMatchObject({ attempts: 1 })
      const claimedDispatchId = claimedWebsite.id
      const exactWebsite = {
        id: claimedWebsite!.id,
        tenantId: claimedWebsite!.tenantId,
        venueId: claimedWebsite!.venueId,
        operationId: claimedWebsite!.operationId,
        leaseToken: claimedWebsite!.leaseToken,
        sourceHash: claimedWebsite!.sourceHash,
        policyVersion: claimedWebsite!.policyVersion,
      }
      await expect(
        assertIntakeV1WebsiteResearchDispatchActive({
          ...exactWebsite,
          sourceHash: 'f'.repeat(64),
        }),
      ).resolves.toBeNull()
      await expect(
        assertIntakeV1WebsiteResearchDispatchActive(exactWebsite),
      ).resolves.toMatchObject({ id: claimedDispatchId })
      await db.intakeV1ProcessingDispatch.update({
        where: { id: claimedDispatchId },
        data: { attempts: 2, leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') },
      })
      const recoveredWebsite = await claimIntakeV1WebsiteResearchDispatch({
        dispatchId: claimedDispatchId,
        leaseOwner: 'v1-recovery-worker',
      })
      expect(recoveredWebsite).toMatchObject({ attempts: 3 })
      await expect(
        db.$executeRaw`UPDATE intake_runs SET website_uri='https://changed-after-lease.example.test' WHERE id=${recoveredWebsite!.intakeRunId}`,
      ).rejects.toThrow(/append.only/iu)
      await recordWebsiteResearchReceiptAction({
        operationId: recoveredWebsite!.operationId,
        tenantId,
        venueId,
        runId: recoveredWebsite!.intakeRunId,
        requestHash: createHash('sha256').update('crash-after-receipt').digest('hex'),
        sourceUriHash: createHash('sha256').update('https://fixture.example.test').digest('hex'),
        bounds: {
          maxPages: 5,
          maxDepth: 1,
          maxBytesPerPage: 1_000_000,
          allowedHosts: ['fixture.example.test'],
          respectRobots: true,
          publishMode: 'DRAFT_ONLY',
        },
        outcome: 'SUCCEEDED',
        researchSnapshot: {
          schemaVersion: 1,
          sourceId: recoveredWebsite!.intakeRunId,
          pages: [],
          citations: [],
          evidence: [],
          discrepancies: [],
        },
        candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
        evidence: [],
        discrepancies: [],
        attemptedFetches: 1,
        fetchedPages: 1,
        fetchedBytes: 100,
        estimatedCostUnits: 0,
        latencyMs: 1,
        createdBy: ownerUserId,
      })
      await db.intakeV1ProcessingDispatch.update({
        where: { id: claimedDispatchId },
        data: { leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') },
      })
      await expect(
        claimIntakeV1WebsiteResearchDispatch({
          dispatchId: claimedDispatchId,
          leaseOwner: 'v1-exhausted-worker',
        }),
      ).resolves.toBeNull()
      await expect(
        db.intakeV1ProcessingDispatch.findUniqueOrThrow({ where: { id: claimedDispatchId } }),
      ).resolves.toMatchObject({
        status: 'COMPLETED',
        receiptId: recoveredWebsite!.operationId,
        attempts: 3,
      })

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

      const researchedWebsite = await createIntakeProposal({
        db,
        tenantId,
        venueId,
        actor: { type: 'HUMAN', id: ownerUserId, role: 'MANAGER' },
        requestId: randomUUID(),
        proposal: {
          kind: 'WEBSITE',
          displayName: 'Already researched',
          websiteUri: 'https://researched.example.test',
        },
      })
      const inheritedReceiptId = randomUUID()
      await recordWebsiteResearchReceiptAction({
        operationId: inheritedReceiptId,
        tenantId,
        venueId,
        runId: researchedWebsite.id,
        requestHash: createHash('sha256').update('inherited-request').digest('hex'),
        sourceUriHash: createHash('sha256').update('https://researched.example.test').digest('hex'),
        bounds: {
          maxPages: 5,
          maxDepth: 1,
          maxBytesPerPage: 1_000_000,
          allowedHosts: ['researched.example.test'],
          respectRobots: true,
          publishMode: 'DRAFT_ONLY',
        },
        outcome: 'SUCCEEDED',
        researchSnapshot: {
          schemaVersion: 1,
          sourceId: researchedWebsite.id,
          pages: [],
          citations: [],
          evidence: [],
          discrepancies: [],
        },
        candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
        evidence: [],
        discrepancies: [],
        attemptedFetches: 1,
        fetchedPages: 1,
        fetchedBytes: 100,
        estimatedCostUnits: 0,
        latencyMs: 1,
        createdBy: ownerUserId,
      })
      const inheritedSubmission = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: false,
          drafts: {},
          intakeRunIds: [researchedWebsite.id],
          intakeUploadIds: [],
        },
      })
      const inheritedRevision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: { submissionId: inheritedSubmission.submissionId, revision: 1 },
      })
      await expect(
        db.intakeV1ProcessingDispatch.findFirstOrThrow({
          where: { revisionId: inheritedRevision.id },
        }),
      ).resolves.toMatchObject({ status: 'COMPLETED', receiptId: inheritedReceiptId, attempts: 0 })

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
      const beforeProcessing = await db.intakeV1ProcessingDispatch.count({
        where: { tenantId, venueId },
      })
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
      expect(await db.intakeV1ProcessingDispatch.count({ where: { tenantId, venueId } })).toBe(
        beforeProcessing,
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
