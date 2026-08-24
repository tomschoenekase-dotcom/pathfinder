import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import {
  applyNativeVenueDeploymentAction,
  approveNativeVenueDeploymentAction,
  createNativeVenueDeploymentAction,
  measureNativeContentConvergenceAction,
  projectNativeVenueStateAction,
  revertNativeVenueDeploymentAction,
} from './native-venue-deployment-actions'

const enabled =
  process.env.RUN_CONTENT_CONVERGENCE_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_content_convergence_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('native content convergence disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('distinguishes missing, in-sync, and drifted heads without crossing venue scope', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-convergence-${suffix}`
      const venueId = `venue-convergence-${suffix}`
      const otherVenueId = `venue-convergence-other-${suffix}`
      const placeId = `place-convergence-${suffix}`

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic convergence tenant', slug: tenantId },
      })
      await db.venue.createMany({
        data: [
          { id: venueId, tenantId, name: 'Synthetic convergence venue', slug: venueId },
          {
            id: otherVenueId,
            tenantId,
            name: 'Synthetic convergence control venue',
            slug: otherVenueId,
          },
        ],
      })
      await db.place.createMany({
        data: [
          {
            id: placeId,
            tenantId,
            venueId,
            name: 'Gallery One',
            type: 'EXHIBIT',
            tags: ['synthetic'],
          },
          {
            id: `place-control-${suffix}`,
            tenantId,
            venueId: otherVenueId,
            name: 'Control Gallery',
            type: 'EXHIBIT',
            tags: ['synthetic'],
          },
        ],
      })

      const missing = await measureNativeContentConvergenceAction(db, { tenantId, venueId })
      expect(missing).toMatchObject({
        phase: 'NO_NATIVE_HEAD',
        readyForShadowEvaluation: false,
        readyForLegacyRetirement: false,
        blockers: ['NO_NATIVE_HEAD', 'LEGACY_SEMANTIC_READ_PATH'],
        counts: { activePlaces: 1 },
      })

      const projected = await projectNativeVenueStateAction(db, { tenantId, venueId })
      const actor = {
        type: 'HUMAN' as const,
        role: 'PLATFORM_ADMIN' as const,
        id: 'integration-operator',
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
              sourceIds: ['synthetic:content-convergence'],
              evidenceIds: [],
              createdAt: new Date().toISOString(),
              createdBy: { kind: 'OPERATOR', actorRef: actor.id },
            },
            venue: projected.state.venue,
            venueBotConfiguration: projected.state.venueBotConfiguration,
            places: projected.state.places,
            knowledgeEntries: projected.state.knowledgeEntries,
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
      await applyNativeVenueDeploymentAction(
        {
          tenantId,
          venueId,
          releaseId: release.id,
          commandId: randomUUID(),
          expectedUpdatedAt: approved.updatedAt,
          actor,
        },
        db,
      )

      const inSync = await measureNativeContentConvergenceAction(db, { tenantId, venueId })
      expect(inSync).toMatchObject({
        phase: 'NATIVE_HEAD_IN_SYNC',
        headValid: true,
        stateMatchesHead: true,
        readyForShadowEvaluation: true,
        readyForLegacyRetirement: false,
        blockers: ['LEGACY_SEMANTIC_READ_PATH'],
      })

      await db.place.update({
        where: { id: placeId },
        data: { shortDescription: 'A deliberate materialized-state drift.' },
      })
      const drifted = await measureNativeContentConvergenceAction(db, { tenantId, venueId })
      expect(drifted).toMatchObject({
        phase: 'NATIVE_HEAD_DRIFTED',
        headValid: true,
        stateMatchesHead: false,
        needsOperatorAttention: true,
        readyForLegacyRetirement: false,
        blockers: ['MATERIALIZED_STATE_DRIFT', 'LEGACY_SEMANTIC_READ_PATH'],
      })

      const control = await measureNativeContentConvergenceAction(db, {
        tenantId,
        venueId: otherVenueId,
      })
      expect(control).toMatchObject({
        phase: 'NO_NATIVE_HEAD',
        counts: { activePlaces: 1 },
      })
    })
  })

  it('rehearses a nonzero native apply and exact compatibility rollback across a fixture cohort', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-rollback-${suffix}`
      const venueId = `venue-rollback-${suffix}`
      const controlVenueId = `venue-rollback-control-${suffix}`
      const placeId = `place-rollback-${suffix}`
      const controlPlaceId = `place-rollback-control-${suffix}`
      const baselineDescription = 'Compatibility baseline description.'
      const candidateDescription = 'Native candidate description.'
      const actor = {
        type: 'HUMAN' as const,
        role: 'PLATFORM_ADMIN' as const,
        id: 'integration-operator',
      }

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic rollback tenant', slug: tenantId },
      })
      await db.venue.createMany({
        data: [
          { id: venueId, tenantId, name: 'Synthetic rollback venue', slug: venueId },
          {
            id: controlVenueId,
            tenantId,
            name: 'Synthetic rollback control venue',
            slug: controlVenueId,
          },
        ],
      })
      await db.place.createMany({
        data: [
          {
            id: placeId,
            tenantId,
            venueId,
            name: 'Rollback Gallery',
            shortDescription: baselineDescription,
            type: 'EXHIBIT',
            tags: ['synthetic'],
          },
          {
            id: controlPlaceId,
            tenantId,
            venueId: controlVenueId,
            name: 'Control Gallery',
            shortDescription: 'Control description.',
            type: 'EXHIBIT',
            tags: ['synthetic'],
          },
        ],
      })

      const baseline = await projectNativeVenueStateAction(db, { tenantId, venueId })
      const desiredPlaces = baseline.state.places.map(
        (place: (typeof baseline.state.places)[number]) =>
          place.id === placeId ? { ...place, shortDescription: candidateDescription } : place,
      )
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
              sourceIds: ['synthetic:content-rollback-rehearsal'],
              evidenceIds: [],
              createdAt: new Date().toISOString(),
              createdBy: { kind: 'OPERATOR', actorRef: actor.id },
            },
            venue: baseline.state.venue,
            venueBotConfiguration: baseline.state.venueBotConfiguration,
            places: desiredPlaces,
            knowledgeEntries: baseline.state.knowledgeEntries,
            generalizedModules: baseline.state.generalizedModules,
            items: [],
            assets: [],
            capabilityOverrides: [],
            modelReferences: [],
            evaluation: {
              status: 'NOT_REQUIRED_FOR_CORE_PROFILE',
              policyVersion: 'native-core-v1',
            },
            baseState: { stateHash: baseline.stateHash, ...baseline.universe },
          },
        },
        db,
      )
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
      const applied = await applyNativeVenueDeploymentAction(
        {
          tenantId,
          venueId,
          releaseId: release.id,
          commandId: randomUUID(),
          expectedUpdatedAt: approved.updatedAt,
          actor,
        },
        db,
      )

      expect(applied).toMatchObject({ status: 'APPLIED', effectCount: 1 })
      await expect(
        db.place.findFirst({ where: { id: placeId, tenantId, venueId } }),
      ).resolves.toMatchObject({ shortDescription: candidateDescription, isActive: true })
      await expect(
        measureNativeContentConvergenceAction(db, { tenantId, venueId }),
      ).resolves.toMatchObject({ phase: 'NATIVE_HEAD_IN_SYNC', stateMatchesHead: true })

      const reverted = await revertNativeVenueDeploymentAction(
        {
          tenantId,
          venueId,
          releaseId: release.id,
          commandId: randomUUID(),
          expectedUpdatedAt: applied.updatedAt,
          actor,
        },
        db,
      )
      expect(reverted).toMatchObject({
        status: 'REVERTED',
        restoredStateHash: baseline.stateHash,
        head: null,
      })
      await expect(
        db.place.findFirst({ where: { id: placeId, tenantId, venueId } }),
      ).resolves.toMatchObject({ shortDescription: baselineDescription, isActive: true })
      await expect(
        measureNativeContentConvergenceAction(db, { tenantId, venueId }),
      ).resolves.toMatchObject({ phase: 'NO_NATIVE_HEAD' })
      await expect(
        db.place.findFirst({ where: { id: controlPlaceId, tenantId, venueId: controlVenueId } }),
      ).resolves.toMatchObject({ shortDescription: 'Control description.', isActive: true })
    })
  })
})
