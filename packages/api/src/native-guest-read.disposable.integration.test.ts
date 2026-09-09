import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'

import type { AnthropicMessagesClient } from '@pathfinder/ai'
import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import type { NativeCoreVisibleState } from '@pathfinder/contracts'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'

vi.mock('@pathfinder/config', () => ({
  env: { OPENAI_API_KEY: 'provider-dark-test-key' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
const analyticsMocks = vi.hoisted(() => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@pathfinder/analytics', () => analyticsMocks)
vi.mock('@pathfinder/jobs', () => ({ enqueueEmbedPlace: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./lib/rate-limit', () => ({ checkRateLimit: vi.fn().mockResolvedValue(true) }))
const embeddingMocks = vi.hoisted(() => ({ queryEmbedding: null as number[] | null }))
vi.mock('./lib/guest-query-embedding', () => ({
  generateGuestQueryEmbedding: vi.fn(
    async (
      _text: string,
      _usageSink: unknown,
      _admissionGuard: unknown,
      _budgetGate: unknown,
      _invocationId: string | undefined,
      onBeforeFirstDispatch: (() => Promise<void>) | undefined,
    ) => {
      await onBeforeFirstDispatch?.()
      return embeddingMocks.queryEmbedding
    },
  ),
}))

import { logger } from '@pathfinder/config'
import {
  applyNativeVenueDeploymentAction,
  acquireEmbeddingWork,
  approveNativeVenueDeploymentAction,
  claimEvaluationRunAttempt,
  createUniversalContentAction,
  createOrReplayEvaluationRun,
  createNativeVenueDeploymentAction,
  createOperationalUpdateAction,
  db,
  expireOperationalUpdateAction,
  finishEvaluationRunAttempt,
  markEvaluationRunQueued,
  projectNativeVenueStateAction,
  publishUniversalContentAction,
  recordNativeDeploymentEvaluationEvidenceAction,
  resolveNativeGuestReadSnapshotAction,
  revertNativeVenueDeploymentAction,
  storeKnowledgeEntryEmbeddingForScope,
  storePlaceEmbeddingForScope,
  updateOperationalUpdateAction,
  withdrawUniversalContentAction,
  claimIntakeUploadVerificationAction,
  recordIntakeUploadPrecheckAction,
  registerVenueMediaAssetAction,
  requestVenueMediaDerivativesAction,
  reviewVenueMediaAssetAction,
  reserveIntakeUploadAction,
  settleIntakeUploadAuthoritativeVerificationAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { nativeGuestReadTenantFlagKey } from '@pathfinder/config/feature-flags'

import type { TRPCContext } from './context'
import { mergeRouters, router } from './core'
import { _setAnthropicClientForTesting, chatRouter } from './routers/chat'
import { adminNativeVenueDeploymentsRouter } from './routers/admin/native-venue-deployments'
import { adminLocationAuthoringRouter } from './routers/admin/location-authoring'
import { adminLocationAvailabilityRouter } from './routers/admin/location-availability'
import { adminLocationConnectionAuthoringRouter } from './routers/admin/location-connection-authoring'
import { locationRouter } from './routers/location'
import { createSafeOperationalMcpRegistry } from './mcp/composition'
import { buildVoiceGroundingContext } from './lib/voice-grounding-context'
import { retrieveGuestKnowledge } from './lib/guest-knowledge-retrieval'
import { projectGuestPlaceIdentity } from './lib/guest-place-identity'

const enabled =
  process.env.RUN_NATIVE_GUEST_READ_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_native_guest_read_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('native guest content read disposable rehearsal', () => {
  const testRouter = router({ chat: chatRouter, admin: adminNativeVenueDeploymentsRouter })
  const visitorRouter = router({
    admin: mergeRouters(
      adminLocationAuthoringRouter,
      adminLocationAvailabilityRouter,
      adminLocationConnectionAuthoringRouter,
    ),
    location: locationRouter,
  })

  afterAll(async () => {
    _setAnthropicClientForTesting(null)
    await db.$disconnect()
  })

  it('refreshes corrected and withdrawn knowledge across a thousand-row public corpus', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-fresh-${suffix}`
      const venueId = `venue-fresh-${suffix}`
      const siblingVenueId = `venue-fresh-sibling-${suffix}`
      const knowledgeId = randomUUID()
      await db.tenant.create({
        data: { id: tenantId, name: 'Fresh grounding fixture', slug: tenantId },
      })
      await db.venue.createMany({
        data: [venueId, siblingVenueId].map((id) => ({
          id,
          tenantId,
          name: id,
          slug: id,
        })),
      })
      await db.venueKnowledgeEntry.createMany({
        data: [
          ...Array.from({ length: 1_000 }, (_, index) => ({
            tenantId,
            venueId,
            title: `Gallery exhibit ${index}`,
            category: 'GENERAL' as const,
            content: `Gallery exhibit information number ${index}.`,
            visibility: 'PUBLIC' as const,
          })),
          {
            id: knowledgeId,
            tenantId,
            venueId,
            title: 'North gallery capacity',
            category: 'GENERAL' as const,
            content: 'The north gallery capacity is 137 visitors.',
            visibility: 'PUBLIC' as const,
            updatedAt: new Date('2020-01-01T00:00:00Z'),
          },
          {
            tenantId,
            venueId: siblingVenueId,
            title: 'North gallery capacity',
            category: 'GENERAL' as const,
            content: 'Sibling venue secret capacity is 999.',
            visibility: 'PUBLIC' as const,
          },
        ],
      })
      const read = (query: string) =>
        buildVoiceGroundingContext({ reader: db as never, tenantId, venueId, query })
      for (const query of ['north gallery capacity', 'aforo galería norte']) {
        const result = await read(query)
        expect(result.context).toContain('137 visitors')
        expect(result.context).not.toContain('999')
        expect(result.sourceIds).toContain(knowledgeId)
        expect(
          result.trace.preOverlayKnowledgeRetrieval.candidateCounts.strict,
        ).toBeLessThanOrEqual(20)
        expect(result.trace.preOverlayKnowledgeRetrieval.candidateCounts.broad).toBeLessThanOrEqual(
          60,
        )
        expect(result.context.length).toBeLessThanOrEqual(12_000)
      }
      const semanticCandidateBeforeCorrection = {
        ...(await db.venueKnowledgeEntry.findUniqueOrThrow({ where: { id: knowledgeId } })),
        distance: 0.01,
      }
      const semanticBeforeCorrection = await retrieveGuestKnowledge({
        reader: db,
        query: 'north gallery capacity',
        tenantId,
        venueId,
        includeSecondLayer: false,
        queryEmbedding: Array(1_536).fill(0),
        semanticSearch: async () => [semanticCandidateBeforeCorrection],
      })
      expect(semanticBeforeCorrection.entries.find(({ id }) => id === knowledgeId)?.content).toBe(
        'The north gallery capacity is 137 visitors.',
      )

      const correctedKnowledge = await db.venueKnowledgeEntry.update({
        where: { id: knowledgeId },
        data: {
          content: 'The north gallery capacity is now 83 visitors.',
        },
      })
      const semanticAfterCorrection = await retrieveGuestKnowledge({
        reader: db,
        query: 'north gallery capacity',
        tenantId,
        venueId,
        includeSecondLayer: false,
        queryEmbedding: Array(1_536).fill(0),
        semanticSearch: async () => [semanticCandidateBeforeCorrection],
      })
      expect(semanticAfterCorrection.entries.find(({ id }) => id === knowledgeId)?.content).toBe(
        'The north gallery capacity is now 83 visitors.',
      )
      expect(JSON.stringify(semanticAfterCorrection.entries)).not.toContain('137 visitors')
      expect(
        semanticAfterCorrection.trace.retrievedSources.find(({ id }) => id === knowledgeId)
          ?.version,
      ).toBe(correctedKnowledge.updatedAt.toISOString())
      const corrected = await read('north gallery capacity')
      expect(corrected.context).toContain('83 visitors')
      expect(corrected.context).not.toContain('137 visitors')
      await db.venueKnowledgeEntry.update({
        where: { id: knowledgeId },
        data: { visibility: 'SECOND_LAYER' },
      })
      const withdrawn = await read('north gallery capacity')
      expect(withdrawn.sourceIds).not.toContain(knowledgeId)
      expect(withdrawn.context).not.toContain('83 visitors')
      expect(withdrawn.context).not.toContain('999')
      expect(withdrawn.provider).toEqual({ called: false, qualityVerified: false })

      const restroomIds = ['public', 'private', 'inactive', 'sibling'].map(
        (kind) => `restroom-${kind}-${suffix}`,
      )
      await db.place.createMany({
        data: restroomIds.map((id, index) => ({
          id,
          tenantId,
          venueId: index === 3 ? siblingVenueId : venueId,
          name: index === 0 ? 'East restroom' : `Restricted restroom ${index}`,
          type: 'ROOM',
          visibility: index === 1 ? 'SECOND_LAYER' : 'PUBLIC',
          isActive: index !== 2,
        })),
      })
      const multilingualPlaceCases = []
      for (const query of ['WC', '厕所在哪里', 'トイレはどこ']) {
        const grounded = await read(query)
        expect(grounded.sourceIds).toEqual([`place:${restroomIds[0]}`])
        expect(grounded.context).toContain('East restroom')
        expect(grounded.provider.called).toBe(false)
        multilingualPlaceCases.push({
          query,
          includedSourceIds: grounded.sourceIds,
          measurements: grounded.measurements,
        })
      }
      process.stdout.write(
        `${JSON.stringify({ multilingualPlaceProof: { version: 'shared-guest-concepts-place-v1', cases: multilingualPlaceCases, excludedControlIds: restroomIds.slice(1), providerCalled: false } })}\n`,
      )

      const publicationActor = {
        type: 'HUMAN' as const,
        id: `publication-owner-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const publishedDraft = await createUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: randomUUID(),
        actor: publicationActor,
        draft: {
          audience: 'PUBLIC',
          evidence: [],
          payload: {
            kind: 'POLICY',
            title: 'Atrium evening access',
            rule: 'Evening visitors enter the atrium through the north doors.',
            appliesTo: [],
          },
        },
      })
      await publishUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: publishedDraft.moduleId,
        revisionId: publishedDraft.revisionId,
        expectedLatestVersion: 1,
        requestId: randomUUID(),
        actor: publicationActor,
      })
      const publishedProjection = await db.venueKnowledgeEntry.findFirstOrThrow({
        where: { tenantId, venueId, contentModuleId: publishedDraft.moduleId },
      })
      const capturedSemanticCandidate = {
        ...publishedProjection,
        distance: 0.01,
      }
      const semanticBeforeWithdrawal = await retrieveGuestKnowledge({
        reader: db,
        query: 'atrium evening access',
        tenantId,
        venueId,
        includeSecondLayer: false,
        queryEmbedding: Array(1_536).fill(0),
        semanticSearch: async () => [capturedSemanticCandidate],
      })
      expect(semanticBeforeWithdrawal.entries.map(({ id }) => id)).toContain(publishedProjection.id)
      await withdrawUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: publishedDraft.moduleId,
        expectedPublishedRevisionId: publishedDraft.revisionId,
        requestId: randomUUID(),
        actor: publicationActor,
      })
      await expect(
        db.venueKnowledgeEntry.findUniqueOrThrow({
          where: { id: publishedProjection.id },
          select: { isEnabled: true },
        }),
      ).resolves.toEqual({ isEnabled: false })
      const semanticAfterWithdrawal = await retrieveGuestKnowledge({
        reader: db,
        query: 'atrium evening access',
        tenantId,
        venueId,
        includeSecondLayer: false,
        queryEmbedding: Array(1_536).fill(0),
        semanticSearch: async () => [capturedSemanticCandidate],
      })
      expect(semanticAfterWithdrawal.entries.map(({ id }) => id)).not.toContain(
        publishedProjection.id,
      )
      expect(semanticAfterWithdrawal.trace.excludedSourceIds).toContain(publishedProjection.id)
    })
  })

  it('keeps one scoped visitor journey current across correction, route reachability, and media withdrawal', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
      const tenantId = `tenant-combined-${suffix}`
      const venueId = `venue-combined-${suffix}`
      const siblingVenueId = `venue-combined-sibling-${suffix}`
      const venueSlug = `combined-${suffix}`
      const actorId = `combined-reviewer-${suffix}`
      const actor = { type: 'HUMAN' as const, id: actorId, role: 'PLATFORM_ADMIN' as const }
      const anonymousToken = randomUUID()
      const placeId = `place-combined-${suffix}`
      const privatePlaceId = `place-private-${suffix}`
      const siblingPlaceId = `place-sibling-${suffix}`
      const originId = randomUUID()
      const reachableId = randomUUID()
      const disconnectedId = randomUUID()

      await db.tenant.create({
        data: { id: tenantId, name: 'Combined guest proof', slug: tenantId },
      })
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
      await db.venue.createMany({
        data: [
          {
            id: venueId,
            tenantId,
            slug: venueSlug,
            name: 'Combined visitor venue',
            chatShowPhotos: true,
          },
          {
            id: siblingVenueId,
            tenantId,
            slug: `sibling-${suffix}`,
            name: 'Combined sibling venue',
          },
        ],
      })
      await db.place.createMany({
        data: [
          {
            id: placeId,
            tenantId,
            venueId,
            name: 'Reviewed Garden',
            type: 'RESTROOM',
            visibility: 'PUBLIC',
            tags: [],
          },
          {
            id: privatePlaceId,
            tenantId,
            venueId,
            name: 'Private Garden',
            type: 'RESTROOM',
            visibility: 'SECOND_LAYER',
            tags: [],
          },
          {
            id: siblingPlaceId,
            tenantId,
            venueId: siblingVenueId,
            name: 'Sibling Garden',
            type: 'RESTROOM',
            visibility: 'PUBLIC',
            tags: [],
          },
        ],
      })
      await db.venueKnowledgeEntry.createMany({
        data: [
          {
            tenantId,
            venueId,
            title: 'Garden status',
            category: 'GENERAL',
            content: 'Reviewed garden information.',
            visibility: 'PUBLIC',
          },
          {
            tenantId,
            venueId,
            title: 'Private garden status',
            category: 'GENERAL',
            content: 'Private internal garden detail.',
            visibility: 'SECOND_LAYER',
          },
          {
            tenantId,
            venueId: siblingVenueId,
            title: 'Sibling garden status',
            category: 'GENERAL',
            content: 'Sibling venue garden detail.',
            visibility: 'PUBLIC',
          },
        ],
      })
      const now = new Date()
      const initialUpdate = await createOperationalUpdateAction({
        tenantId,
        actor,
        schedule: true,
        now,
        fields: {
          venueId,
          placeId,
          updateType: 'GENERAL_NOTICE',
          severity: 'INFO',
          priority: 'HIGH',
          title: 'Garden availability',
          body: 'The reviewed garden is open today.',
          startsAt: new Date(now.getTime() - 60_000),
          expiresAt: new Date(now.getTime() + 60 * 60_000),
        },
      })
      const read = () =>
        buildVoiceGroundingContext({
          reader: db as never,
          tenantId,
          venueId,
          query: 'What is the garden status?',
          asOf: now,
        })
      const beforeCorrection = await read()
      expect(beforeCorrection.context).toContain('open today')
      expect(beforeCorrection.context).not.toContain('Private internal')
      expect(beforeCorrection.context).not.toContain('Sibling venue')
      const correctedUpdate = await updateOperationalUpdateAction({
        tenantId,
        actor,
        id: initialUpdate.update.id,
        expectedUpdatedAt: initialUpdate.update.updatedAt,
        schedule: false,
        now,
        fields: {
          venueId,
          placeId,
          updateType: 'TEMPORARY_CLOSURE',
          severity: 'CLOSURE',
          priority: 'HIGH',
          title: 'Garden availability',
          body: 'The reviewed garden is temporarily closed today.',
          startsAt: new Date(now.getTime() - 60_000),
          expiresAt: new Date(now.getTime() + 60 * 60_000),
        },
      })
      expect(correctedUpdate.update.id).toBe(initialUpdate.update.id)
      expect(correctedUpdate.update.status).toBe('PUBLISHED')
      const afterCorrection = await read()
      expect(afterCorrection.context).toContain('temporarily closed today')
      expect(afterCorrection.context).not.toContain('open today')

      await db.visitorSession.create({ data: { tenantId, venueId, anonymousToken } })
      const admin = visitorRouter.createCaller({
        db,
        headers: new Headers(),
        session: { userId: actorId, activeTenantId: null, role: null, isPlatformAdmin: true },
      }).admin
      const visitor = visitorRouter.createCaller({
        db,
        headers: new Headers(),
        session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
      }).location
      const locationInput = (
        stableKey: string,
        kind: 'ENTRANCE' | 'RESTROOM',
        primaryPlaceId?: string,
      ) => ({
        tenantId,
        venueId,
        stableKey,
        kind,
        displayName: stableKey,
        description: null,
        visibility: 'PUBLIC' as const,
        floorId: null,
        parentLocationId: null,
        ...(primaryPlaceId ? { primaryPlaceId } : {}),
        coordinates: null,
        mapAnchor: null,
        externalMapReference: null,
        accessibilityMetadata: {},
      })
      const origin = await admin.createVenueLocationDraft({
        operationId: originId,
        ...locationInput('reviewed-entrance', 'ENTRANCE'),
      })
      const reachable = await admin.createVenueLocationDraft({
        operationId: reachableId,
        ...locationInput('reviewed-garden', 'RESTROOM', placeId),
      })
      const disconnected = await admin.createVenueLocationDraft({
        operationId: disconnectedId,
        ...locationInput('disconnected-garden', 'RESTROOM', placeId),
      })
      await expect(
        admin.createVenueLocationDraft({
          operationId: randomUUID(),
          ...locationInput('sibling-garden-forbidden', 'RESTROOM', siblingPlaceId),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      for (const location of [origin.location, reachable.location, disconnected.location]) {
        await admin.setVenueLocationAvailability({
          tenantId,
          venueId,
          locationId: location.id,
          expectedUpdatedAt: location.updatedAt,
          active: true,
          reason: 'Activate reviewed combined fixture anchor.',
        })
      }
      const connection = await admin.createVenueLocationConnectionDraft({
        operationId: randomUUID(),
        tenantId,
        venueId,
        fromLocationId: originId,
        toLocationId: reachableId,
        kind: 'WALKWAY',
        bidirectional: true,
        accessible: true,
        directions: 'Use the reviewed garden walkway.',
      })
      await admin.setVenueLocationConnectionAvailability({
        tenantId,
        venueId,
        connectionId: connection.connection.id,
        expectedUpdatedAt: connection.connection.updatedAt,
        active: true,
        reason: 'Activate reviewed combined fixture connection.',
      })
      const routeInput = {
        venueId,
        anonymousToken,
        fromLocationId: originId,
        kind: 'RESTROOM' as const,
        accessibleOnly: true,
      }
      await expect(visitor.reachableDestination(routeInput)).resolves.toEqual({
        destination: null,
        ranking: null,
      })
      await expect(
        visitor.route({
          venueId,
          anonymousToken,
          fromLocationId: originId,
          toLocationId: reachableId,
          accessibleOnly: true,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const expiredClosure = await expireOperationalUpdateAction({
        tenantId,
        actor,
        id: correctedUpdate.update.id,
        expectedUpdatedAt: correctedUpdate.update.updatedAt,
        now,
      })
      expect(expiredClosure.update.isActive).toBe(false)
      await expect(visitor.reachableDestination(routeInput)).resolves.toMatchObject({
        destination: { id: reachableId },
        ranking: { reachableOptionCount: 1 },
      })
      await expect(
        visitor.route({
          venueId,
          anonymousToken,
          fromLocationId: originId,
          toLocationId: disconnectedId,
          accessibleOnly: true,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      const assetId = randomUUID()
      const sourceGeneration = randomUUID()
      const sourceSha256 = 'c'.repeat(64)
      const reserved = await reserveIntakeUploadAction({
        tenantId,
        venueId,
        actor,
        request: {
          requestId: randomUUID(),
          displayName: 'Combined garden image metadata',
          fileName: 'garden.png',
          mimeType: 'image/png',
          category: 'PHOTO',
          byteSize: 64,
          sha256: sourceSha256,
        },
        trustedObjectIdentity: {
          objectKey: `intake-quarantine/${randomUUID()}`,
          objectGeneration: sourceGeneration,
        },
      })
      const precheckClaimId = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: precheckClaimId,
      })
      await recordIntakeUploadPrecheckAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: precheckClaimId,
        verified: {
          objectGeneration: sourceGeneration,
          storageVersionId: 'combined-source-version',
          mimeType: 'image/png',
          byteSize: 64,
          sha256: sourceSha256,
        },
        evidence: {
          engine: 'combined-precheck',
          engineVersion: '1',
          verdictHash: createHash('sha256').update(`combined-precheck:${suffix}`).digest('hex'),
          computedByteSize: 64,
          computedSha256: sourceSha256,
        },
      })
      const malwareClaimId = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: malwareClaimId,
      })
      await settleIntakeUploadAuthoritativeVerificationAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: malwareClaimId,
        malware: {
          verdict: 'CLEAN',
          engine: 'combined-malware',
          engineVersion: '1',
          verdictHash: createHash('sha256').update(`combined-malware:${suffix}`).digest('hex'),
          computedByteSize: 64,
          computedSha256: sourceSha256,
        },
      })
      await registerVenueMediaAssetAction({
        db,
        actor,
        registration: {
          tenantId,
          venueId,
          assetId,
          intakeUploadId: reserved.upload.id,
          kind: 'IMAGE',
          semanticDescription: 'Reviewed Garden image metadata.',
          depictedSubjects: ['Reviewed Garden'],
          altText: 'Reviewed garden entrance',
          sourceName: 'Combined fixture',
          sourceUrl: null,
          importance: 'PRIMARY',
          linkedPlaceIds: [placeId],
          linkedKnowledgeEntryIds: [],
        },
      })
      const approval = await reviewVenueMediaAssetAction({
        db,
        actor,
        review: {
          tenantId,
          venueId,
          assetId,
          requestId: randomUUID(),
          expectedLatestSequence: 0,
          action: 'APPROVE_CONTENT_USE',
          rightsBasis: 'VENUE_OWNED',
          rightsStatement: 'Disposable combined fixture metadata.',
          rightsEvidenceSourceId: 'combined-fixture',
        },
      })
      const requested = await requestVenueMediaDerivativesAction({
        db,
        actor,
        request: {
          tenantId,
          venueId,
          assetId,
          requestId: randomUUID(),
          expectedLatestReviewSequence: approval.sequence,
          variants: ['CARD'],
        },
      })
      const derivativeId = requested.items[0]!.derivativeId
      await expect(
        db.venueMediaDerivative.updateMany({
          where: { id: derivativeId, tenantId, venueId, assetId, status: 'PENDING' },
          data: {
            status: 'READY',
            objectKey: `visitor-media/${suffix}.webp`,
            storageVersionId: 'combined-derivative-version',
            mimeType: 'image/webp',
            width: 768,
            height: 480,
            byteSize: 64,
            sha256: 'd'.repeat(64),
            completedAt: new Date(),
          },
        }),
      ).resolves.toMatchObject({ count: 1 })
      await expect(visitor.reachableDestination(routeInput)).resolves.toMatchObject({
        destination: {
          id: reachableId,
          media: { photoUrl: `/api/venue-media/${derivativeId}?venue=${venueSlug}` },
        },
      })
      const voiceMediaInput = {
        reader: db as never,
        tenantId,
        venueId,
        query: 'Tell me about the Reviewed Garden.',
        mediaPolicy: { venueSlug, showPhotos: true, showLinks: true },
      }
      const approvedVoiceMedia = await buildVoiceGroundingContext(voiceMediaInput)
      const mediaSourceId = `media:${derivativeId}:review:${approval.sequence}`
      expect(approvedVoiceMedia.context).toContain('Reviewed garden entrance')
      expect(approvedVoiceMedia.context).toContain('SOURCE CREDIT: Combined fixture')
      expect(approvedVoiceMedia.sourceIds).toContain(mediaSourceId)
      expect(approvedVoiceMedia.context).not.toContain('/api/venue-media/')
      expect(approvedVoiceMedia.provider.called).toBe(false)
      const disabledVoiceMedia = await buildVoiceGroundingContext({
        ...voiceMediaInput,
        mediaPolicy: { ...voiceMediaInput.mediaPolicy, showPhotos: false },
      })
      expect(disabledVoiceMedia.sourceIds).not.toContain(mediaSourceId)
      // Mutate visibility after the public place read but before the media read.
      // The actual derivative relation predicate must exclude the now-private link.
      let visibilityChangedBeforeMediaRead = false
      const privateRaceVoiceMedia = await buildVoiceGroundingContext({
        ...voiceMediaInput,
        reader: {
          venueKnowledgeEntry: db.venueKnowledgeEntry,
          place: db.place,
          operationalUpdate: db.operationalUpdate,
          venueMediaDerivative: {
            findMany: async (args: Parameters<typeof db.venueMediaDerivative.findMany>[0]) => {
              visibilityChangedBeforeMediaRead = true
              await db.place.update({
                where: { id: placeId },
                data: { visibility: 'SECOND_LAYER' },
              })
              return db.venueMediaDerivative.findMany(args)
            },
          },
        } as never,
      })
      expect(visibilityChangedBeforeMediaRead).toBe(true)
      expect(privateRaceVoiceMedia.sourceIds).not.toContain(mediaSourceId)
      expect(privateRaceVoiceMedia.context).not.toContain('Reviewed garden entrance')
      await db.place.update({ where: { id: placeId }, data: { visibility: 'SECOND_LAYER' } })
      const privateBoundMedia = await visitor.reachableDestination(routeInput)
      expect(privateBoundMedia.destination).toMatchObject({ id: reachableId })
      expect(privateBoundMedia.destination).not.toHaveProperty('media')
      await db.place.update({ where: { id: placeId }, data: { visibility: 'PUBLIC' } })
      await reviewVenueMediaAssetAction({
        db,
        actor,
        review: {
          tenantId,
          venueId,
          assetId,
          requestId: randomUUID(),
          expectedLatestSequence: approval.sequence,
          action: 'WITHDRAW_CONTENT_USE',
          reason: 'Withdraw combined fixture media.',
        },
      })
      const afterWithdrawal = await visitor.reachableDestination(routeInput)
      expect(afterWithdrawal.destination).toMatchObject({ id: reachableId })
      expect(afterWithdrawal.destination).not.toHaveProperty('media')
      const withdrawnVoiceMedia = await buildVoiceGroundingContext(voiceMediaInput)
      expect(withdrawnVoiceMedia.sourceIds).not.toContain(mediaSourceId)
      expect(withdrawnVoiceMedia.context).not.toContain('Reviewed garden entrance')
      process.stdout.write(
        `${JSON.stringify({ proof: 'combined-guest-read-service-boundary-v1', tenantId, venueId, controls: ['public-correction-current-next-read', 'same-venue-approved-and-withdrawn-media', 'reachable-reviewed-route', 'disconnected-route-not-fabricated', 'private-and-sibling-content-excluded', 'private-place-media-withheld', 'sibling-place-route-anchor-rejected'], limitations: ['tenant-scoped read-service and public-router boundary; fixture seeding uses an explicit isolation bypass, not a tenant-middleware proof', 'not browser or provider E2E', 'synthetic metadata only; no media bytes'] })}\n`,
      )
    })
  })

  it('rehearses active, dark, authorization, fallback, isolation, and kill-switch behavior', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-guestread-${suffix}`
      const controlTenantId = `tenant-guestread-control-${suffix}`
      const venueId = `venue-guestread-${suffix}`
      const controlVenueId = `venue-guestread-control-${suffix}`
      const publicPlaceId = `place-public-${suffix}`
      const employeePlaceId = `place-employee-${suffix}`
      const publicKnowledgeId = randomUUID()
      const employeeKnowledgeId = randomUUID()
      const secondLayerKey = randomUUID()
      const actor = {
        type: 'HUMAN' as const,
        role: 'PLATFORM_ADMIN' as const,
        id: 'disposable-guestread-operator',
      }

      await db.tenant.createMany({
        data: [
          { id: tenantId, name: 'Disposable guest-read tenant', slug: tenantId },
          {
            id: controlTenantId,
            name: 'Disposable guest-read control tenant',
            slug: controlTenantId,
          },
        ],
      })
      await db.venue.createMany({
        data: [
          {
            id: venueId,
            tenantId,
            name: 'Native guest-read venue',
            slug: venueId,
            guideMode: 'non_location',
            secondLayerEnabled: true,
            secondLayerAccessKey: secondLayerKey,
          },
          {
            id: controlVenueId,
            tenantId: controlTenantId,
            name: 'Legacy control venue',
            slug: controlVenueId,
            guideMode: 'non_location',
          },
        ],
      })
      await db.place.createMany({
        data: [
          {
            id: publicPlaceId,
            tenantId,
            venueId,
            name: 'Native Public Gallery',
            shortDescription: 'Public native release content.',
            type: 'EXHIBIT',
            visibility: 'PUBLIC',
            importanceScore: 100,
            tags: ['public'],
          },
          {
            id: employeePlaceId,
            tenantId,
            venueId,
            name: 'Native Staff Room',
            shortDescription: 'Second-layer native release content.',
            type: 'ROOM',
            visibility: 'SECOND_LAYER',
            importanceScore: 90,
            tags: ['employee'],
          },
          {
            id: `place-control-${suffix}`,
            tenantId: controlTenantId,
            venueId: controlVenueId,
            name: 'Legacy Control Gallery',
            shortDescription: 'Control venue compatibility content.',
            type: 'EXHIBIT',
            visibility: 'PUBLIC',
            importanceScore: 100,
            tags: ['control'],
          },
        ],
      })
      const firstFloorId = randomUUID()
      const secondFloorId = randomUUID()
      const firstCaseId = `case-12-first-${suffix}`
      const secondCaseId = `case-12-second-${suffix}`
      const privateCaseId = `case-12-private-${suffix}`
      const controlCaseId = `case-12-control-${suffix}`
      await db.place.createMany({
        data: [
          ...Array.from({ length: 7 }, (_, index) => ({
            id: `case-pressure-${index}-${suffix}`,
            tenantId,
            venueId,
            name: `Unrelated Exhibit ${index + 1}`,
            shortDescription: 'Tell me about Case 12 display details.',
            type: 'EXHIBIT' as const,
            visibility: 'PUBLIC' as const,
            isActive: true,
            importanceScore: 90 - index,
          })),
          {
            id: firstCaseId,
            tenantId,
            venueId,
            name: 'Case 12',
            type: 'EXHIBIT',
            visibility: 'PUBLIC',
            isActive: true,
            importanceScore: 100,
          },
          {
            id: secondCaseId,
            tenantId,
            venueId,
            name: 'Case 12',
            type: 'EXHIBIT',
            visibility: 'PUBLIC',
            isActive: true,
            importanceScore: 1,
          },
          {
            id: privateCaseId,
            tenantId,
            venueId,
            name: 'Case 12',
            shortDescription: 'PRIVATE_CASE_12_SENTINEL',
            type: 'EXHIBIT',
            visibility: 'SECOND_LAYER',
          },
          {
            id: controlCaseId,
            tenantId: controlTenantId,
            venueId: controlVenueId,
            name: 'Case 12',
            shortDescription: 'CONTROL_CASE_12_SENTINEL',
            type: 'EXHIBIT',
            visibility: 'PUBLIC',
          },
        ],
      })
      await db.venueFloor.createMany({
        data: [
          { id: firstFloorId, tenantId, venueId, stableKey: 'first-floor', name: 'First floor' },
          { id: secondFloorId, tenantId, venueId, stableKey: 'second-floor', name: 'Second floor' },
        ],
      })
      await db.venueLocation.createMany({
        data: [
          {
            tenantId,
            venueId,
            floorId: firstFloorId,
            primaryPlaceId: firstCaseId,
            stableKey: `case-12-first-${suffix}`,
            kind: 'EXHIBIT',
            displayName: 'First floor east gallery',
            verifiedAt: new Date(),
            verifiedBy: 'disposable-guest-read',
          },
          {
            tenantId,
            venueId,
            floorId: secondFloorId,
            primaryPlaceId: secondCaseId,
            stableKey: `case-12-second-${suffix}`,
            kind: 'EXHIBIT',
            displayName: 'Second floor west gallery',
            verifiedAt: new Date(),
            verifiedBy: 'disposable-guest-read',
          },
        ],
      })
      const duplicateCaseIdentity = await projectGuestPlaceIdentity({
        reader: db,
        query: 'Tell me about Case 12',
        tenantId,
        venueId,
        includeSecondLayer: false,
        places: [
          { id: firstCaseId, name: 'Case 12', areaName: null },
          { id: secondCaseId, name: 'Case 12', areaName: null },
        ],
      })
      expect(duplicateCaseIdentity).toMatchObject({
        ambiguity: {
          requestedName: 'Case 12',
          candidates: [
            { location: 'First floor east gallery', floor: 'First floor' },
            { location: 'Second floor west gallery', floor: 'Second floor' },
          ],
        },
        places: [
          { location: 'First floor east gallery', floor: 'First floor' },
          { location: 'Second floor west gallery', floor: 'Second floor' },
        ],
      })
      const narrowedCaseIdentity = await projectGuestPlaceIdentity({
        reader: db,
        query: 'Tell me about Case 12 on the first floor',
        tenantId,
        venueId,
        includeSecondLayer: false,
        places: [
          { id: firstCaseId, name: 'Case 12', areaName: null },
          { id: secondCaseId, name: 'Case 12', areaName: null },
        ],
      })
      expect(narrowedCaseIdentity).toMatchObject({
        ambiguity: null,
        places: [
          { location: 'First floor east gallery', floor: 'First floor' },
          { location: 'Second floor west gallery', floor: 'Second floor' },
        ],
      })
      const duplicateCaseVoice = await buildVoiceGroundingContext({
        reader: db as never,
        tenantId,
        venueId,
        query: 'Tell me about Case 12',
      })
      expect(duplicateCaseVoice.identityClarificationRequired).toBe(true)
      expect(duplicateCaseVoice.context).toContain('Case 12 — First floor')
      expect(duplicateCaseVoice.context).toContain('Case 12 — Second floor')
      expect(duplicateCaseVoice.sourceIds).toEqual(
        expect.arrayContaining([`place:${firstCaseId}`, `place:${secondCaseId}`]),
      )
      // Seven higher-ranked lexical distractors exhaust the initial eight-place page;
      // the duplicate expansion must still surface the low-ranked second Case 12.
      expect(duplicateCaseVoice.sourceIds).toContain(`place:${secondCaseId}`)
      expect(duplicateCaseVoice.sourceIds).not.toContain(`place:${privateCaseId}`)
      expect(duplicateCaseVoice.sourceIds).not.toContain(`place:${controlCaseId}`)
      expect(duplicateCaseVoice.context).not.toContain('PRIVATE_CASE_12_SENTINEL')
      expect(duplicateCaseVoice.context).not.toContain('CONTROL_CASE_12_SENTINEL')

      const firstFloorCaseVoice = await buildVoiceGroundingContext({
        reader: db as never,
        tenantId,
        venueId,
        query: 'Tell me about Case 12 on the first floor',
      })
      expect(firstFloorCaseVoice.identityClarificationRequired).toBe(false)
      expect(firstFloorCaseVoice.context).not.toContain('IDENTITY CLARIFICATION DATA')
      expect(firstFloorCaseVoice.context).toContain('First floor')
      await db.venueKnowledgeEntry.createMany({
        data: [
          {
            id: publicKnowledgeId,
            tenantId,
            venueId,
            title: 'Native Public Arrival Guide',
            category: 'ACCESSIBILITY',
            content: 'Public semantic native knowledge says to use the east entrance.',
            visibility: 'PUBLIC',
          },
          {
            id: employeeKnowledgeId,
            tenantId,
            venueId,
            title: 'Native Staff Arrival Procedure',
            category: 'OPERATIONS',
            content: 'Second-layer semantic native knowledge says to use the service entrance.',
            visibility: 'SECOND_LAYER',
          },
        ],
      })

      const projected = await projectNativeVenueStateAction(db, { tenantId, venueId })
      const projectedState = projected.state as NativeCoreVisibleState
      const desiredState = {
        ...projectedState,
        places: projectedState.places.map((item) =>
          item.id === publicPlaceId
            ? { ...item, shortDescription: 'Native override: public gallery arrival point.' }
            : item,
        ),
        knowledgeEntries: projectedState.knowledgeEntries.map((item) =>
          item.id === publicKnowledgeId
            ? { ...item, content: 'Native override: use the east entrance.' }
            : item,
        ),
      }
      const release = await createNativeVenueDeploymentAction(
        {
          tenantId,
          venueId,
          actor,
          manifest: {
            schemaVersion: 2,
            packageType: 'FULL',
            materializationProfile: 'NATIVE_CORE_V1',
            manifestId: randomUUID(),
            idempotencyKey: randomUUID(),
            venueRef: venueId,
            provenance: {
              sourceIds: ['synthetic:native-guest-read-rehearsal'],
              evidenceIds: [],
              createdAt: new Date().toISOString(),
              createdBy: { kind: 'OPERATOR', actorRef: actor.id },
            },
            venue: projected.state.venue,
            venueBotConfiguration: projected.state.venueBotConfiguration,
            places: desiredState.places,
            knowledgeEntries: desiredState.knowledgeEntries,
            generalizedModules: projected.state.generalizedModules,
            items: [],
            assets: [],
            capabilityOverrides: [],
            modelReferences: [],
            evaluation: {
              status: 'NOT_REQUIRED_FOR_CORE_PROFILE',
              policyVersion: 'native-core-v1',
            },
            baseState: { stateHash: projected.stateHash, ...projected.universe },
          },
        },
        db,
      )

      const evalCase = await db.evalCase.create({
        data: {
          tenantId,
          venueId,
          caseKey: `native-guestread-${suffix}`,
          revision: 1,
          schemaVersion: 'fixture-v1',
          category: 'authorization-and-grounding',
          caseHash: 'a'.repeat(64),
          caseSnapshot: { prompt: 'Describe the authorized venue content.' },
          createdBy: actor.id,
          sourceType: 'SYNTHETIC',
          sourceRef: `fixture:${suffix}`,
        },
      })
      const caseManifest = [
        { caseId: evalCase.id, revision: evalCase.revision, caseHash: evalCase.caseHash },
      ]
      const runId = randomUUID()
      const { run } = await createOrReplayEvaluationRun({
        db,
        runId,
        identity: {
          tenantId,
          venueId,
          idempotencyKey: `native-guestread-eval-${suffix}`,
          caseManifest,
          promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
          promptContractHash: GUEST_CHAT_PROMPT_CONTRACT_HASH,
          packageSnapshotRef: `native-core-v1:${release.id}`,
          packageSnapshotHash: release.manifestHash,
          contentSnapshotKind: 'NATIVE_CORE_V1',
          contentSnapshotRef: release.id,
          contentSnapshotVersion: 1n,
          contentSnapshotHash: release.desiredStateHash,
          modelProvider: 'deterministic-in-process',
          modelName: 'provider-dark-fixture',
          modelSnapshot: { provider: 'deterministic-in-process', model: 'provider-dark-fixture' },
          runConfigSnapshot: {
            version: 'pathfinder-native-evaluation-run-config-v1',
            maximumCases: 1,
            requestedCases: 1,
            contentSnapshotSchemaVersion: 'pathfinder-native-evaluation-content-v1',
            contentComponentCounts: {
              places: desiredState.places.length,
              knowledgeEntries: desiredState.knowledgeEntries.length,
              generalizedModules: projected.state.generalizedModules.length,
            },
            contentSnapshot: {
              version: 'pathfinder-native-evaluation-content-v1',
              tenantId,
              venueId,
              releaseId: release.id,
              state: JSON.parse(JSON.stringify(desiredState)) as Prisma.InputJsonValue,
            },
          },
          declaredBudgetCeilingE8Usd: 0n,
          createdBy: actor.id,
          triggerType: 'DISPOSABLE_REHEARSAL',
        },
      })
      const runScope = {
        runId: run.id,
        tenantId,
        venueId,
        runIdentityHash: run.identityHash,
      }
      expect(await markEvaluationRunQueued(runScope)).toBe(true)
      const claim = await claimEvaluationRunAttempt({
        ...runScope,
        attemptNumber: 1,
        maxAttempts: 1,
      })
      expect(claim.state).toBe('acquired')
      if (claim.state !== 'acquired') throw new Error('Disposable evaluation run was not acquired')
      await db.evalResult.create({
        data: {
          tenantId,
          venueId,
          runId: run.id,
          runIdentityHash: run.identityHash,
          caseId: evalCase.id,
          caseRevision: evalCase.revision,
          caseHash: evalCase.caseHash,
          outcome: 'SCORED',
          observationHash: 'b'.repeat(64),
          observationSnapshot: { answer: 'Deterministic provider-dark result.' },
          checksSnapshot: [{ check: 'grounding', passed: true }],
          passed: true,
          passedChecks: 1,
          totalChecks: 1,
          latencyMs: 1,
          costE8Usd: 0n,
        },
      })
      expect(
        await finishEvaluationRunAttempt({
          ...runScope,
          attemptNumber: claim.attemptNumber,
          leaseToken: claim.leaseToken,
          outcome: 'COMPLETED',
        }),
      ).toBe(true)
      const evidence = await recordNativeDeploymentEvaluationEvidenceAction(
        {
          tenantId,
          venueId,
          releaseId: release.id,
          runId: run.id,
          expectedRunIdentityHash: run.identityHash,
          operationId: randomUUID(),
          actor,
        },
        db,
      )

      // Evaluation evidence does not grant publication authority. The exact DRAFT cannot apply
      // until a human platform administrator records a separate approval command.
      await expect(
        applyNativeVenueDeploymentAction(
          {
            tenantId,
            venueId,
            releaseId: release.id,
            commandId: randomUUID(),
            expectedUpdatedAt: release.updatedAt.toISOString(),
            actor,
          },
          db,
        ),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Release apply state changed.',
      })
      await expect(
        db.nativeVenueDeploymentHead.findUnique({
          where: { tenantId_venueId: { tenantId, venueId } },
        }),
      ).resolves.toBeNull()

      const approved = (await approveNativeVenueDeploymentAction(
        {
          tenantId,
          venueId,
          releaseId: release.id,
          commandId: randomUUID(),
          expectedUpdatedAt: release.updatedAt.toISOString(),
          actor,
        },
        db,
      )) as { updatedAt: string }
      const applyInput = {
        tenantId,
        venueId,
        releaseId: release.id,
        commandId: randomUUID(),
        expectedUpdatedAt: approved.updatedAt,
        actor,
      }
      const applied = (await applyNativeVenueDeploymentAction(applyInput, db)) as {
        status: 'APPLIED'
        updatedAt: string
        head: { releaseId: string; stateHash: string; revision: number }
      }
      expect(applied).toMatchObject({
        status: 'APPLIED',
        head: { releaseId: release.id, stateHash: release.desiredStateHash, revision: 1 },
      })
      await expect(applyNativeVenueDeploymentAction(applyInput, db)).resolves.toEqual(applied)
      await expect(
        db.nativeVenueDeploymentCommand.count({
          where: { tenantId, venueId, releaseId: release.id, kind: 'APPLY' },
        }),
      ).resolves.toBe(1)

      const semanticEmbedding = Array(1_536).fill(0)
      semanticEmbedding[0] = 1
      const storePlaceEmbedding = async (placeId: string) => {
        const place = await db.place.findFirstOrThrow({ where: { id: placeId, tenantId, venueId } })
        const leaseToken = randomUUID()
        const claim = await acquireEmbeddingWork({
          tenantId,
          venueId,
          entityType: 'PLACE',
          entityId: place.id,
          contentUpdatedAt: place.updatedAt,
          sourceHash: createHash('sha256')
            .update(
              [
                place.name,
                place.type,
                place.shortDescription ?? '',
                place.longDescription ?? '',
              ].join('. '),
            )
            .digest('hex'),
          embeddingProfile: 'openai:text-embedding-3-small:1536',
          leaseToken,
        })
        if (claim.state !== 'acquired')
          throw new Error(`Place embedding was not acquired: ${claim.state}`)
        await expect(
          storePlaceEmbeddingForScope({
            placeId: place.id,
            tenantId,
            venueId,
            contentUpdatedAt: place.updatedAt,
            source: {
              name: place.name,
              type: place.type,
              itemType: place.itemType,
              shortDescription: place.shortDescription,
              longDescription: place.longDescription,
              tags: place.tags,
              areaName: place.areaName,
              hours: place.hours,
              isActive: place.isActive,
            },
            embedding: semanticEmbedding,
            claimId: claim.claimId,
            leaseToken,
          }),
        ).resolves.toEqual({ claimCompleted: true, stored: true })
      }
      const storeKnowledgeEmbedding = async (entryId: string) => {
        const entry = await db.venueKnowledgeEntry.findFirstOrThrow({
          where: { id: entryId, tenantId, venueId },
        })
        const leaseToken = randomUUID()
        const claim = await acquireEmbeddingWork({
          tenantId,
          venueId,
          entityType: 'KNOWLEDGE_ENTRY',
          entityId: entry.id,
          contentUpdatedAt: entry.updatedAt,
          sourceHash: createHash('sha256')
            .update([entry.title, entry.category, entry.content].join('. '))
            .digest('hex'),
          embeddingProfile: 'openai:text-embedding-3-small:1536',
          leaseToken,
        })
        if (claim.state !== 'acquired')
          throw new Error(`Knowledge embedding was not acquired: ${claim.state}`)
        await expect(
          storeKnowledgeEntryEmbeddingForScope({
            entryId: entry.id,
            tenantId,
            venueId,
            contentUpdatedAt: entry.updatedAt,
            source: {
              title: entry.title,
              category: entry.category,
              content: entry.content,
              isEnabled: entry.isEnabled,
            },
            embedding: semanticEmbedding,
            claimId: claim.claimId,
            leaseToken,
          }),
        ).resolves.toEqual({ claimCompleted: true, stored: true })
      }
      await Promise.all([
        storePlaceEmbedding(publicPlaceId),
        storePlaceEmbedding(employeePlaceId),
        storeKnowledgeEmbedding(publicKnowledgeId),
        storeKnowledgeEmbedding(employeeKnowledgeId),
      ])

      const policy = (mode: 'DARK' | 'ACTIVE') => ({
        schemaVersion: 1,
        mode,
        venueId,
        targetReleaseId: release.id,
        evaluationEvidenceId: evidence.id,
        qualityPolicyRef: 'policy://disposable-quality-proof',
        rollbackRehearsalRef: 'evidence://this-disposable-rehearsal',
        productionApprovalRef: null,
      })
      await db.tenantFeatureFlag.create({
        data: {
          tenantId,
          flagKey: nativeGuestReadTenantFlagKey(venueId),
          enabled: true,
          metadata: policy('ACTIVE'),
          setBy: actor.id,
        },
      })

      // Voice uses the same exact applied native snapshot while querying the
      // current scoped relational indexes on every factual turn.
      const now = new Date()
      await db.operationalUpdate.createMany({
        data: [
          {
            id: `update-public-${suffix}`,
            tenantId,
            venueId,
            severity: 'INFO',
            priority: 'HIGH',
            title: 'Arrival closure',
            body: 'The west entrance is closed today.',
            startsAt: new Date(now.getTime() - 60_000),
            expiresAt: new Date(now.getTime() + 60_000),
            status: 'PUBLISHED',
            isActive: true,
            createdBy: actor.id,
            publishedBy: actor.id,
            publishedAt: now,
          },
          {
            id: `update-internal-${suffix}`,
            tenantId,
            venueId,
            placeId: employeePlaceId,
            severity: 'INFO',
            title: 'Staff arrival secret',
            body: 'Internal route only.',
            startsAt: new Date(now.getTime() - 60_000),
            expiresAt: new Date(now.getTime() + 60_000),
            status: 'PUBLISHED',
            isActive: true,
            createdBy: actor.id,
            publishedBy: actor.id,
            publishedAt: now,
          },
          {
            id: `update-expired-${suffix}`,
            tenantId,
            venueId,
            severity: 'INFO',
            title: 'Expired arrival notice',
            body: 'Obsolete route.',
            startsAt: new Date(now.getTime() - 120_000),
            expiresAt: new Date(now.getTime() - 60_000),
            status: 'PUBLISHED',
            isActive: true,
            createdBy: actor.id,
            publishedBy: actor.id,
            publishedAt: now,
          },
        ],
      })
      const voiceGrounding = await buildVoiceGroundingContext({
        reader: db as never,
        tenantId,
        venueId,
        query: 'What is the native public arrival gallery update?',
        asOf: now,
        nativeSnapshot: await resolveNativeGuestReadSnapshotAction({
          client: db,
          tenantId,
          venueId,
        }),
      })
      expect(voiceGrounding.context).toContain('Native override: use the east entrance.')
      expect(voiceGrounding.context).toContain('Native Public Gallery')
      expect(voiceGrounding.context).toContain('Native override: public gallery arrival point.')
      expect(voiceGrounding.context).toContain('west entrance is closed today')
      expect(voiceGrounding.context).not.toContain('Public semantic native knowledge says')
      expect(voiceGrounding.context).not.toContain('Staff arrival secret')
      expect(voiceGrounding.context).not.toContain('Expired arrival notice')
      expect(voiceGrounding.sourceIds).toContain(`update:update-public-${suffix}`)
      expect(voiceGrounding.sourceIds).not.toContain(`update:update-internal-${suffix}`)
      expect(voiceGrounding.sourceIds).not.toContain(`update:update-expired-${suffix}`)
      expect(voiceGrounding.sourceIds).not.toContain(employeeKnowledgeId)
      expect(voiceGrounding.sourceIds).not.toContain(`place:${employeePlaceId}`)
      expect(voiceGrounding.provider.called).toBe(false)
      expect(voiceGrounding.nativeProjection).toMatchObject({
        path: 'NATIVE',
        reason: 'NATIVE_READY',
        releaseId: release.id,
        stateHash: release.desiredStateHash,
      })
      expect(voiceGrounding.trace.finalIncludedSourceIds).toEqual(voiceGrounding.sourceIds)

      const spanishVoiceGrounding = await buildVoiceGroundingContext({
        reader: db as never,
        tenantId,
        venueId,
        query: '¿Qué debo saber sobre la llegada a la galería pública?',
        asOf: now,
        nativeSnapshot: await resolveNativeGuestReadSnapshotAction({
          client: db,
          tenantId,
          venueId,
        }),
      })
      expect(spanishVoiceGrounding.sourceIds).toContain(publicKnowledgeId)
      expect(spanishVoiceGrounding.context).toContain('Native override: use the east entrance.')
      expect(spanishVoiceGrounding.context).toContain('west entrance is closed today')
      expect(spanishVoiceGrounding.context).not.toContain('Public semantic native knowledge says')
      expect(spanishVoiceGrounding.context).not.toContain('Staff arrival secret')
      expect(spanishVoiceGrounding.context).not.toContain('Expired arrival notice')
      expect(spanishVoiceGrounding.provider).toEqual({ called: false, qualityVerified: false })
      expect(spanishVoiceGrounding.sourceIds).not.toContain(employeeKnowledgeId)
      expect(spanishVoiceGrounding.sourceIds).not.toContain(`place:${employeePlaceId}`)

      const operationalCorpus = await db.operationalUpdate.findMany({
        where: { tenantId, venueId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          placeId: true,
          title: true,
          body: true,
          startsAt: true,
          expiresAt: true,
          status: true,
          isActive: true,
        },
      })
      const holdoutIdentity = {
        version: 'native-guest-integrated-visitor-holdout-v1',
        corpus: {
          releaseId: release.id,
          manifestHash: release.manifestHash,
          desiredStateHash: release.desiredStateHash,
          operationalUpdatesHash: createHash('sha256')
            .update(JSON.stringify(operationalCorpus))
            .digest('hex'),
          asOf: now.toISOString(),
        },
        configuration: {
          evaluationRunIdentityHash: run.identityHash,
          runConfigVersion: 'pathfinder-native-evaluation-run-config-v1',
          contentSnapshotVersion: 'pathfinder-native-evaluation-content-v1',
        },
        prompt: {
          version: GUEST_CHAT_PROMPT_VERSION,
          hash: GUEST_CHAT_PROMPT_CONTRACT_HASH,
        },
      }
      const holdoutResult = {
        ...holdoutIdentity,
        identityHash: createHash('sha256').update(JSON.stringify(holdoutIdentity)).digest('hex'),
        cases: [
          {
            id: 'english-current-correction-expiry',
            query: 'What is the native public arrival gallery update?',
            retrievedSourceIds: voiceGrounding.retrievedSourceIds,
            includedSourceIds: voiceGrounding.sourceIds,
            omittedSourceIds: voiceGrounding.omittedSourceIds,
            exclusions: [
              { sourceId: employeeKnowledgeId, reason: 'second-layer-not-public' },
              { sourceId: `update:update-internal-${suffix}`, reason: 'private-place-update' },
              { sourceId: `update:update-expired-${suffix}`, reason: 'expired-before-as-of' },
            ],
            knowledgeRetrieval: voiceGrounding.trace.preOverlayKnowledgeRetrieval,
            measurements: voiceGrounding.measurements,
            assertions: {
              correctedNativeValueIncluded: true,
              replacedLegacyValueExcluded: true,
              activeUpdateIncluded: true,
              expiredUpdateExcluded: true,
              privateUpdateExcluded: true,
            },
          },
          {
            id: 'spanish-grounded-retrieval',
            query: '¿Qué debo saber sobre la llegada a la galería pública?',
            retrievedSourceIds: spanishVoiceGrounding.retrievedSourceIds,
            includedSourceIds: spanishVoiceGrounding.sourceIds,
            omittedSourceIds: spanishVoiceGrounding.omittedSourceIds,
            exclusions: [
              { sourceId: employeeKnowledgeId, reason: 'second-layer-not-public' },
              { sourceId: `update:update-internal-${suffix}`, reason: 'private-place-update' },
              { sourceId: `update:update-expired-${suffix}`, reason: 'expired-before-as-of' },
            ],
            knowledgeRetrieval: spanishVoiceGrounding.trace.preOverlayKnowledgeRetrieval,
            measurements: spanishVoiceGrounding.measurements,
            assertions: {
              supportedLanguageQueryRetrievedPublicKnowledge: true,
              correctedNativeValueIncluded: true,
              activeUpdateIncluded: true,
              expiredUpdateExcluded: true,
              privateUpdateExcluded: true,
            },
          },
        ],
        provider: {
          called: false,
          synthesisQualityVerified: false,
          reason: 'Retrieval and prompt preparation only; no real-provider observation.',
        },
        unresolvedCapabilities: [
          'visitor-media-selection-not-integrated-with-voice-grounding-context',
          'accessible-spatial-routing-not-integrated-with-voice-grounding-context',
        ],
      }
      expect(holdoutResult.cases.every((item) => item.measurements.retrievalMs >= 0)).toBe(true)
      expect(holdoutResult.cases.every((item) => item.includedSourceIds.length > 0)).toBe(true)
      process.stdout.write(`${JSON.stringify({ proof: holdoutResult })}\n`)

      const anthropicCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Provider-dark guest response.' }],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      })
      _setAnthropicClientForTesting({
        messages: { create: anthropicCreate },
      } as AnthropicMessagesClient)

      const context = (employee = false, platformAdmin = false): TRPCContext => ({
        db,
        headers: new Headers(),
        session: platformAdmin
          ? { userId: actor.id, activeTenantId: null, role: null, isPlatformAdmin: true }
          : employee
            ? { userId: actor.id, activeTenantId: tenantId, role: 'OWNER', isPlatformAdmin: false }
            : { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
      })
      const adminCaller = testRouter.createCaller(context(false, true)).admin
      const latestPrompt = () =>
        (anthropicCreate.mock.calls.at(-1)![0].system as Array<{ text: string }>)
          .map((block) => block.text)
          .join('')
      const send = async (input: { venueId?: string; employee?: boolean; secondLayer?: boolean }) =>
        testRouter.createCaller(context(input.employee)).chat.send({
          venueId: input.venueId ?? venueId,
          anonymousToken: randomUUID(),
          operationId: randomUUID(),
          message: 'What should I know?',
          ...(input.secondLayer ? { secondLayerKey } : {}),
        })

      const activePreflight = await adminCaller.getNativeGuestReadActivationPreflight({
        tenantId,
        venueId,
      })
      expect(activePreflight).toMatchObject({
        contractVersion: 1,
        activation: {
          runtime: { serverGateEnabled: true, production: false },
          policy: {
            present: true,
            enabled: true,
            valid: true,
            mode: 'ACTIVE',
            targetReleaseId: release.id,
            evaluationEvidenceId: evidence.id,
            qualityPolicyReferencePresent: true,
            rollbackRehearsalReferencePresent: true,
            productionApprovalReferencePresent: false,
          },
          head: { present: true, valid: true, targetMatches: true, releaseId: release.id },
          evaluation: { valid: true, evidenceId: evidence.id },
          path: 'NATIVE',
          reason: 'NATIVE_READY',
          blockers: [],
          mutationPerformed: false,
        },
        convergence: {
          phase: 'NATIVE_HEAD_IN_SYNC',
          headValid: true,
          stateMatchesHead: true,
          readyForLegacyRetirement: false,
          head: { releaseId: release.id, releaseStatus: 'APPLIED' },
        },
        alignment: {
          runtimeReadGateOpen: true,
          materializedStateInSync: true,
          allObservedTechnicalEvidenceAligned: true,
        },
        boundaries: {
          readOnly: true,
          activationAuthorized: false,
          qualityThresholdInferred: false,
          compatibilityDataRetentionRequired: true,
        },
      })
      expect(JSON.stringify(activePreflight)).not.toMatch(/stateHash|desiredStateHash/u)

      const mcpRegistry = createSafeOperationalMcpRegistry(db)
      const readinessCredential: VerifiedMcpCredentialScope = {
        credentialId: 'disposable-native-readiness',
        tenantId,
        clientId: tenantId,
        venueIds: [venueId],
        capabilities: ['resources:read', 'readiness:read'],
      }
      const readinessInput = {
        resource: 'readiness' as const,
        clientId: tenantId,
        venueId,
        limit: 25,
      }
      const mcpActivePreflight = await mcpRegistry.callTool('pathfinder.read', readinessInput, {
        credential: readinessCredential,
      })
      expect(mcpActivePreflight.structuredContent.data).toMatchObject({
        venueId,
        contentConvergence: {
          available: true,
          phase: 'NATIVE_HEAD_IN_SYNC',
          stateMatchesHead: true,
        },
        nativeGuestRead: {
          available: true,
          runtime: { serverGateEnabled: true },
          policy: {
            present: true,
            enabled: true,
            valid: true,
            mode: 'ACTIVE',
            qualityPolicyReferencePresent: true,
            rollbackRehearsalReferencePresent: true,
            productionApprovalReferencePresent: false,
          },
          head: { present: true, valid: true, targetMatches: true },
          evaluation: { valid: true },
          path: 'NATIVE',
          reason: 'NATIVE_READY',
          blockers: [],
          alignment: {
            runtimeReadGateOpen: true,
            materializedStateInSync: true,
            allObservedTechnicalEvidenceAligned: true,
          },
          boundaries: {
            readOnly: true,
            activationAuthorized: false,
            qualityThresholdInferred: false,
            policyReferencesExposed: false,
            compatibilityDataRetentionRequired: true,
          },
        },
      })
      const serializedMcpActivePreflight = JSON.stringify(mcpActivePreflight)
      expect(serializedMcpActivePreflight).not.toMatch(/stateHash|desiredStateHash/u)
      expect(serializedMcpActivePreflight).not.toContain(release.id)
      expect(serializedMcpActivePreflight).not.toContain(evidence.id)
      expect(serializedMcpActivePreflight).not.toContain('policy://disposable-quality-proof')
      expect(serializedMcpActivePreflight).not.toContain('evidence://this-disposable-rehearsal')

      await expect(
        mcpRegistry.callTool('pathfinder.read', readinessInput, {
          credential: { ...readinessCredential, capabilities: ['resources:read'] },
        }),
      ).rejects.toThrow('Capability denied')
      await expect(
        mcpRegistry.callTool(
          'pathfinder.read',
          { ...readinessInput, venueId: controlVenueId },
          { credential: readinessCredential },
        ),
      ).rejects.toThrow('Venue scope denied')

      const controlPreflight = await adminCaller.getNativeGuestReadActivationPreflight({
        tenantId: controlTenantId,
        venueId: controlVenueId,
      })
      expect(controlPreflight.activation).toMatchObject({
        policy: { present: false },
        head: { present: false, releaseId: null },
        evaluation: { valid: false, evidenceId: null },
        path: 'LEGACY',
        reason: 'POLICY_MISSING',
      })
      expect(JSON.stringify(controlPreflight)).not.toContain(release.id)
      expect(JSON.stringify(controlPreflight)).not.toContain(evidence.id)

      await send({})
      expect(latestPrompt()).toContain('Native Public Gallery')
      expect(latestPrompt()).not.toContain('Native Staff Room')
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'guest-chat.native-content-read',
          venueId,
          readPath: 'NATIVE',
          gateReason: 'NATIVE_READY',
        }),
      )

      await send({ employee: true, secondLayer: true })
      expect(latestPrompt()).toContain('Native Public Gallery')
      expect(latestPrompt()).toContain('Native Staff Room')

      embeddingMocks.queryEmbedding = semanticEmbedding
      await send({})
      expect(latestPrompt()).toContain('Native Public Gallery')
      expect(latestPrompt()).toContain('Native Public Arrival Guide')
      expect(latestPrompt()).toContain('Native override: use the east entrance.')
      expect(latestPrompt()).not.toContain('Native Staff Room')
      expect(latestPrompt()).not.toContain('Native Staff Arrival Procedure')
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({ readPath: 'NATIVE', gateReason: 'NATIVE_READY' }),
      )

      await send({ employee: true, secondLayer: true })
      expect(latestPrompt()).toContain('Native Public Gallery')
      expect(latestPrompt()).toContain('Native Staff Room')
      expect(latestPrompt()).toContain('Native Public Arrival Guide')
      expect(latestPrompt()).toContain('Native Staff Arrival Procedure')

      const lowConfidenceEmbedding = Array(1_536).fill(0)
      lowConfidenceEmbedding[1] = 1
      embeddingMocks.queryEmbedding = lowConfidenceEmbedding
      analyticsMocks.emitEvent.mockClear()
      await send({})
      const lowConfidenceEvent = analyticsMocks.emitEvent.mock.calls.find(
        (call) => (call[0] as { eventType?: string }).eventType === 'message.low_confidence',
      )?.[0] as { metadata?: { score?: number } } | undefined
      expect(lowConfidenceEvent?.metadata?.score).toBeGreaterThan(0.55)
      await expect(
        db.conversationInsight.count({
          where: {
            tenantId,
            venueId,
            category: { in: ['LOW_CONFIDENCE_ANSWER', 'KNOWLEDGE_GAP'] },
          },
        }),
      ).resolves.toBe(2)
      await expect(
        db.operationalEvent.count({
          where: { tenantId, venueId, eventType: 'knowledge.gap.detected' },
        }),
      ).resolves.toBe(1)

      embeddingMocks.queryEmbedding = null

      await db.tenantFeatureFlag.update({
        where: { tenantId_flagKey: { tenantId, flagKey: nativeGuestReadTenantFlagKey(venueId) } },
        data: { metadata: policy('DARK') },
      })
      await send({})
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({ readPath: 'DARK', gateReason: 'NATIVE_READY' }),
      )

      await send({ venueId: controlVenueId })
      expect(latestPrompt()).toContain('Legacy Control Gallery')
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tenantId: controlTenantId,
          venueId: controlVenueId,
          readPath: 'LEGACY',
          gateReason: 'POLICY_MISSING',
        }),
      )

      await db.tenantFeatureFlag.update({
        where: { tenantId_flagKey: { tenantId, flagKey: nativeGuestReadTenantFlagKey(venueId) } },
        data: { metadata: policy('ACTIVE') },
      })
      const legacyOnlyName = 'Legacy Only Emergency Exhibit'
      await db.place.create({
        data: {
          tenantId,
          venueId,
          name: legacyOnlyName,
          shortDescription: 'Absent from the immutable native snapshot.',
          type: 'EXHIBIT',
          visibility: 'PUBLIC',
          importanceScore: 200,
          tags: ['fallback'],
        },
      })
      await send({})
      expect(latestPrompt()).toContain(legacyOnlyName)
      expect(logger.info).toHaveBeenLastCalledWith(
        expect.objectContaining({ readPath: 'LEGACY', gateReason: 'NATIVE_READY' }),
      )

      await db.place.deleteMany({ where: { tenantId, venueId, name: legacyOnlyName } })
      await db.place.update({
        where: { id: publicPlaceId },
        data: { name: 'Kill Switch Compatibility Gallery' },
      })
      process.env.NATIVE_GUEST_CONTENT_READ_ENABLED = 'false'
      const logCountBeforeKillSwitch = vi.mocked(logger.info).mock.calls.length
      try {
        const disabledPreflight = await adminCaller.getNativeGuestReadActivationPreflight({
          tenantId,
          venueId,
        })
        expect(disabledPreflight.activation).toMatchObject({
          runtime: { serverGateEnabled: false },
          policy: { present: true, enabled: true, valid: true, mode: 'ACTIVE' },
          head: { present: true, valid: true, targetMatches: true },
          evaluation: { valid: true, evidenceId: evidence.id },
          path: 'LEGACY',
          reason: 'SERVER_DISABLED',
          nativeExecutionReady: false,
          mutationPerformed: false,
        })
        expect(disabledPreflight.activation.blockers).toEqual(['SERVER_GATE_DISABLED'])
        expect(disabledPreflight.convergence).toMatchObject({
          phase: 'NATIVE_HEAD_DRIFTED',
          headValid: true,
          stateMatchesHead: false,
          needsOperatorAttention: true,
        })
        expect(disabledPreflight.alignment).toEqual({
          runtimeReadGateOpen: false,
          materializedStateInSync: false,
          allObservedTechnicalEvidenceAligned: false,
        })
        const mcpDisabledPreflight = await mcpRegistry.callTool('pathfinder.read', readinessInput, {
          credential: readinessCredential,
        })
        expect(mcpDisabledPreflight.structuredContent.data).toMatchObject({
          contentConvergence: {
            available: true,
            phase: 'NATIVE_HEAD_DRIFTED',
            stateMatchesHead: false,
          },
          nativeGuestRead: {
            available: true,
            runtime: { serverGateEnabled: false },
            policy: { present: true, enabled: true, valid: true, mode: 'ACTIVE' },
            head: { present: true, valid: true, targetMatches: true },
            evaluation: { valid: true },
            path: 'LEGACY',
            reason: 'SERVER_DISABLED',
            blockers: ['SERVER_GATE_DISABLED'],
            alignment: {
              runtimeReadGateOpen: false,
              materializedStateInSync: false,
              allObservedTechnicalEvidenceAligned: false,
            },
            boundaries: {
              readOnly: true,
              activationAuthorized: false,
              policyReferencesExposed: false,
            },
          },
        })
        const serializedMcpDisabledPreflight = JSON.stringify(mcpDisabledPreflight)
        expect(serializedMcpDisabledPreflight).not.toContain(release.id)
        expect(serializedMcpDisabledPreflight).not.toContain(evidence.id)
        expect(serializedMcpDisabledPreflight).not.toContain('policy://disposable-quality-proof')
        expect(serializedMcpDisabledPreflight).not.toContain('evidence://this-disposable-rehearsal')
        await send({})
      } finally {
        process.env.NATIVE_GUEST_CONTENT_READ_ENABLED = 'true'
      }
      expect(latestPrompt()).toContain('Kill Switch Compatibility Gallery')
      expect(vi.mocked(logger.info).mock.calls).toHaveLength(logCountBeforeKillSwitch)

      // Exact rollback fails closed while runtime content has drifted from the immutable release.
      await expect(
        revertNativeVenueDeploymentAction(
          {
            tenantId,
            venueId,
            releaseId: release.id,
            commandId: randomUUID(),
            expectedUpdatedAt: applied.updatedAt,
            actor,
          },
          db,
        ),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Runtime state changed after apply.',
      })

      await db.place.update({
        where: { id: publicPlaceId },
        data: { name: 'Native Public Gallery' },
      })
      const revertInput = {
        tenantId,
        venueId,
        releaseId: release.id,
        commandId: randomUUID(),
        expectedUpdatedAt: applied.updatedAt,
        actor,
      }
      const reverted = await revertNativeVenueDeploymentAction(revertInput, db)
      expect(reverted).toMatchObject({
        releaseId: release.id,
        status: 'REVERTED',
        restoredStateHash: release.baseStateHash,
        head: null,
      })
      await expect(revertNativeVenueDeploymentAction(revertInput, db)).resolves.toEqual(reverted)
      const commandCounts = await db.nativeVenueDeploymentCommand.groupBy({
        by: ['kind'],
        where: { tenantId, venueId, releaseId: release.id },
        _count: { _all: true },
      })
      expect(commandCounts).toHaveLength(3)
      expect(commandCounts).toEqual(
        expect.arrayContaining([
          { kind: 'APPLY', _count: { _all: 1 } },
          { kind: 'APPROVE', _count: { _all: 1 } },
          { kind: 'REVERT', _count: { _all: 1 } },
        ]),
      )
      const revertedPreflight = await adminCaller.getNativeGuestReadActivationPreflight({
        tenantId,
        venueId,
      })
      expect(revertedPreflight.activation).toMatchObject({
        head: { present: false },
        path: 'LEGACY',
        nativeExecutionReady: false,
        mutationPerformed: false,
      })
    })
  }, 120_000)
})
