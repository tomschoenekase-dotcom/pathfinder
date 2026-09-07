import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { createMediaTemporalReviewReceipt } from './media-temporal-review-service'
import { createMediaTemporalOperationalHandoff } from './media-temporal-operational-service'
import { mediaIntakeHash } from './media-intake-snapshot'

const enabled =
  process.env.RUN_MEDIA_TEMPORAL_REVIEW_SERVICE_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_media_temporal_[a-z0-9]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('media temporal review service on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())
  it('retains an all-held review without creating a Builder run or publication', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `temporal-service-${suffix}`
      const venueId = `temporal-service-venue-${suffix}`
      const projectId = `temporal-service-project-${suffix}`
      const sourceGeneration = randomUUID()
      const uploadAttemptId = randomUUID()
      const sourceSha = 'a'.repeat(64)
      const item = {
        title: 'Temporary entrance hours',
        category: 'ARRIVAL',
        content: 'The north entrance is open until six.',
        isEnabled: true,
      }
      const observation = {
        kind: 'visible_text' as const,
        statement: 'North entrance open until six',
        evidenceChannel: 'document_text' as const,
        directness: 'observed' as const,
        confidence: 'confirmed' as const,
        processingMethod: 'text_extraction' as const,
        locator: { type: 'whole_source' as const },
      }
      const finding = {
        sourceId: 'schedule-1',
        filename: 'schedule.pdf',
        mediaType: 'DOCUMENT' as const,
        summary: 'Temporary entrance schedule.',
        uncertainties: [],
        sourceObservations: [observation],
        review: {
          summary: 'Temporary entrance schedule.',
          uncertainties: [],
          note: 'Reviewed.',
          reviewedBy: 'reviewer',
          reviewedAt: new Date().toISOString(),
        },
      }
      await db.tenant.create({ data: { id: tenantId, slug: tenantId, name: 'Temporal tenant' } })
      await db.venue.create({
        data: { id: venueId, tenantId, slug: venueId, name: 'Temporal venue' },
      })
      const project = await db.mediaIngestionProject.create({
        data: {
          id: projectId,
          tenantId,
          venueId,
          name: 'Temporal review',
          createdBy: 'reviewer',
          status: 'READY_FOR_REVIEW',
          stage: 'review',
          sourceObjectGeneration: sourceGeneration,
          uploadAttemptId,
          sourceObjectKey: `fixture/${projectId}.zip`,
          draftJson: { schemaVersion: 1, places: [], knowledgeEntries: [item] },
          findings: [finding],
          assets: {
            create: {
              tenantId,
              sourceId: finding.sourceId,
              filename: finding.filename,
              mediaType: finding.mediaType,
              objectKey: `fixture/${projectId}.zip#${finding.filename}`,
              bytes: 32n,
              sha256: sourceSha,
              status: 'COMPLETE',
              analysis: finding,
            },
          },
        },
      })
      const value = 'Open until six today.'
      const claim = {
        claimId: 'temporary-hours',
        targetKey: 'north-entrance:hours',
        targetItemHash: mediaIntakeHash(item),
        claimType: 'TEMPORARY_SCHEDULE' as const,
        value,
        valueHash: createHash('sha256').update(value).digest('hex'),
        authority: 'AUTHORIZED_STAFF' as const,
        consequential: true,
        effectiveFrom: '2026-09-07T00:00:00.000Z',
        effectiveUntil: '2026-09-08T00:00:00.000Z',
        source: {
          sourceId: finding.sourceId,
          sourceSha256: sourceSha,
          sourceVersion: uploadAttemptId,
          capturedAt: null,
          observationIndex: 0,
          observationSha256: mediaIntakeHash(observation),
        },
      }
      const input = {
        tenantId,
        venueId,
        projectId,
        sourceGeneration,
        requestId: randomUUID(),
        expectedUpdatedAt: project.updatedAt.toISOString(),
        rationale: 'Retain this finite reviewed schedule without publishing it.',
        claims: [claim],
        bindings: [
          {
            kind: 'knowledge' as const,
            itemIndex: 0,
            itemHash: mediaIntakeHash(item),
            sourceIds: [finding.sourceId],
          },
        ],
      }
      await expect(
        createMediaTemporalReviewReceipt({
          client: db,
          actorId: 'reviewer',
          input: {
            ...input,
            requestId: randomUUID(),
            claims: [{ ...claim, source: { ...claim.source, observationSha256: 'f'.repeat(64) } }],
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REVIEW' })
      const [first, concurrent] = await Promise.all([
        createMediaTemporalReviewReceipt({ client: db, actorId: 'reviewer', input }),
        createMediaTemporalReviewReceipt({ client: db, actorId: 'reviewer', input }),
      ])
      expect(new Set([first.receiptId, concurrent.receiptId]).size).toBe(1)
      expect([first.replayed, concurrent.replayed].sort()).toEqual([false, true])
      expect(first).toMatchObject({ builderRunCreated: false, publicationTriggered: false })
      expect(first.heldItems).toEqual([
        { itemHash: mediaIntakeHash(item), reasons: ['DATE_BOUND'] },
      ])
      const operationalInput = {
        tenantId,
        venueId,
        reviewReceiptId: first.receiptId,
        requestId: randomUUID(),
        claimId: claim.claimId,
        expectedSnapshotHash: first.snapshotHash,
        rationale: 'Create an inactive dated draft for human publication review.',
        title: 'Temporary north entrance hours',
        updateType: 'CHANGED_HOURS' as const,
        severity: 'INFO' as const,
        priority: 'NORMAL' as const,
      }
      await expect(
        createMediaTemporalOperationalHandoff({
          client: db,
          actorId: 'reviewer',
          input: {
            ...operationalInput,
            requestId: randomUUID(),
            expectedSnapshotHash: 'f'.repeat(64),
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REVIEW' })
      await expect(
        createMediaTemporalOperationalHandoff({
          client: db,
          actorId: 'reviewer',
          input: { ...operationalInput, requestId: randomUUID(), claimId: 'missing-claim' },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REVIEW' })
      await expect(
        createMediaTemporalOperationalHandoff({
          client: db,
          actorId: 'reviewer',
          input: { ...operationalInput, requestId: randomUUID(), venueId: `wrong-${venueId}` },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      const [draftFirst, draftConcurrent] = await Promise.all([
        createMediaTemporalOperationalHandoff({
          client: db,
          actorId: 'reviewer',
          input: operationalInput,
        }),
        createMediaTemporalOperationalHandoff({
          client: db,
          actorId: 'reviewer',
          input: operationalInput,
        }),
      ])
      expect(new Set([draftFirst.handoffId, draftConcurrent.handoffId]).size).toBe(1)
      expect([draftFirst.replayed, draftConcurrent.replayed].sort()).toEqual([false, true])
      await expect(
        db.operationalUpdate.findFirstOrThrow({
          where: { id: draftFirst.operationalUpdateId, tenantId, venueId },
          select: { status: true, isActive: true, publishedAt: true, publishedBy: true },
        }),
      ).resolves.toEqual({ status: 'DRAFT', isActive: false, publishedAt: null, publishedBy: null })
      await expect(
        db.mediaTemporalOperationalHandoff.count({
          where: { tenantId, venueId, reviewReceiptId: first.receiptId, claimId: claim.claimId },
        }),
      ).resolves.toBe(1)
      const conflictingValue = 'The north entrance is closed all day.'
      const conflictingReview = await createMediaTemporalReviewReceipt({
        client: db,
        actorId: 'reviewer',
        input: {
          ...input,
          requestId: randomUUID(),
          claims: [
            claim,
            {
              ...claim,
              claimId: 'temporary-hours-conflict',
              value: conflictingValue,
              valueHash: createHash('sha256').update(conflictingValue).digest('hex'),
            },
          ],
        },
      })
      await expect(
        createMediaTemporalOperationalHandoff({
          client: db,
          actorId: 'reviewer',
          input: {
            ...operationalInput,
            requestId: randomUUID(),
            reviewReceiptId: conflictingReview.receiptId,
            expectedSnapshotHash: conflictingReview.snapshotHash,
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REVIEW' })
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-09T00:00:00.000Z'))
      await expect(
        createMediaTemporalOperationalHandoff({
          client: db,
          actorId: 'reviewer',
          input: operationalInput,
        }),
      ).resolves.toMatchObject({ handoffId: draftFirst.handoffId, replayed: true })
      vi.useRealTimers()
      await db.mediaIngestionProject.update({ where: { id: projectId }, data: { findings: [] } })
      await expect(
        createMediaTemporalReviewReceipt({ client: db, actorId: 'reviewer', input }),
      ).resolves.toMatchObject({ receiptId: first.receiptId, replayed: true })
      await expect(db.intakeRun.count({ where: { tenantId, venueId } })).resolves.toBe(0)
      await expect(
        db.contentModulePublication.count({ where: { tenantId, venueId } }),
      ).resolves.toBe(0)
      await expect(db.operationalUpdate.count({ where: { tenantId, venueId } })).resolves.toBe(1)
    })
  })
})
