import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { db, withTenantIsolationBypass } from '../index'

const enabled =
  process.env.RUN_MEDIA_TEMPORAL_REVIEW_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_media_temporal_[a-z0-9]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('media temporal receipt database guards', () => {
  afterAll(async () => db.$disconnect())

  it('binds immutable compact review evidence to one inactive operational draft', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `temporal-${suffix}`
      const venueId = `temporal-venue-${suffix}`
      const projectId = `temporal-project-${suffix}`
      const sourceGeneration = randomUUID()
      const uploadAttemptId = randomUUID()
      const requestId = randomUUID()
      const evaluatedAt = new Date('2026-09-07T10:00:00.000Z')
      await db.tenant.create({ data: { id: tenantId, slug: tenantId, name: 'Temporal fixture' } })
      await db.venue.create({
        data: { id: venueId, tenantId, slug: venueId, name: 'Temporal venue' },
      })
      const project = await db.mediaIngestionProject.create({
        data: {
          id: projectId,
          tenantId,
          venueId,
          name: 'Temporal source',
          createdBy: 'reviewer',
          status: 'READY_FOR_REVIEW',
          stage: 'review',
          sourceObjectGeneration: sourceGeneration,
          uploadAttemptId,
        },
      })
      const snapshot = {
        kind: 'MEDIA_TEMPORAL_REVIEW',
        version: 1,
        tenantId,
        venueId,
        projectId,
        sourceGeneration,
        uploadAttemptId,
        requestId,
        reviewedUpdatedAt: project.updatedAt.toISOString(),
        reviewedBy: 'reviewer',
        items: [{ binding: { itemHash: 'c'.repeat(64) }, value: { title: 'Hours' } }],
        sources: [{ sourceId: 'source-1', observations: [{ index: 0, hash: 'd'.repeat(64) }] }],
        temporalReview: {
          evaluatedAt: evaluatedAt.toISOString(),
          claims: [{ claimId: 'claim-1' }],
        },
      }
      const receipt = await db.mediaTemporalReviewReceipt.create({
        data: {
          tenantId,
          venueId,
          projectId,
          sourceGeneration,
          uploadAttemptId,
          requestId,
          requestHash: 'a'.repeat(64),
          snapshotHash: 'b'.repeat(64),
          snapshot,
          actorId: 'reviewer',
          evaluatedAt,
        },
      })
      for (const malformed of [
        { ...snapshot, kind: undefined },
        { ...snapshot, temporalReview: { evaluatedAt: evaluatedAt.toISOString() } },
      ]) {
        await expect(
          db.mediaTemporalReviewReceipt.create({
            data: {
              tenantId,
              venueId,
              projectId,
              sourceGeneration,
              uploadAttemptId,
              requestId: randomUUID(),
              requestHash: 'f'.repeat(64),
              snapshotHash: 'e'.repeat(64),
              snapshot: malformed,
              actorId: 'reviewer',
              evaluatedAt,
            },
          }),
        ).rejects.toThrow()
      }
      await expect(
        db.mediaTemporalReviewReceipt.create({
          data: {
            tenantId,
            venueId,
            projectId,
            sourceGeneration: randomUUID(),
            uploadAttemptId,
            requestId: randomUUID(),
            requestHash: 'c'.repeat(64),
            snapshotHash: 'd'.repeat(64),
            snapshot: { ...snapshot, requestId: randomUUID() },
            actorId: 'reviewer',
            evaluatedAt,
          },
        }),
      ).rejects.toThrow()
      const update = await db.operationalUpdate.create({
        data: {
          tenantId,
          venueId,
          severity: 'INFO',
          title: 'Reviewed temporary hours',
          body: 'Open until six.',
          startsAt: evaluatedAt,
          expiresAt: new Date('2026-09-08T10:00:00.000Z'),
          status: 'DRAFT',
          isActive: false,
          createdBy: 'reviewer',
        },
      })
      await db.mediaTemporalOperationalHandoff.create({
        data: {
          tenantId,
          venueId,
          reviewReceiptId: receipt.id,
          claimId: 'claim-1',
          requestId: randomUUID(),
          requestHash: 'e'.repeat(64),
          operationalUpdateId: update.id,
          actorId: 'reviewer',
          inputSnapshot: { claimId: 'claim-1' },
        },
      })
      await expect(
        db.mediaTemporalReviewReceipt.update({
          where: { id: receipt.id },
          data: { actorId: 'changed' },
        }),
      ).rejects.toThrow()
      await expect(
        db.mediaTemporalOperationalHandoff.deleteMany({ where: { tenantId } }),
      ).rejects.toThrow()
    })
  })
})
