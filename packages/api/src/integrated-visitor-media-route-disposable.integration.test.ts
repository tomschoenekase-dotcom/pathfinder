import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import {
  claimIntakeUploadVerificationAction,
  db,
  recordIntakeUploadPrecheckAction,
  registerVenueMediaAssetAction,
  requestVenueMediaDerivativesAction,
  reserveIntakeUploadAction,
  reviewVenueMediaAssetAction,
  settleIntakeUploadAuthoritativeVerificationAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { mergeRouters, router } from './core'
import { adminLocationAuthoringRouter } from './routers/admin/location-authoring'
import { adminLocationAvailabilityRouter } from './routers/admin/location-availability'
import { adminLocationConnectionAuthoringRouter } from './routers/admin/location-connection-authoring'
import { locationRouter } from './routers/location'

const enabled =
  process.env.RUN_INTEGRATED_VISITOR_MEDIA_ROUTE_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_visitor_media_route_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const app = router({
  admin: mergeRouters(
    adminLocationAuthoringRouter,
    adminLocationAvailabilityRouter,
    adminLocationConnectionAuthoringRouter,
  ),
  location: locationRouter,
})

describe.skipIf(!enabled)('integrated visitor media and route on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('retains a reviewed Place mapping from canonical authoring into public route media', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
      const tenantId = `visitor-route-${suffix}`
      const venueId = `venue-${suffix}`
      const siblingVenueId = `sibling-${suffix}`
      const siblingTenantId = `sibling-tenant-${suffix}`
      const placeId = `place-${suffix}`
      const siblingPlaceId = `sibling-place-${suffix}`
      const siblingTenantPlaceId = `sibling-tenant-place-${suffix}`
      const originId = randomUUID()
      const destinationId = randomUUID()
      const secondAnchorId = randomUUID()
      const connectionId = randomUUID()
      const anonymousToken = randomUUID()
      const actorId = 'disposable-location-reviewer'
      const venueSlug = `visitor-route-${suffix}`

      await db.tenant.create({
        data: { id: tenantId, slug: tenantId, name: 'Visitor route proof' },
      })
      await db.tenant.create({
        data: { id: siblingTenantId, slug: siblingTenantId, name: 'Sibling tenant' },
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
            name: 'Visitor Route Museum',
            chatShowPhotos: true,
            chatShowLinks: true,
          },
          { id: siblingVenueId, tenantId, slug: siblingVenueId, name: 'Sibling Museum' },
        ],
      })
      await db.venue.create({
        data: {
          id: `sibling-tenant-venue-${suffix}`,
          tenantId: siblingTenantId,
          slug: `sibling-tenant-venue-${suffix}`,
          name: 'Sibling tenant museum',
        },
      })
      await db.place.createMany({
        data: [
          { id: placeId, tenantId, venueId, name: 'Garden restroom', type: 'RESTROOM', tags: [] },
          {
            id: siblingPlaceId,
            tenantId,
            venueId: siblingVenueId,
            name: 'Sibling Cafe',
            type: 'FOOD',
            tags: [],
          },
        ],
      })
      await db.place.create({
        data: {
          id: siblingTenantPlaceId,
          tenantId: siblingTenantId,
          venueId: `sibling-tenant-venue-${suffix}`,
          name: 'Other tenant restroom',
          type: 'RESTROOM',
          tags: [],
        },
      })
      await db.visitorSession.create({ data: { tenantId, venueId, anonymousToken } })

      const admin = app.createCaller({
        db,
        headers: new Headers(),
        session: { userId: actorId, activeTenantId: null, role: null, isPlatformAdmin: true },
      })
      const publicCaller = app.createCaller({
        db,
        headers: new Headers(),
        session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
      })
      const fields = (
        stableKey: string,
        kind: 'ENTRANCE' | 'RESTROOM',
        primaryPlaceId?: string,
        coordinates?: { latitude: number; longitude: number },
      ) => ({
        tenantId,
        venueId,
        stableKey,
        kind,
        displayName: stableKey === 'entrance' ? 'Entrance' : 'Garden restroom',
        description: null,
        visibility: 'PUBLIC' as const,
        floorId: null,
        parentLocationId: null,
        ...(primaryPlaceId ? { primaryPlaceId } : {}),
        coordinates: coordinates ?? null,
        mapAnchor: null,
        externalMapReference: null,
        accessibilityMetadata: {},
      })
      const origin = await admin.admin.createVenueLocationDraft({
        operationId: originId,
        ...fields('entrance', 'ENTRANCE', undefined, { latitude: 41, longitude: -87 }),
      })
      const destination = await admin.admin.createVenueLocationDraft({
        operationId: destinationId,
        ...fields('garden-restroom', 'RESTROOM', placeId, {
          latitude: 41.001,
          longitude: -87,
        }),
      })
      const secondAnchor = await admin.admin.createVenueLocationDraft({
        operationId: secondAnchorId,
        ...fields('closer-disconnected-restroom', 'RESTROOM', placeId, {
          latitude: 41.00001,
          longitude: -87,
        }),
      })
      expect(destination.location.primaryPlaceId).toBe(placeId)
      expect(secondAnchor.location.primaryPlaceId).toBe(placeId)
      await expect(
        admin.admin.createVenueLocationDraft({
          operationId: randomUUID(),
          ...fields('wrong-scope', 'RESTROOM', siblingPlaceId),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const rawLocation = (id: string, primaryPlaceId: string) => ({
        id,
        tenantId,
        venueId,
        stableKey: `fk-${id.slice(0, 8)}`,
        kind: 'RESTROOM' as const,
        displayName: 'Foreign key rejection fixture',
        visibility: 'PUBLIC',
        primaryPlaceId,
        accessibilityMetadata: {},
        verifiedAt: new Date(),
        verifiedBy: actorId,
        isActive: false,
      })
      await expect(
        db.venueLocation.create({ data: rawLocation(randomUUID(), siblingPlaceId) }),
      ).rejects.toMatchObject({ code: 'P2003' })
      await expect(
        db.venueLocation.create({ data: rawLocation(randomUUID(), siblingTenantPlaceId) }),
      ).rejects.toMatchObject({ code: 'P2003' })
      for (const item of [origin.location, destination.location, secondAnchor.location]) {
        await admin.admin.setVenueLocationAvailability({
          tenantId,
          venueId,
          locationId: item.id,
          expectedUpdatedAt: item.updatedAt,
          active: true,
          reason: 'Activate reviewed disposable route anchor.',
        })
      }
      const connection = await admin.admin.createVenueLocationConnectionDraft({
        operationId: connectionId,
        tenantId,
        venueId,
        fromLocationId: originId,
        toLocationId: destinationId,
        kind: 'WALKWAY',
        bidirectional: true,
        accessible: true,
        directions: 'Follow the reviewed path to the cafe.',
      })
      await admin.admin.setVenueLocationConnectionAvailability({
        tenantId,
        venueId,
        connectionId,
        expectedUpdatedAt: connection.connection.updatedAt,
        active: true,
        reason: 'Activate reviewed disposable connection.',
      })

      // Synthetic metadata-only prerequisites exercise the production eligibility query. This
      // fixture neither stores nor delivers bytes and makes no live storage/provider claim.
      const assetId = randomUUID()
      const generation = randomUUID()
      const sourceSha256 = 'a'.repeat(64)
      const actor = { type: 'HUMAN' as const, id: actorId, role: 'PLATFORM_ADMIN' as const }
      const reserved = await reserveIntakeUploadAction({
        tenantId,
        venueId,
        actor,
        request: {
          requestId: randomUUID(),
          displayName: 'Synthetic route photo metadata',
          fileName: 'route-photo.png',
          mimeType: 'image/png',
          category: 'PHOTO',
          byteSize: 64,
          sha256: sourceSha256,
        },
        trustedObjectIdentity: {
          objectKey: `intake-quarantine/${randomUUID()}`,
          objectGeneration: generation,
        },
      })
      const uploadId = reserved.upload.id
      const precheckClaimId = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId,
        actor,
        claimId: precheckClaimId,
      })
      await recordIntakeUploadPrecheckAction({
        tenantId,
        venueId,
        uploadId,
        actor,
        claimId: precheckClaimId,
        verified: {
          objectGeneration: generation,
          storageVersionId: 'synthetic-source-version',
          mimeType: 'image/png',
          byteSize: 64,
          sha256: sourceSha256,
        },
        evidence: {
          engine: 'disposable-precheck',
          engineVersion: '1',
          verdictHash: createHash('sha256').update(`precheck:${suffix}`).digest('hex'),
          computedByteSize: 64,
          computedSha256: sourceSha256,
        },
      })
      const malwareClaimId = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId,
        actor,
        claimId: malwareClaimId,
      })
      await settleIntakeUploadAuthoritativeVerificationAction({
        tenantId,
        venueId,
        uploadId,
        actor,
        claimId: malwareClaimId,
        malware: {
          verdict: 'CLEAN',
          engine: 'disposable-malware',
          engineVersion: '1',
          verdictHash: createHash('sha256').update(`malware:${suffix}`).digest('hex'),
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
          intakeUploadId: uploadId,
          kind: 'IMAGE',
          semanticDescription: 'Synthetic metadata for the Garden restroom destination.',
          depictedSubjects: ['Garden restroom'],
          altText: 'Garden restroom entrance',
          sourceName: 'Disposable fixture',
          sourceUrl: 'https://museum.example.test/garden-restroom',
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
          rightsStatement: 'Synthetic fixture metadata owned by the disposable test.',
          rightsEvidenceSourceId: 'disposable-fixture',
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
      const completed = await db.venueMediaDerivative.updateMany({
        where: { id: derivativeId, tenantId, venueId, assetId, status: 'PENDING' },
        data: {
          status: 'READY',
          objectKey: `visitor-media/${suffix}.webp`,
          storageVersionId: 'synthetic-derivative-version',
          mimeType: 'image/webp',
          width: 768,
          height: 480,
          byteSize: 64,
          sha256: 'b'.repeat(64),
          completedAt: new Date(),
        },
      })
      expect(completed.count).toBe(1)

      const input = {
        venueId,
        anonymousToken,
        fromLocationId: originId,
        kind: 'RESTROOM' as const,
        accessibleOnly: true,
      }
      await expect(publicCaller.location.reachableDestination(input)).resolves.toMatchObject({
        destination: {
          id: destinationId,
          media: {
            photoUrl: `/api/venue-media/${derivativeId}?venue=${venueSlug}`,
            photoAttribution: {
              altText: 'Garden restroom entrance',
              sourceName: 'Disposable fixture',
              sourceUrl: 'https://museum.example.test/garden-restroom',
            },
          },
        },
      })

      await db.place.update({ where: { id: placeId }, data: { visibility: 'SECOND_LAYER' } })
      const privatePlace = await publicCaller.location.reachableDestination(input)
      expect(privatePlace.destination).toMatchObject({ id: destinationId })
      expect(privatePlace.destination).not.toHaveProperty('media')
      await db.place.update({ where: { id: placeId }, data: { visibility: 'PUBLIC' } })

      await db.place.update({ where: { id: placeId }, data: { isActive: false } })
      const inactivePlace = await publicCaller.location.reachableDestination(input)
      expect(inactivePlace.destination).toMatchObject({ id: destinationId })
      expect(inactivePlace.destination).not.toHaveProperty('media')
      await db.place.update({ where: { id: placeId }, data: { isActive: true } })

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
          reason: 'Disposable current-review withdrawal.',
        },
      })
      const withdrawn = await publicCaller.location.reachableDestination(input)
      expect(withdrawn.destination).toMatchObject({ id: destinationId })
      expect(withdrawn.destination).not.toHaveProperty('media')

      // eslint-disable-next-line no-console -- retained structured disposable proof
      console.info(
        JSON.stringify({
          proof: 'integrated-visitor-media-route-v1',
          tenantId,
          venueId,
          destinationLocationId: destinationId,
          primaryPlaceId: placeId,
          secondAnchorId,
          derivativeId,
          controls: [
            'wrong-venue-place-api',
            'wrong-venue-place-fk',
            'wrong-tenant-place-fk',
            'closer-disconnected-restroom',
            'private-place',
            'inactive-place',
            'withdrawn-media',
          ],
          limits: ['synthetic metadata only', 'no bytes', 'no provider', 'no device claim'],
        }),
      )
    })
  })
})
