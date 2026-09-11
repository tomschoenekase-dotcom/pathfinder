import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

const enabled =
  process.env.RUN_MEDIA_RELATION_APPLICATION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('media relation application receipt on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('binds latest review to an inactive scoped connection and rejects mutation or forged scope', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `relation-${suffix}`
      const venueId = `venue-${suffix}`
      const projectId = `project-${suffix}`
      const uploadAttemptId = randomUUID()
      const sourceGeneration = randomUUID()
      await db.tenant.create({ data: { id: tenantId, slug: tenantId, name: 'Relation guard' } })
      await db.venue.create({ data: { id: venueId, tenantId, slug: venueId, name: 'Museum' } })
      await db.mediaIngestionProject.create({
        data: {
          id: projectId,
          tenantId,
          venueId,
          name: 'Relation review',
          createdBy: 'reviewer-1',
          status: 'READY_FOR_REVIEW',
          stage: 'review',
          sourceObjectGeneration: sourceGeneration,
          uploadAttemptId,
        },
      })
      const state = {
        version: 1,
        scope: { tenantId, projectId, uploadAttemptId },
        candidates: [],
        decisions: [],
      }
      const evidenceSnapshot = {
        scope: state.scope,
        sourceGeneration,
        candidates: [],
        evidence: [],
      }
      const revision = await db.mediaEntityResolutionRevision.create({
        data: {
          tenantId,
          venueId,
          projectId,
          sourceGeneration,
          revision: 1,
          requestId: randomUUID(),
          requestHash: 'a'.repeat(64),
          evidenceSnapshotHash: 'b'.repeat(64),
          evidenceSnapshot,
          state,
          actorId: 'reviewer-1',
        },
      })
      const [from, to] = await Promise.all([
        db.venueLocation.create({
          data: {
            tenantId,
            venueId,
            stableKey: `from-${suffix}`,
            kind: 'ROOM',
            displayName: 'West gallery',
            visibility: 'PUBLIC',
            verifiedAt: new Date(),
            verifiedBy: 'reviewer-1',
            isActive: true,
          },
        }),
        db.venueLocation.create({
          data: {
            tenantId,
            venueId,
            stableKey: `to-${suffix}`,
            kind: 'ROOM',
            displayName: 'East gallery',
            visibility: 'PUBLIC',
            verifiedAt: new Date(),
            verifiedBy: 'reviewer-1',
            isActive: true,
          },
        }),
      ])
      const connection = await db.venueLocationConnection.create({
        data: {
          tenantId,
          venueId,
          fromLocationId: from.id,
          toLocationId: to.id,
          kind: 'DOOR',
          bidirectional: true,
          accessible: true,
          directions: 'Use the reviewed doorway.',
          verifiedAt: new Date(),
          verifiedBy: 'reviewer-1',
          isActive: false,
        },
      })
      const reviewRequestId = randomUUID()
      const snapshot = {
        input: { tenantId, venueId, revisionId: revision.id },
        actorId: 'reviewer-1',
        reviewedDraft: { connectionId: connection.id, active: false },
        evidenceSnapshotHash: 'b'.repeat(64),
        stateHash: 'c'.repeat(64),
      }
      const create = (overrides: Record<string, unknown> = {}) =>
        db.mediaRelationApplication.create({
          data: {
            tenantId,
            venueId,
            revisionId: revision.id,
            relationId: 'west-door',
            relationReviewRequestId: reviewRequestId,
            requestId: randomUUID(),
            requestHash: 'd'.repeat(64),
            actorId: 'reviewer-1',
            connectionId: connection.id,
            inputSnapshot: snapshot,
            ...overrides,
          },
        })
      const receipt = await create()
      await expect(create()).rejects.toThrow()
      await expect(
        create({ relationReviewRequestId: randomUUID(), requestId: receipt.requestId }),
      ).rejects.toThrow()
      await expect(
        create({ relationReviewRequestId: randomUUID(), requestHash: 'BAD' }),
      ).rejects.toThrow()
      await expect(
        create({ relationReviewRequestId: randomUUID(), actorId: '   ' }),
      ).rejects.toThrow()
      await expect(
        create({ relationReviewRequestId: randomUUID(), inputSnapshot: [] }),
      ).rejects.toThrow()
      await expect(
        create({
          relationReviewRequestId: randomUUID(),
          inputSnapshot: { value: 'x'.repeat(262_145) },
        }),
      ).rejects.toThrow()

      const secondRequestId = randomUUID()
      const secondDecision = {
        kind: 'PROPOSE_RELATION',
        requestId: secondRequestId,
        reviewerId: 'reviewer-1',
      }
      const second = await db.mediaEntityResolutionRevision.create({
        data: {
          tenantId,
          venueId,
          projectId,
          sourceGeneration,
          revision: 2,
          requestId: secondRequestId,
          requestHash: 'e'.repeat(64),
          evidenceSnapshotHash: 'b'.repeat(64),
          evidenceSnapshot,
          state: { ...state, decisions: [secondDecision] },
          actorId: 'reviewer-1',
        },
      })
      await expect(create({ revisionId: second.id, requestId: randomUUID() })).rejects.toThrow()
      await expect(
        create({ relationReviewRequestId: randomUUID(), requestId: randomUUID() }),
      ).rejects.toThrow(/latest exact resolution revision/iu)

      await db.mediaIngestionProject.update({
        where: { id: projectId },
        data: { sourceObjectGeneration: randomUUID() },
      })
      await expect(
        create({
          revisionId: second.id,
          relationReviewRequestId: randomUUID(),
          requestId: randomUUID(),
        }),
      ).rejects.toThrow(/stale for the current project generation/iu)
      await db.mediaIngestionProject.update({
        where: { id: projectId },
        data: { sourceObjectGeneration: sourceGeneration },
      })

      await db.venueLocationConnection.update({
        where: { id: connection.id },
        data: { isActive: true },
      })
      const latest = await db.mediaEntityResolutionRevision.findFirstOrThrow({
        where: { tenantId, venueId, projectId, revision: 2 },
      })
      await expect(
        create({
          revisionId: latest.id,
          relationReviewRequestId: randomUUID(),
          requestId: randomUUID(),
        }),
      ).rejects.toThrow(/inactive canonical connection/iu)
      await expect(
        db.mediaRelationApplication.update({
          where: { id: receipt.id },
          data: { actorId: 'rewriter' },
        }),
      ).rejects.toThrow(/append-only/iu)
      await expect(
        db.mediaRelationApplication.delete({ where: { id: receipt.id } }),
      ).rejects.toThrow(/append-only/iu)
      await expect(
        db.$executeRawUnsafe('TRUNCATE TABLE "media_relation_applications"'),
      ).rejects.toThrow(/append-only/iu)
    })
  })
})
