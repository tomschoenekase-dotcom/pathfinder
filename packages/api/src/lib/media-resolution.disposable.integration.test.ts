import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { mediaEvidenceLocatorId } from '@pathfinder/contracts/media-entity-resolution'

import { mediaIntakeHash } from './media-intake-snapshot'
import { saveMediaResolution } from './media-resolution-service'

const enabled =
  process.env.RUN_MEDIA_RESOLUTION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('media resolution service on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('retains exact source evidence through concurrent init, merge, revert, and replay', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `resolution-service-${suffix}`
      const venueId = `venue-${suffix}`
      const projectId = `project-${suffix}`
      const uploadAttemptId = randomUUID()
      const sourceGeneration = randomUUID()
      const sourceObjectKey = `media/${tenantId}/${projectId}/source.zip`
      const videoSha = 'a'.repeat(64)
      const imageSha = 'b'.repeat(64)
      const legacyObservation = {
        kind: 'entity_candidate' as const,
        statement: 'Bronze lion beside the west stair',
        evidenceChannel: 'visual' as const,
        directness: 'observed' as const,
        confidence: 'confirmed' as const,
        startSeconds: 12,
        endSeconds: 15,
      }
      const sourceObservation = {
        kind: 'entity_candidate' as const,
        statement: 'The same bronze lion seen from the landing',
        evidenceChannel: 'visual' as const,
        directness: 'observed' as const,
        confidence: 'confirmed' as const,
        processingMethod: 'provider_image_analysis' as const,
        locator: {
          type: 'image_region' as const,
          region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
        },
      }
      const findings = [
        {
          sourceId: 'legacy-video',
          filename: 'archive.mp4',
          mediaType: 'VIDEO',
          observations: [legacyObservation],
          summary: 'Historic video',
          uncertainties: [],
        },
        {
          sourceId: 'current-image',
          filename: 'landing.jpg',
          mediaType: 'IMAGE',
          sourceObservations: [sourceObservation],
          summary: 'Current image',
          uncertainties: [],
        },
      ]
      await db.tenant.create({ data: { id: tenantId, slug: tenantId, name: 'Resolution service' } })
      await db.venue.create({ data: { id: venueId, tenantId, slug: venueId, name: 'Museum' } })
      const project = await db.mediaIngestionProject.create({
        data: {
          id: projectId,
          tenantId,
          venueId,
          name: 'Entity review',
          createdBy: 'reviewer-1',
          status: 'READY_FOR_REVIEW',
          stage: 'review',
          uploadAttemptId,
          sourceObjectGeneration: sourceGeneration,
          sourceObjectKey,
          findings,
          assets: {
            create: [
              {
                tenantId,
                sourceId: 'legacy-video',
                filename: 'archive.mp4',
                mediaType: 'VIDEO',
                objectKey: `${sourceObjectKey}#legacy-video`,
                bytes: 100n,
                sha256: videoSha,
                status: 'COMPLETE',
              },
              {
                tenantId,
                sourceId: 'current-image',
                filename: 'landing.jpg',
                mediaType: 'IMAGE',
                objectKey: `${sourceObjectKey}#current-image`,
                bytes: 50n,
                sha256: imageSha,
                status: 'COMPLETE',
              },
            ],
          },
        },
      })
      const scope = { tenantId, projectId, uploadAttemptId }
      const candidates = [
        {
          candidateId: 'lion-video',
          label: 'Bronze lion',
          kind: 'artifact',
          identifiers: [],
          contextKeys: [],
          evidence: [
            {
              ...scope,
              sourceId: 'legacy-video',
              sourceSha256: videoSha,
              observationIndex: 0,
              observationSha256: mediaIntakeHash(legacyObservation),
            },
          ],
        },
        {
          candidateId: 'lion-image',
          label: 'Bronze lion',
          kind: 'artifact',
          identifiers: [],
          contextKeys: [],
          evidence: [
            {
              ...scope,
              sourceId: 'current-image',
              sourceSha256: imageSha,
              observationIndex: 0,
              observationSha256: mediaIntakeHash(sourceObservation),
            },
          ],
        },
      ]
      const initialRequestId = randomUUID()
      const initialInput = {
        tenantId,
        venueId,
        projectId,
        sourceGeneration,
        requestId: initialRequestId,
        expectedUpdatedAt: project.updatedAt.toISOString(),
        expectedRevision: 0,
        candidates,
      }
      const initialized = await Promise.all([
        saveMediaResolution({ client: db, actorId: 'reviewer-1', input: initialInput }),
        saveMediaResolution({ client: db, actorId: 'reviewer-1', input: initialInput }),
      ])
      expect(new Set(initialized.map((result) => result.id)).size).toBe(1)
      expect(initialized.filter((result) => result.replayed)).toHaveLength(1)

      const relationRequestId = randomUUID()
      const relationDecision = {
        kind: 'PROPOSE_RELATION' as const,
        relationId: 'west-stair-adjacency',
        fromCandidateId: 'lion-video',
        toCandidateId: 'lion-image',
        relationKind: 'ADJACENT' as const,
        evidenceLocatorIds: candidates.map((candidate) =>
          mediaEvidenceLocatorId(candidate.evidence[0]!),
        ),
        basis: 'visual_overlap' as const,
        confidence: 'probable' as const,
        observationTime: { kind: 'UNKNOWN' as const },
        uncertainties: ['The two source views do not prove a traversable path.'],
        rationale: 'Retain the scoped spatial evidence for explicit review.',
      }
      const proposed = await saveMediaResolution({
        client: db,
        actorId: 'reviewer-1',
        input: {
          tenantId,
          venueId,
          projectId,
          sourceGeneration,
          requestId: relationRequestId,
          expectedUpdatedAt: project.updatedAt.toISOString(),
          expectedRevision: 1,
          decision: relationDecision,
        },
      })
      expect(proposed.projection.relations).toEqual([
        expect.objectContaining({
          relationId: 'west-stair-adjacency',
          reviewStatus: 'PENDING',
          fromCandidateId: 'lion-video',
          toCandidateId: 'lion-image',
          endpointState: 'RESOLVED',
        }),
      ])
      await expect(
        saveMediaResolution({
          client: db,
          actorId: 'reviewer-1',
          input: {
            tenantId,
            venueId,
            projectId,
            sourceGeneration,
            requestId: randomUUID(),
            expectedUpdatedAt: project.updatedAt.toISOString(),
            expectedRevision: 2,
            decision: {
              ...relationDecision,
              relationId: 'forged-relation',
              evidenceLocatorIds: [
                relationDecision.evidenceLocatorIds[0]!,
                'media-evidence-v1:["forged"]',
              ],
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REVIEW' })
      const proposalReplay = await saveMediaResolution({
        client: db,
        actorId: 'reviewer-1',
        input: {
          tenantId,
          venueId,
          projectId,
          sourceGeneration,
          requestId: relationRequestId,
          expectedUpdatedAt: project.updatedAt.toISOString(),
          expectedRevision: 1,
          decision: relationDecision,
        },
      })
      expect(proposalReplay).toMatchObject({ id: proposed.id, revision: 2, replayed: true })

      const firstReviewRequestId = randomUUID()
      const reviewInput = {
        tenantId,
        venueId,
        projectId,
        sourceGeneration,
        requestId: firstReviewRequestId,
        expectedUpdatedAt: project.updatedAt.toISOString(),
        expectedRevision: 2,
        decision: {
          kind: 'REVIEW_RELATION' as const,
          proposalRequestId: relationRequestId,
          verdict: 'ACCEPTED' as const,
          rationale: 'Accept the evidence hypothesis without granting canonical write authority.',
        },
      }
      const accepted = await saveMediaResolution({
        client: db,
        actorId: 'reviewer-1',
        input: reviewInput,
      })
      expect(accepted.projection.relations[0]).toMatchObject({ reviewStatus: 'ACCEPTED' })
      expect(
        await saveMediaResolution({ client: db, actorId: 'reviewer-1', input: reviewInput }),
      ).toMatchObject({ id: accepted.id, revision: 3, replayed: true })

      const reviewRevertRequestId = randomUUID()
      const reviewReverted = await saveMediaResolution({
        client: db,
        actorId: 'reviewer-1',
        input: {
          tenantId,
          venueId,
          projectId,
          sourceGeneration,
          requestId: reviewRevertRequestId,
          expectedUpdatedAt: project.updatedAt.toISOString(),
          expectedRevision: 3,
          decision: {
            kind: 'REVERT_RELATION',
            reviewRequestId: firstReviewRequestId,
            rationale: 'Retain the first verdict in history while reopening review.',
          },
        },
      })
      expect(reviewReverted.projection.relations[0]).toMatchObject({ reviewStatus: 'PENDING' })
      const rejectedRequestId = randomUUID()
      const rejected = await saveMediaResolution({
        client: db,
        actorId: 'reviewer-1',
        input: {
          tenantId,
          venueId,
          projectId,
          sourceGeneration,
          requestId: rejectedRequestId,
          expectedUpdatedAt: project.updatedAt.toISOString(),
          expectedRevision: 4,
          decision: {
            kind: 'REVIEW_RELATION',
            proposalRequestId: relationRequestId,
            verdict: 'REJECTED',
            rationale: 'The retained uncertainty prevents operational use.',
          },
        },
      })
      expect(rejected.projection.relations[0]).toMatchObject({ reviewStatus: 'REJECTED' })
      const rejectedReverted = await saveMediaResolution({
        client: db,
        actorId: 'reviewer-1',
        input: {
          tenantId,
          venueId,
          projectId,
          sourceGeneration,
          requestId: randomUUID(),
          expectedUpdatedAt: project.updatedAt.toISOString(),
          expectedRevision: 5,
          decision: {
            kind: 'REVERT_RELATION',
            reviewRequestId: rejectedRequestId,
            rationale: 'New human review is required; preserve the rejected verdict in history.',
          },
        },
      })
      expect(rejectedReverted.projection.relations[0]).toMatchObject({ reviewStatus: 'PENDING' })
      const acceptedAgain = await saveMediaResolution({
        client: db,
        actorId: 'reviewer-1',
        input: {
          tenantId,
          venueId,
          projectId,
          sourceGeneration,
          requestId: randomUUID(),
          expectedUpdatedAt: project.updatedAt.toISOString(),
          expectedRevision: 6,
          decision: {
            kind: 'REVIEW_RELATION',
            proposalRequestId: relationRequestId,
            verdict: 'ACCEPTED',
            rationale: 'A later explicit review accepts the evidence relation only.',
          },
        },
      })
      expect(acceptedAgain.projection.relations[0]).toMatchObject({ reviewStatus: 'ACCEPTED' })

      const mergeRequestId = randomUUID()
      const merged = await saveMediaResolution({
        client: db,
        actorId: 'reviewer-1',
        input: {
          tenantId,
          venueId,
          projectId,
          sourceGeneration,
          requestId: mergeRequestId,
          expectedUpdatedAt: project.updatedAt.toISOString(),
          expectedRevision: 7,
          decision: {
            kind: 'MERGE',
            candidateIds: ['lion-video', 'lion-image'],
            representativeId: 'lion-video',
            rationale: 'Two views of the same retained object.',
          },
        },
      })
      expect(merged.projection.groups).toHaveLength(1)
      expect(merged.projection.references).toHaveLength(2)
      expect(merged.projection.relations[0]).toMatchObject({
        endpointState: 'COLLAPSED',
        fromCandidateId: 'lion-video',
        toCandidateId: 'lion-video',
      })
      const reverted = await saveMediaResolution({
        client: db,
        actorId: 'reviewer-1',
        input: {
          tenantId,
          venueId,
          projectId,
          sourceGeneration,
          requestId: randomUUID(),
          expectedUpdatedAt: project.updatedAt.toISOString(),
          expectedRevision: 8,
          decision: {
            kind: 'REVERT_MERGE',
            mergeRequestId,
            rationale: 'Keep the source mentions independently addressable.',
          },
        },
      })
      expect(reverted.projection.groups).toHaveLength(2)
      expect(reverted.projection.references.map((item) => item.candidateId).sort()).toEqual([
        'lion-image',
        'lion-video',
      ])
      expect(reverted.projection.relations[0]).toMatchObject({
        endpointState: 'RESOLVED',
        fromCandidateId: 'lion-video',
        toCandidateId: 'lion-image',
      })
      expect(
        await db.mediaEntityResolutionRevision.count({ where: { tenantId, venueId, projectId } }),
      ).toBe(9)

      const nextMerge = (expectedUpdatedAt: string) => ({
        tenantId,
        venueId,
        projectId,
        sourceGeneration,
        requestId: randomUUID(),
        expectedUpdatedAt,
        expectedRevision: 9,
        decision: {
          kind: 'MERGE' as const,
          candidateIds: ['lion-video', 'lion-image'],
          representativeId: 'lion-video',
          rationale: 'Evidence-integrity probe.',
        },
      })
      await db.mediaIngestionAsset.updateMany({
        where: { tenantId, projectId, sourceId: 'current-image' },
        data: { sha256: 'c'.repeat(64) },
      })
      await expect(
        saveMediaResolution({
          client: db,
          actorId: 'reviewer-1',
          input: nextMerge(project.updatedAt.toISOString()),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REVIEW' })
      await db.mediaIngestionAsset.updateMany({
        where: { tenantId, projectId, sourceId: 'current-image' },
        data: { sha256: imageSha, status: 'FAILED' },
      })
      await expect(
        saveMediaResolution({
          client: db,
          actorId: 'reviewer-1',
          input: nextMerge(project.updatedAt.toISOString()),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REVIEW' })
      await db.mediaIngestionAsset.updateMany({
        where: { tenantId, projectId, sourceId: 'current-image' },
        data: { status: 'COMPLETE' },
      })
      const tamperedProject = await db.mediaIngestionProject.update({
        where: { id: projectId },
        data: {
          findings: [
            findings[0]!,
            {
              ...findings[1]!,
              sourceObservations: [
                { ...sourceObservation, statement: 'A substituted source observation.' },
              ],
            },
          ],
        },
      })
      await expect(
        saveMediaResolution({
          client: db,
          actorId: 'reviewer-1',
          input: nextMerge(tamperedProject.updatedAt.toISOString()),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REVIEW' })
      await db.mediaIngestionProject.update({ where: { id: projectId }, data: { findings } })

      await expect(
        saveMediaResolution({
          client: db,
          actorId: 'reviewer-1',
          input: {
            ...initialInput,
            requestId: randomUUID(),
            expectedRevision: 1,
            candidates: undefined,
            decision: { kind: 'REVERT_MERGE', mergeRequestId, rationale: 'stale' },
          },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        saveMediaResolution({ client: db, actorId: 'another-reviewer', input: initialInput }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        saveMediaResolution({
          client: db,
          actorId: 'reviewer-1',
          input: { ...initialInput, venueId: `other-${venueId}` },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      await db.mediaIngestionProject.update({
        where: { id: projectId },
        data: { status: 'COMPLETE', findings: [] },
      })
      const replay = await saveMediaResolution({
        client: db,
        actorId: 'reviewer-1',
        input: initialInput,
      })
      expect(replay).toMatchObject({ id: initialized[0]!.id, replayed: true, revision: 1 })
      const receipts = await db.mediaEntityResolutionRevision.findMany({
        where: { tenantId, projectId },
        orderBy: { revision: 'asc' },
        select: { evidenceSnapshot: true },
      })
      expect(JSON.stringify(receipts[0]!.evidenceSnapshot)).toContain(
        'Bronze lion beside the west stair',
      )
      expect(JSON.stringify(receipts[0]!.evidenceSnapshot)).toContain(
        'same bronze lion seen from the landing',
      )
      expect(await db.contentModuleIdentity.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.contentModulePublication.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.venueLocation.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.venueLocationConnection.count({ where: { tenantId, venueId } })).toBe(0)
    })
  })
})
