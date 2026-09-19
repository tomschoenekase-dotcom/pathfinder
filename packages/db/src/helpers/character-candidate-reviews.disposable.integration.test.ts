import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createCharacterBundle,
  FACTORY_STATES,
  readCharacterBundle,
  type CharacterSpec,
} from '@pathfinder/character-factory'

import { db, withTenantIsolationBypass } from '../index'
import {
  claimCharacterFactoryJobAction,
  completeCharacterFactoryJobAction,
  prepareCharacterFactoryJobAction,
} from './custom-character-factory-actions'
import {
  characterCandidateArtifactFingerprint,
  decideCharacterCandidateReview,
  readCharacterCandidateReviewBrief,
  submitCharacterCandidateReviewBrief,
} from './character-candidate-reviews'

const enabled =
  process.env.RUN_CHARACTER_CANDIDATE_REVIEW_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')
const neutralSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#6b7280"/></svg>'
const neutralBytes = new TextEncoder().encode(neutralSvg)
const neutralSha256 = createHash('sha256').update(neutralBytes).digest('hex')

describe.skipIf(!enabled)('character candidate review disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it(
    'binds imported candidates to scoped, immutable human review receipts and queued follow-up jobs',
    async () =>
      withTenantIsolationBypass(async () => {
        const suffix = randomUUID().slice(0, 12)
        const tenantId = `tenant-candidate-review-${suffix}`
        const venueId = `venue-candidate-review-${suffix}`
        const siblingVenueId = `venue-candidate-review-sibling-${suffix}`
        const otherTenantId = `tenant-candidate-review-other-${suffix}`
        const otherVenueId = `venue-candidate-review-other-${suffix}`
        const agent = { id: `agent-${suffix}`, role: 'AGENT' as const, type: 'AGENT' as const }
        const human = {
          id: `human-${suffix}`,
          role: 'PLATFORM_ADMIN' as const,
          type: 'HUMAN' as const,
        }
        await db.tenant.createMany({
          data: [
            { id: tenantId, name: 'Disposable candidate review tenant', slug: tenantId },
            { id: otherTenantId, name: 'Other candidate review tenant', slug: otherTenantId },
          ],
        })
        await db.venue.createMany({
          data: [
            { id: venueId, tenantId, name: 'Disposable candidate review venue', slug: venueId },
            {
              id: siblingVenueId,
              tenantId,
              name: 'Sibling candidate review venue',
              slug: siblingVenueId,
            },
            {
              id: otherVenueId,
              tenantId: otherTenantId,
              name: 'Other candidate review venue',
              slug: otherVenueId,
            },
          ],
        })

        const createCandidate = async (name: string, targetVenueId = venueId) => {
          const characterId = `character-${name}-${suffix}`
          const requestId = `import-${name}-${suffix}`
          const spec: CharacterSpec = {
            schemaVersion: 1,
            characterId,
            version: 1,
            revision: 1,
            displayName: `Imported ${name}`,
            rigFamily: 'compact-creature-v1',
            source: {
              kind: 'imported',
              sourceUrl: 'https://example.invalid/imported-fixture.svg',
              sourceRevision: 'fixture',
              license: 'CC-BY-SA-4.0',
              attribution: 'Disposable fixture only',
              importedAt: new Date().toISOString(),
              sha256: neutralSha256,
              mediaType: 'image/svg+xml',
              byteLength: neutralBytes.byteLength,
            },
            masterReference: `source/${name}.svg`,
            protectedTraits: ['fixture trait'],
            slotMap: { body: 'body' },
            supportedStates: FACTORY_STATES,
            status: 'candidate',
          }
          await prepareCharacterFactoryJobAction({
            tenantId,
            venueId: targetVenueId,
            requestId,
            action: 'CREATE_FROM_IMPORT',
            requestPayload: {
              characterId,
              sourceAssetReference: spec.masterReference,
              sourceSha256: neutralSha256,
            },
            actor: human,
          })
          const claim = await claimCharacterFactoryJobAction({
            tenantId,
            venueId: targetVenueId,
            requestId,
          })
          if (claim.state !== 'claimed') throw new Error('Expected imported candidate claim')
          const bundle = await createCharacterBundle(spec, [
            {
              path: spec.masterReference,
              mediaType: 'image/svg+xml',
              role: 'master',
              bytes: neutralBytes,
            },
            {
              path: 'slots/body.svg',
              mediaType: 'image/svg+xml',
              role: 'slot',
              slot: 'body',
              bytes: neutralBytes,
            },
            {
              path: 'fallback/static.svg',
              mediaType: 'image/svg+xml',
              role: 'fallback',
              bytes: neutralBytes,
            },
          ])
          const reference = {
            kind: 'character-bundle-v1' as const,
            bucket: 'fixture-bucket',
            objectKey: `character-factory/${tenantId}/${targetVenueId}/${characterId}/v1/${bundle.sha256}.character.json`,
            sha256: bundle.sha256,
            byteLength: bundle.byteLength,
            mediaType: 'application/vnd.pathfinder.character+json' as const,
            characterId,
            characterVersion: 1,
            versionId: `fixture-${bundle.sha256.slice(0, 12)}`,
          }
          await completeCharacterFactoryJobAction(
            {
              tenantId,
              venueId: targetVenueId,
              requestId,
              leaseToken: claim.job.leaseToken!,
              resultPayload: { imported: true, fixture: true },
              actor: human,
              characterSpec: spec,
              assetStorageReference: reference,
            },
            undefined,
            {
              verifyArtifact: async ({ reference: suppliedReference, expectedSpec }) => {
                expect(suppliedReference).toEqual(reference)
                const verifiedSpec = await readCharacterBundle(bundle)
                expect(verifiedSpec).toEqual(expectedSpec)
                return { reference, spec: verifiedSpec }
              },
            },
          )
          const candidate = await db.customCharacter.findUniqueOrThrow({
            where: { id: characterId },
            select: {
              id: true,
              tenantId: true,
              venueId: true,
              status: true,
              version: true,
              revision: true,
              assetStorageReference: true,
              previewStorageReference: true,
              capabilityMetadata: true,
            },
          })
          expect(candidate).toMatchObject({
            status: 'REVIEW',
            tenantId,
            venueId: targetVenueId,
            version: 1,
            revision: 1,
          })
          return { candidate, characterId }
        }

        const submit = async (characterId: string, label: string, targetVenueId = venueId) =>
          submitCharacterCandidateReviewBrief({
            tenantId,
            venueId: targetVenueId,
            characterId,
            brief: `Review imported ${label} candidate.`,
            rationale: `Imported fixture evidence for ${label}.`,
            sourceProvenance: 'IMPORTED_FIXTURE',
            actor: agent,
          })
        const decisionInput = (
          brief: {
            id: string
            candidateVersion: number
            candidateRevision: number
            artifactFingerprint: string
          },
          decision: 'ACCEPT' | 'REJECT' | 'REVISE',
          operationId: string,
        ) => ({
          tenantId,
          venueId,
          briefId: brief.id,
          expectedVersion: brief.candidateVersion,
          expectedRevision: brief.candidateRevision,
          expectedArtifactFingerprint: brief.artifactFingerprint,
          decision,
          operationId,
          ...(decision === 'REVISE' ? { revisionRequest: 'Refine the imported fixture.' } : {}),
          actor: human,
        })

        const accepted = await createCandidate('accepted')
        const firstBrief = await submit(accepted.characterId, 'accepted')
        const replayedBrief = await submit(accepted.characterId, 'accepted')
        expect(firstBrief.replayed).toBe(false)
        expect(replayedBrief).toMatchObject({ replayed: true, brief: { id: firstBrief.brief.id } })
        const operationId = `accept-${suffix}`
        const [firstDecision, replayDecision] = await Promise.all([
          decideCharacterCandidateReview(decisionInput(firstBrief.brief, 'ACCEPT', operationId)),
          decideCharacterCandidateReview(decisionInput(firstBrief.brief, 'ACCEPT', operationId)),
        ])
        expect([firstDecision.replayed, replayDecision.replayed].sort()).toEqual([false, true])
        expect(firstDecision.resultingJob?.id).toBe(replayDecision.resultingJob?.id)
        expect(firstDecision.resultingJob).toMatchObject({ action: 'EXPORT', status: 'QUEUED' })
        const acceptedJobs = await db.characterFactoryJob.findMany({
          where: { tenantId, venueId, requestId: firstDecision.resultingJob!.requestId },
          select: {
            id: true,
            status: true,
            attemptNumber: true,
            requestPayload: true,
            resultPayload: true,
          },
        })
        expect(acceptedJobs).toEqual([
          expect.objectContaining({
            id: firstDecision.resultingJob!.id,
            status: 'QUEUED',
            attemptNumber: 0,
            requestPayload: {
              includeEditableSource: true,
              workflowStage: 'ANIMATION_PREPARATION',
              approvedAppearanceFingerprint: firstBrief.brief.artifactFingerprint,
              motionCapability: 'rigid-source',
              publicationAuthorized: false,
            },
            resultPayload: null,
          }),
        ])
        await expect(
          decideCharacterCandidateReview({
            ...decisionInput(firstBrief.brief, 'REJECT', operationId),
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT' })

        await db.customCharacter.update({
          where: { id: accepted.characterId },
          data: { revision: 2 },
        })
        const historicalReplay = await decideCharacterCandidateReview(
          decisionInput(firstBrief.brief, 'ACCEPT', operationId),
        )
        expect(historicalReplay).toMatchObject({
          replayed: true,
          resultingJob: { id: firstDecision.resultingJob!.id, status: 'QUEUED' },
        })
        expect(
          await readCharacterCandidateReviewBrief({
            tenantId,
            venueId,
            briefId: firstBrief.brief.id,
          }),
        ).toMatchObject({
          current: false,
          decision: { resultingJobId: firstDecision.resultingJob!.id },
        })

        const concurrent = await createCandidate('concurrent')
        const concurrentBrief = await submit(concurrent.characterId, 'concurrent')
        const concurrentResults = await Promise.allSettled([
          decideCharacterCandidateReview(
            decisionInput(concurrentBrief.brief, 'ACCEPT', `concurrent-accept-${suffix}`),
          ),
          decideCharacterCandidateReview(
            decisionInput(concurrentBrief.brief, 'REJECT', `concurrent-reject-${suffix}`),
          ),
        ])
        expect(concurrentResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(concurrentResults.filter((result) => result.status === 'rejected')).toHaveLength(1)
        const rejectedConcurrent = concurrentResults.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        )
        expect(rejectedConcurrent?.reason).toMatchObject({ code: 'CONFLICT' })
        expect(
          await db.characterCandidateReviewDecision.count({
            where: { briefId: concurrentBrief.brief.id },
          }),
        ).toBe(1)
        expect(
          await db.characterFactoryJob.count({
            where: {
              tenantId,
              venueId,
              customCharacterId: concurrent.characterId,
              action: { in: ['EXPORT', 'REVISE'] },
            },
          }),
        ).toBeLessThanOrEqual(1)

        const crossVenueJob = await prepareCharacterFactoryJobAction({
          tenantId,
          venueId,
          requestId: `cross-venue-job-${suffix}`,
          action: 'INSPECT',
          requestPayload: {},
          characterId: concurrent.characterId,
          actor: human,
        })
        const sibling = await createCandidate('sibling', siblingVenueId)
        const siblingBrief = await submit(sibling.characterId, 'sibling', siblingVenueId)
        await expect(
          db.characterCandidateReviewDecision.create({
            data: {
              tenantId,
              venueId: siblingVenueId,
              briefId: siblingBrief.brief.id,
              customCharacterId: sibling.characterId,
              candidateVersion: siblingBrief.brief.candidateVersion,
              candidateRevision: siblingBrief.brief.candidateRevision,
              artifactFingerprint: siblingBrief.brief.artifactFingerprint,
              operationId: `cross-venue-link-${suffix}`,
              requestFingerprint: 'a'.repeat(64),
              decision: 'ACCEPT',
              resultingJobId: crossVenueJob.job.id,
              decidedBy: human.id,
            },
          }),
        ).rejects.toMatchObject({ code: 'P2003' })

        const revised = await createCandidate('revised')
        const reviseBrief = await submit(revised.characterId, 'revised')
        const reviseDecision = await decideCharacterCandidateReview(
          decisionInput(reviseBrief.brief, 'REVISE', `revise-${suffix}`),
        )
        expect(reviseDecision.resultingJob).toMatchObject({ action: 'REVISE', status: 'QUEUED' })

        const rejected = await createCandidate('rejected')
        const rejectBrief = await submit(rejected.characterId, 'rejected')
        const rejectDecision = await decideCharacterCandidateReview(
          decisionInput(rejectBrief.brief, 'REJECT', `reject-${suffix}`),
        )
        expect(rejectDecision).toMatchObject({ resultingJob: null, replayed: false })

        const stale = await createCandidate('stale')
        const staleBrief = await submit(stale.characterId, 'stale')
        await db.customCharacter.update({
          where: { id: stale.characterId },
          data: { revision: 2 },
        })
        await expect(
          decideCharacterCandidateReview(
            decisionInput(staleBrief.brief, 'ACCEPT', `stale-${suffix}`),
          ),
        ).rejects.toMatchObject({ code: 'CONFLICT' })

        const changedArtifact = await createCandidate('changed-artifact')
        const changedArtifactBrief = await submit(changedArtifact.characterId, 'changed-artifact')
        await db.customCharacter.update({
          where: { id: changedArtifact.characterId },
          data: { assetStorageReference: { kind: 'character-bundle-v1', sha256: '1'.repeat(64) } },
        })
        await expect(
          decideCharacterCandidateReview(
            decisionInput(changedArtifactBrief.brief, 'ACCEPT', `artifact-${suffix}`),
          ),
        ).rejects.toMatchObject({ code: 'CONFLICT' })

        const archived = await createCandidate('archived')
        const archivedBrief = await submit(archived.characterId, 'archived')
        await db.customCharacter.update({
          where: { id: archived.characterId },
          data: { status: 'ARCHIVED' },
        })
        await expect(
          decideCharacterCandidateReview(
            decisionInput(archivedBrief.brief, 'ACCEPT', `archived-${suffix}`),
          ),
        ).rejects.toMatchObject({ code: 'CONFLICT' })

        await expect(
          submitCharacterCandidateReviewBrief({
            tenantId: otherTenantId,
            venueId: otherVenueId,
            characterId: accepted.characterId,
            brief: 'Wrong scope.',
            rationale: 'Wrong scope.',
            sourceProvenance: 'IMPORTED_FIXTURE',
            actor: agent,
          }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(
          decideCharacterCandidateReview({
            ...decisionInput(firstBrief.brief, 'ACCEPT', `wrong-venue-${suffix}`),
            venueId: otherVenueId,
          }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(
          decideCharacterCandidateReview({
            ...decisionInput(firstBrief.brief, 'ACCEPT', `agent-${suffix}`),
            actor: agent,
          } as never),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
        expect(await db.venueBotConfiguration.count({ where: { tenantId, venueId } })).toBe(0)
        expect(characterCandidateArtifactFingerprint(accepted.candidate)).toBe(
          firstBrief.brief.artifactFingerprint,
        )
      }),
    45_000,
  )
})
