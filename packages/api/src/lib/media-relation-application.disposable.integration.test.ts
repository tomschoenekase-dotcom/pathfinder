import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { mediaEvidenceLocatorId } from '@pathfinder/contracts/media-entity-resolution'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../core'
import { adminLocationConnectionAuthoringRouter } from '../routers/admin/location-connection-authoring'
import { locationRouter } from '../routers/location'
import { applyMediaRelationDraft } from './media-relation-application-service'
import { mediaIntakeHash } from './media-intake-snapshot'
import { saveMediaResolution } from './media-resolution-service'

const enabled =
  process.env.RUN_MEDIA_RELATION_APPLICATION_SERVICE_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

const app = router({ admin: adminLocationConnectionAuthoringRouter, location: locationRouter })

describe.skipIf(!enabled)('media relation application service on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('creates one inactive reviewed route, activates separately, and keeps exact replay immutable', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `relation-service-${suffix}`
      const venueId = `venue-${suffix}`
      const projectId = `project-${suffix}`
      const uploadAttemptId = randomUUID()
      const sourceGeneration = randomUUID()
      const sourceObjectKey = `media/${tenantId}/${projectId}/source.zip`
      const actorId = 'platform-reviewer-1'
      const anonymousToken = randomUUID()
      const observation = (statement: string) => ({
        kind: 'entity_candidate' as const,
        statement,
        evidenceChannel: 'visual' as const,
        directness: 'observed' as const,
        confidence: 'confirmed' as const,
        processingMethod: 'provider_image_analysis' as const,
        locator: { type: 'whole_source' as const },
      })
      const observations = [
        observation('West gallery doorway'),
        observation('East gallery doorway'),
        observation('North gallery doorway'),
        observation('South gallery doorway'),
      ]
      const findings = observations.map((item, index) => ({
        sourceId: `image-${index}`,
        filename: `gallery-${index}.jpg`,
        mediaType: 'IMAGE' as const,
        sourceObservations: [item],
        summary: item.statement,
        uncertainties: [],
      }))
      await db.tenant.create({ data: { id: tenantId, slug: tenantId, name: 'Relation service' } })
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })
      await db.productPlanCapability.upsert({
        where: { planTier_capability: { planTier: tenant.planTier, capability: 'location-plus' } },
        create: {
          planTier: tenant.planTier,
          capability: 'location-plus',
          enabled: true,
          createdBy: actorId,
          updatedBy: actorId,
        },
        update: { enabled: true, updatedBy: actorId },
      })
      await db.venue.create({ data: { id: venueId, tenantId, slug: venueId, name: 'Museum' } })
      await db.visitorSession.create({ data: { tenantId, venueId, anonymousToken } })
      const project = await db.mediaIngestionProject.create({
        data: {
          id: projectId,
          tenantId,
          venueId,
          name: 'Relation review',
          createdBy: actorId,
          status: 'READY_FOR_REVIEW',
          stage: 'review',
          uploadAttemptId,
          sourceObjectGeneration: sourceGeneration,
          sourceObjectKey,
          findings,
          assets: {
            create: findings.map((finding, index) => ({
              tenantId,
              sourceId: finding.sourceId,
              filename: finding.filename,
              mediaType: 'IMAGE',
              objectKey: `${sourceObjectKey}#${finding.sourceId}`,
              bytes: 10n,
              sha256: String(index + 1).repeat(64),
              status: 'COMPLETE',
            })),
          },
        },
      })
      const scope = { tenantId, projectId, uploadAttemptId }
      const candidateIds = ['west-gallery', 'east-gallery', 'north-gallery', 'south-gallery']
      const candidates = observations.map((item, index) => ({
        candidateId: candidateIds[index]!,
        label: item.statement,
        kind: 'gallery',
        identifiers: [],
        contextKeys: [],
        evidence: [
          {
            ...scope,
            sourceId: `image-${index}`,
            sourceSha256: String(index + 1).repeat(64),
            observationIndex: 0,
            observationSha256: mediaIntakeHash(item),
          },
        ],
      }))
      const base = {
        tenantId,
        venueId,
        projectId,
        sourceGeneration,
        expectedUpdatedAt: project.updatedAt.toISOString(),
      }
      let result = await saveMediaResolution({
        client: db,
        actorId,
        input: { ...base, requestId: randomUUID(), expectedRevision: 0, candidates },
      })
      const addReviewedRelation = async (options: {
        relationId: string
        relationKind: 'TRAVERSABLE' | 'ADJACENT'
        confidence: 'confirmed' | 'probable'
        accessibility?: 'ACCESSIBLE' | 'UNKNOWN'
        directions?: string
        fromCandidateId: string
        toCandidateId: string
      }) => {
        const proposalRequestId = randomUUID()
        result = await saveMediaResolution({
          client: db,
          actorId,
          input: {
            ...base,
            requestId: proposalRequestId,
            expectedRevision: result.revision,
            decision: {
              kind: 'PROPOSE_RELATION',
              relationId: options.relationId,
              fromCandidateId: options.fromCandidateId,
              toCandidateId: options.toCandidateId,
              relationKind: options.relationKind,
              evidenceLocatorIds: candidates
                .filter((candidate) =>
                  [options.fromCandidateId, options.toCandidateId].includes(candidate.candidateId),
                )
                .map((candidate) => mediaEvidenceLocatorId(candidate.evidence[0]!)),
              basis: options.relationKind === 'TRAVERSABLE' ? 'doorway' : 'visual_overlap',
              confidence: options.confidence,
              observationTime: { kind: 'UNKNOWN' },
              uncertainties: [],
              ...(options.relationKind === 'TRAVERSABLE'
                ? {
                    traversal: {
                      connectionKind: 'DOOR',
                      bidirectional: true,
                      accessibility: options.accessibility ?? 'ACCESSIBLE',
                      directions:
                        options.directions ?? 'Use the reviewed doorway between the galleries.',
                    },
                  }
                : {}),
              rationale: 'Retain exact evidence for explicit review.',
            },
          },
        })
        const reviewRequestId = randomUUID()
        result = await saveMediaResolution({
          client: db,
          actorId,
          input: {
            ...base,
            requestId: reviewRequestId,
            expectedRevision: result.revision,
            decision: {
              kind: 'REVIEW_RELATION',
              proposalRequestId,
              verdict: 'ACCEPTED',
              rationale: 'Reviewed relation evidence only.',
            },
          },
        })
        return { proposalRequestId, reviewRequestId }
      }
      const valid = await addReviewedRelation({
        relationId: 'valid-route',
        relationKind: 'TRAVERSABLE',
        confidence: 'confirmed',
        fromCandidateId: 'west-gallery',
        toCandidateId: 'east-gallery',
      })
      const probable = await addReviewedRelation({
        relationId: 'probable-route',
        relationKind: 'TRAVERSABLE',
        confidence: 'probable',
        fromCandidateId: 'west-gallery',
        toCandidateId: 'north-gallery',
      })
      const unknown = await addReviewedRelation({
        relationId: 'unknown-route',
        relationKind: 'TRAVERSABLE',
        confidence: 'confirmed',
        accessibility: 'UNKNOWN',
        fromCandidateId: 'west-gallery',
        toCandidateId: 'south-gallery',
      })
      const adjacent = await addReviewedRelation({
        relationId: 'adjacent-only',
        relationKind: 'ADJACENT',
        confidence: 'confirmed',
        fromCandidateId: 'east-gallery',
        toCandidateId: 'north-gallery',
      })

      const [from, to] = await Promise.all([
        db.venueLocation.create({
          data: {
            tenantId,
            venueId,
            stableKey: `west-${suffix}`,
            kind: 'ROOM',
            displayName: 'West gallery',
            visibility: 'PUBLIC',
            verifiedAt: new Date(),
            verifiedBy: actorId,
            isActive: true,
          },
        }),
        db.venueLocation.create({
          data: {
            tenantId,
            venueId,
            stableKey: `east-${suffix}`,
            kind: 'ROOM',
            displayName: 'East gallery',
            visibility: 'PUBLIC',
            verifiedAt: new Date(),
            verifiedBy: actorId,
            isActive: true,
          },
        }),
      ])
      const latest = await db.mediaEntityResolutionRevision.findFirstOrThrow({
        where: { tenantId, venueId, projectId, sourceGeneration },
        orderBy: { revision: 'desc' },
      })
      const applyInput = {
        tenantId,
        venueId,
        projectId,
        sourceGeneration,
        revisionId: latest.id,
        relationId: 'valid-route',
        relationReviewRequestId: valid.reviewRequestId,
        requestId: randomUUID(),
        expectedMediaUpdatedAt: project.updatedAt.toISOString(),
        fromLocationId: from.id,
        fromLocationUpdatedAt: from.updatedAt.toISOString(),
        toLocationId: to.id,
        toLocationUpdatedAt: to.updatedAt.toISOString(),
        rationale: 'Create an inactive route draft from the reviewed relation.',
      }
      const invalid = async (relationId: string, relationReviewRequestId: string) =>
        applyMediaRelationDraft({
          client: db,
          actorId,
          input: { ...applyInput, requestId: randomUUID(), relationId, relationReviewRequestId },
        })
      await expect(invalid('probable-route', probable.reviewRequestId)).rejects.toThrow(
        /Confirm the path evidence/,
      )
      await expect(invalid('unknown-route', unknown.reviewRequestId)).rejects.toThrow(
        /unknown accessibility/,
      )
      await expect(invalid('adjacent-only', adjacent.reviewRequestId)).rejects.toThrow(
        /do not authorize a walking connection/,
      )
      await expect(
        applyMediaRelationDraft({
          client: db,
          actorId,
          input: { ...applyInput, requestId: randomUUID(), relationReviewRequestId: randomUUID() },
        }),
      ).rejects.toThrow(/exact accepted relation review/)
      await expect(
        applyMediaRelationDraft({
          client: db,
          actorId,
          input: {
            ...applyInput,
            requestId: randomUUID(),
            fromLocationUpdatedAt: new Date(0).toISOString(),
          },
        }),
      ).rejects.toThrow(/anchors must still be active, public and unchanged/)
      await db.mediaIngestionAsset.updateMany({
        where: { tenantId, projectId, sourceId: 'image-1' },
        data: { sha256: 'f'.repeat(64) },
      })
      await expect(
        applyMediaRelationDraft({
          client: db,
          actorId,
          input: { ...applyInput, requestId: randomUUID() },
        }),
      ).rejects.toThrow(/source is unavailable|source evidence changed/i)
      await db.mediaIngestionAsset.updateMany({
        where: { tenantId, projectId, sourceId: 'image-1' },
        data: { sha256: '2'.repeat(64) },
      })
      const applied = await Promise.all([
        applyMediaRelationDraft({ client: db, actorId, input: applyInput }),
        applyMediaRelationDraft({ client: db, actorId, input: applyInput }),
      ])
      expect(new Set(applied.map((item) => item.receiptId)).size).toBe(1)
      expect(applied.filter((item) => item.replayed)).toHaveLength(1)
      await expect(
        applyMediaRelationDraft({ client: db, actorId: 'other-reviewer', input: applyInput }),
      ).rejects.toThrow(/bound to another reviewed route/)
      const connection = await db.venueLocationConnection.findUniqueOrThrow({
        where: { id: applyInput.requestId },
      })
      expect(connection.isActive).toBe(false)
      expect(await db.mediaRelationApplication.count({ where: { tenantId, venueId } })).toBe(1)

      const publicCaller = app.createCaller({
        db,
        headers: new Headers(),
        session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
      })
      await expect(
        publicCaller.location.route({
          venueId,
          anonymousToken,
          fromLocationId: from.id,
          toLocationId: to.id,
          accessibleOnly: false,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const adminCaller = app.createCaller({
        db,
        headers: new Headers(),
        session: { userId: actorId, activeTenantId: null, role: null, isPlatformAdmin: true },
      })
      await adminCaller.admin.setVenueLocationConnectionAvailability({
        tenantId,
        venueId,
        connectionId: connection.id,
        expectedUpdatedAt: connection.updatedAt,
        active: true,
        reason: 'Separate human activation after reviewing the inactive draft.',
      })
      const route = await publicCaller.location.route({
        venueId,
        anonymousToken,
        fromLocationId: from.id,
        toLocationId: to.id,
        accessibleOnly: false,
      })
      expect(route.segments).toHaveLength(1)
      expect(route.segments[0]).toMatchObject({ connectionId: connection.id, kind: 'DOOR' })

      const unrelatedProposalRequestId = randomUUID()
      const advanced = await saveMediaResolution({
        client: db,
        actorId,
        input: {
          ...base,
          requestId: unrelatedProposalRequestId,
          expectedRevision: result.revision,
          decision: {
            kind: 'PROPOSE_RELATION',
            relationId: 'later-covisibility',
            fromCandidateId: 'west-gallery',
            toCandidateId: 'east-gallery',
            relationKind: 'COVISIBLE',
            evidenceLocatorIds: candidates.map((candidate) =>
              mediaEvidenceLocatorId(candidate.evidence[0]!),
            ),
            basis: 'visual_overlap',
            confidence: 'probable',
            observationTime: { kind: 'UNKNOWN' },
            uncertainties: ['No path implied.'],
            rationale: 'Unrelated later review state.',
          },
        },
      })
      expect(advanced.revision).toBe(result.revision + 1)
      await expect(
        publicCaller.location.route({
          venueId,
          anonymousToken,
          fromLocationId: from.id,
          toLocationId: to.id,
          accessibleOnly: false,
        }),
      ).resolves.toMatchObject({ segments: [{ connectionId: connection.id }] })
      expect(
        await applyMediaRelationDraft({ client: db, actorId, input: applyInput }),
      ).toMatchObject({ receiptId: applied[0]!.receiptId, replayed: true })
      await expect(
        applyMediaRelationDraft({
          client: db,
          actorId,
          input: { ...applyInput, revisionId: advanced.id, requestId: randomUUID() },
        }),
      ).rejects.toThrow(/already has a canonical draft/)

      await expect(
        applyMediaRelationDraft({
          client: db,
          actorId,
          input: { ...applyInput, requestId: randomUUID(), tenantId: `forged-${tenantId}` },
        }),
      ).rejects.toThrow()
      await expect(
        applyMediaRelationDraft({
          client: db,
          actorId,
          input: {
            ...applyInput,
            revisionId: advanced.id,
            requestId: randomUUID(),
            relationId: 'later-covisibility',
            relationReviewRequestId: valid.reviewRequestId,
          },
        }),
      ).rejects.toThrow()
      const withdrawn = await saveMediaResolution({
        client: db,
        actorId,
        input: {
          ...base,
          requestId: randomUUID(),
          expectedRevision: advanced.revision,
          decision: {
            kind: 'REVERT_RELATION',
            reviewRequestId: valid.reviewRequestId,
            rationale:
              'Withdraw the route review while retaining its immutable application receipt.',
          },
        },
      })
      expect(withdrawn.revision).toBe(advanced.revision + 1)
      await expect(
        publicCaller.location.route({
          venueId,
          anonymousToken,
          fromLocationId: from.id,
          toLocationId: to.id,
          accessibleOnly: false,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      const activeConnection = await db.venueLocationConnection.findUniqueOrThrow({
        where: { id: connection.id },
      })
      await adminCaller.admin.setVenueLocationConnectionAvailability({
        tenantId,
        venueId,
        connectionId: connection.id,
        expectedUpdatedAt: activeConnection.updatedAt,
        active: false,
        reason: 'Deactivate the withdrawn route before applying a new reviewed relation.',
      })
      result = withdrawn
      const renewed = await addReviewedRelation({
        relationId: 'renewed-valid-route',
        relationKind: 'TRAVERSABLE',
        confidence: 'confirmed',
        fromCandidateId: 'west-gallery',
        toCandidateId: 'east-gallery',
        directions: 'Use the newly reviewed signed gallery doorway.',
      })
      const renewedRevision = await db.mediaEntityResolutionRevision.findUniqueOrThrow({
        where: { id: result.id },
      })
      const inactiveConnection = await db.venueLocationConnection.findUniqueOrThrow({
        where: { id: connection.id },
      })
      const renewalInput = {
        ...applyInput,
        revisionId: renewedRevision.id,
        relationId: 'renewed-valid-route',
        relationReviewRequestId: renewed.reviewRequestId,
        requestId: randomUUID(),
        existingConnection: {
          id: connection.id,
          expectedUpdatedAt: inactiveConnection.updatedAt.toISOString(),
        },
      }
      const renewedApplication = await applyMediaRelationDraft({
        client: db,
        actorId,
        input: renewalInput,
      })
      expect(renewedApplication).toMatchObject({
        connectionId: connection.id,
        replayed: false,
        createdAs: 'INACTIVE_DRAFT',
      })
      expect(
        await db.mediaRelationApplication.count({ where: { connectionId: connection.id } }),
      ).toBe(2)
      const renewedConnection = await db.venueLocationConnection.findUniqueOrThrow({
        where: { id: connection.id },
      })
      expect(renewedConnection).toMatchObject({
        id: connection.id,
        isActive: false,
        directions: 'Use the newly reviewed signed gallery doorway.',
      })
      await expect(
        applyMediaRelationDraft({ client: db, actorId, input: renewalInput }),
      ).resolves.toMatchObject({ receiptId: renewedApplication.receiptId, replayed: true })
      await adminCaller.admin.setVenueLocationConnectionAvailability({
        tenantId,
        venueId,
        connectionId: connection.id,
        expectedUpdatedAt: renewedConnection.updatedAt,
        active: true,
        reason: 'Activate the separately reviewed renewed route.',
      })
      await expect(
        publicCaller.location.route({
          venueId,
          anonymousToken,
          fromLocationId: from.id,
          toLocationId: to.id,
          accessibleOnly: false,
        }),
      ).resolves.toMatchObject({
        segments: [
          {
            connectionId: connection.id,
            directions: 'Use the newly reviewed signed gallery doorway.',
          },
        ],
      })
      const renewedWithdrawn = await saveMediaResolution({
        client: db,
        actorId,
        input: {
          ...base,
          requestId: randomUUID(),
          expectedRevision: result.revision,
          decision: {
            kind: 'REVERT_RELATION',
            reviewRequestId: renewed.reviewRequestId,
            rationale: 'Withdraw the renewed relation review.',
          },
        },
      })
      await saveMediaResolution({
        client: db,
        actorId,
        input: {
          ...base,
          requestId: randomUUID(),
          expectedRevision: renewedWithdrawn.revision,
          decision: {
            kind: 'REVIEW_RELATION',
            proposalRequestId: valid.proposalRequestId,
            verdict: 'ACCEPTED',
            rationale: 'Restore the original review without restoring its obsolete receipt.',
          },
        },
      })
      await expect(
        publicCaller.location.route({
          venueId,
          anonymousToken,
          fromLocationId: from.id,
          toLocationId: to.id,
          accessibleOnly: false,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(await db.contentModulePublication.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })).toBe(0)
    })
  })
})
