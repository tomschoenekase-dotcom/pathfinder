import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  createIntakeProposal,
  db,
  recordWebsiteResearchReceiptAction,
  reviewIntakeSourceForV1,
  submitIntakeV1Action,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { buildIntakeV1PackageCandidate } from './lib/intake-v1-package-candidate'
import {
  reviewIntakeSourceMappingForV1,
  type IntakeSourceMappingReviewDependencies,
} from './lib/intake-source-mapping-review'
import { buildWebsiteClarificationReview } from './lib/intake-website-clarifications'

const enabled =
  process.env.RUN_INTAKE_SOURCE_MAPPING_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_intake_source_mapping_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('intake source mapping disposable review journey', () => {
  afterAll(async () => db.$disconnect())

  it('retains website and verbatim notes reviews as replayable V1 proposal sources', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-source-map-${suffix}`
      const otherTenantId = `tenant-source-map-other-${suffix}`
      const venueId = `venue-source-map-${suffix}`
      const otherVenueId = `venue-source-map-other-${suffix}`
      const ownerUserId = `owner-source-map-${suffix}`
      const reviewerId = `reviewer-source-map-${suffix}`
      const actor = { type: 'HUMAN' as const, id: ownerUserId, role: 'MANAGER' as const }

      await db.tenant.create({ data: { id: tenantId, name: 'Source mapping', slug: tenantId } })
      await db.tenant.create({
        data: { id: otherTenantId, name: 'Other source mapping', slug: otherTenantId },
      })
      await db.user.create({
        data: { id: ownerUserId, email: `${ownerUserId}@example.test`, fullName: 'Source owner' },
      })
      await db.tenantMembership.create({
        data: { tenantId, userId: ownerUserId, role: 'MANAGER', joinedAt: new Date() },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Source mapping venue', slug: venueId },
      })
      await db.venue.create({
        data: {
          id: otherVenueId,
          tenantId: otherTenantId,
          name: 'Other source venue',
          slug: otherVenueId,
        },
      })

      const website = await createIntakeProposal({
        db,
        tenantId,
        venueId,
        actor,
        requestId: randomUUID(),
        proposal: {
          kind: 'WEBSITE',
          displayName: 'Mapping fixture website',
          websiteUri: 'https://mapping.example.test',
        },
      })
      const receiptId = randomUUID()
      const researchSnapshot = {
        schemaVersion: 1 as const,
        sourceId: website.id,
        pages: [],
        citations: [
          {
            evidenceId: 'phone-a',
            fieldPath: 'venue.phone',
            value: '312-555-0100',
            sourceUrl: 'https://mapping.example.test/contact',
            locator: 'json-ld',
            confidence: 0.95,
            dateSensitive: false,
            effectiveDate: null,
          },
        ],
        evidence: [],
        discrepancies: [],
      }
      const candidateSnapshot = { kind: 'TYPED_INTERMEDIATE' as const, draftInput: null }
      await recordWebsiteResearchReceiptAction({
        operationId: receiptId,
        tenantId,
        venueId,
        runId: website.id,
        requestHash: createHash('sha256').update('source mapping website receipt').digest('hex'),
        sourceUriHash: createHash('sha256').update('https://mapping.example.test').digest('hex'),
        bounds: {
          maxPages: 5,
          maxDepth: 1,
          maxBytesPerPage: 1_000_000,
          allowedHosts: ['mapping.example.test'],
          respectRobots: true,
          publishMode: 'DRAFT_ONLY',
        },
        outcome: 'SUCCEEDED',
        researchSnapshot,
        candidateSnapshot,
        evidence: [],
        discrepancies: [],
        attemptedFetches: 1,
        fetchedPages: 1,
        fetchedBytes: 100,
        estimatedCostUnits: 0,
        latencyMs: 1,
        createdBy: ownerUserId,
      })
      const researchHash = buildWebsiteClarificationReview({
        tenantId,
        venueId,
        runId: website.id,
        receiptId,
        researchSnapshot,
        candidateSnapshot,
      }).researchHash
      const websiteOperationId = randomUUID()
      const websiteCommand = {
        tenantId,
        venueId,
        operationId: websiteOperationId,
        sourceRunId: website.id,
        expectedSourceInputHash: website.submissionInputHash!,
        reviewedBy: reviewerId,
        rationale: 'The retained phone citation is approved for a review-only proposal.',
        kind: 'WEBSITE_MAPPING' as const,
        receiptId,
        expectedResearchHash: researchHash,
        selections: [{ fieldPath: 'venue.phone', evidenceId: 'phone-a' }],
      }
      const websiteReview = await reviewIntakeSourceMappingForV1({ db, command: websiteCommand })
      expect(websiteReview).toMatchObject({
        kind: 'WEBSITE_MAPPING',
        replayed: false,
        autoApprove: false,
        autoApply: false,
        published: false,
      })
      await expect(
        reviewIntakeSourceMappingForV1({
          db,
          command: { ...websiteCommand, receiptId: randomUUID() },
        }),
      ).rejects.toBeTruthy()

      const notesText = 'Private preface. 🙂 Step-free east entrance. Internal follow-up.'
      const notes = await createIntakeProposal({
        db,
        tenantId,
        venueId,
        actor,
        requestId: randomUUID(),
        proposal: { kind: 'NOTES', notes: notesText },
      })
      const characters = Array.from(notesText)
      const selectedText = '🙂 Step-free east entrance.'
      const start = characters.join('').indexOf(selectedText)
      const codePointStart = Array.from(characters.join('').slice(0, start)).length
      const codePointEnd = codePointStart + Array.from(selectedText).length
      const notesOperationId = randomUUID()
      const notesCommand = {
        tenantId,
        venueId,
        operationId: notesOperationId,
        sourceRunId: notes.id,
        expectedSourceInputHash: notes.submissionInputHash!,
        reviewedBy: reviewerId,
        rationale: 'The exact retained accessibility sentence is approved for proposal review.',
        kind: 'OPTIONAL_NOTES_SELECTION' as const,
        consentToPublicUse: true as const,
        ranges: [{ start: codePointStart, end: codePointEnd }],
        title: 'Accessible entrance',
        category: 'ACCESSIBILITY',
      }
      const notesReview = await reviewIntakeSourceMappingForV1({ db, command: notesCommand })
      const notesReplay = await reviewIntakeSourceMappingForV1({ db, command: notesCommand })
      expect(notesReplay).toMatchObject({
        reviewId: notesReview.reviewId,
        proposalRunId: notesReview.proposalRunId,
        replayed: true,
      })
      const storedNotesReview = await db.intakeSourceMappingReview.findFirstOrThrow({
        where: { id: notesOperationId, tenantId, venueId },
      })
      expect(storedNotesReview.payload).toMatchObject({
        knowledgeEntries: { create: [{ value: { content: selectedText } }] },
      })

      await expect(
        db.$executeRaw`
          UPDATE intake_runs SET display_name='changed source'
           WHERE id=${notes.id} AND tenant_id=${tenantId} AND venue_id=${venueId}
        `,
      ).rejects.toThrow(/append.only/iu)
      await expect(
        reviewIntakeSourceMappingForV1({ db, command: notesCommand }),
      ).resolves.toMatchObject({
        replayed: true,
      })
      await expect(
        reviewIntakeSourceMappingForV1({
          db,
          command: {
            ...notesCommand,
            operationId: randomUUID(),
            expectedSourceInputHash: 'f'.repeat(64),
          },
        }),
      ).rejects.toBeTruthy()
      await expect(
        reviewIntakeSourceMappingForV1({
          db,
          command: {
            ...notesCommand,
            tenantId: otherTenantId,
            venueId: otherVenueId,
            operationId: randomUUID(),
          },
        }),
      ).rejects.toBeTruthy()

      const failedOperationId = randomUUID()
      let proposalCreateReached = false
      type ReviewTransaction = Parameters<Parameters<typeof db.$transaction>[0]>[0]
      const failingReviewClient = {
        $transaction: <Result>(
          callback: (tx: ReviewTransaction) => Promise<Result>,
        ): Promise<Result> =>
          db.$transaction(async (tx) => {
            const failingTx = new Proxy(tx, {
              get(target, property, receiver) {
                if (property === 'intakeRun') {
                  return new Proxy(target.intakeRun, {
                    get(delegate, delegateProperty, delegateReceiver) {
                      if (delegateProperty === 'create') {
                        return (...args: unknown[]) => {
                          proposalCreateReached = true
                          return Reflect.apply(
                            Reflect.get(delegate, delegateProperty, delegateReceiver),
                            delegate,
                            args,
                          )
                        }
                      }
                      return Reflect.get(delegate, delegateProperty, delegateReceiver)
                    },
                  })
                }
                if (property !== 'intakeSourceMappingReview')
                  return Reflect.get(target, property, receiver)
                return new Proxy(target.intakeSourceMappingReview, {
                  get(delegate, delegateProperty, delegateReceiver) {
                    if (delegateProperty === 'create') {
                      return async () => {
                        throw new Error('fixture source mapping review write failure')
                      }
                    }
                    return Reflect.get(delegate, delegateProperty, delegateReceiver)
                  },
                })
              },
            }) as ReviewTransaction
            return callback(failingTx)
          }),
      } as Pick<typeof db, '$transaction'>
      const failingDependencies: IntakeSourceMappingReviewDependencies = {
        review(input, projector) {
          return reviewIntakeSourceForV1(input, projector, failingReviewClient)
        },
        async buildWebsiteMapping() {
          throw new Error('Website mapping should not run for optional notes.')
        },
      }
      await expect(
        reviewIntakeSourceMappingForV1(
          {
            db,
            command: { ...notesCommand, operationId: failedOperationId },
          },
          failingDependencies,
        ),
      ).rejects.toThrow('fixture source mapping review write failure')
      expect(proposalCreateReached).toBe(true)
      expect(
        await db.intakeRun.count({
          where: { tenantId, venueId, submissionRequestId: failedOperationId },
        }),
      ).toBe(0)
      expect(
        await db.intakeSourceMappingReview.count({
          where: { tenantId, venueId, id: failedOperationId },
        }),
      ).toBe(0)

      const submission = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: false,
          drafts: {},
          intakeRunIds: [websiteReview.proposalRunId, notesReview.proposalRunId],
          intakeUploadIds: [],
        },
      })
      const revision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: { submissionId: submission.submissionId, revision: 1, tenantId, venueId },
        include: { members: { orderBy: { ordinal: 'asc' } } },
      })
      const aggregate = await buildIntakeV1PackageCandidate({
        db,
        tenantId,
        venueId,
        submissionId: submission.submissionId,
        revision: 1,
        selectedMemberIds: revision.members.map(({ id }) => id),
      })
      expect(aggregate).toMatchObject({
        ready: true,
        remainingMemberIds: [],
        autoApprove: false,
        autoApply: false,
        published: false,
      })
      expect(aggregate.payload?.knowledgeEntries.create).toHaveLength(2)

      await expect(
        db.$executeRaw`UPDATE intake_source_mapping_reviews SET rationale='changed' WHERE id=${notesOperationId}::uuid`,
      ).rejects.toThrow(/append.only/iu)
    })
  })
})
