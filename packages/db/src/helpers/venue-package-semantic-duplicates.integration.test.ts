import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { acquireEmbeddingWork } from './embedding-work-claims'
import {
  storeKnowledgeEntryEmbeddingForScope,
  storePlaceEmbeddingForScope,
} from './semantic-search'
import {
  findVenuePackageKnowledgeSemanticDuplicates,
  findVenuePackagePlaceSemanticDuplicates,
  getVenuePackageSemanticCoverage,
} from './venue-package-semantic-duplicates'

const runIntegration = process.env.RUN_VENUE_PACKAGE_SEMANTIC_DB_INTEGRATION === '1'
const integrationDescribe = runIntegration ? describe : describe.skip

function assertDisposableDatabase(): void {
  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) throw new Error('DATABASE_URL is required for venue-package semantic integration')
  const url = new URL(rawUrl)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(host) ||
    url.port.length === 0 ||
    !/^pathfinder_disposable_[a-z0-9_]+$/.test(database)
  ) {
    throw new Error(
      'Venue-package semantic integration requires a loopback pathfinder_disposable_* database',
    )
  }
}

function basisVector(index: number): number[] {
  const vector = Array<number>(1_536).fill(0)
  vector[index] = 1
  return vector
}

integrationDescribe('venue-package semantic duplicates (disposable PostgreSQL)', () => {
  const suffix = randomUUID()
  const tenantId = `semantic-tenant-${suffix}`
  const otherTenantId = `semantic-other-tenant-${suffix}`
  const venueId = `semantic-venue-${suffix}`
  const otherVenueId = `semantic-other-venue-${suffix}`
  const otherTenantVenueId = `semantic-cross-tenant-venue-${suffix}`
  const placeProfile = 'integration:place:1536'
  const knowledgeProfile = 'integration:knowledge:1536'
  const vectorA = basisVector(0)
  const vectorB = basisVector(1)

  const placeIds = {
    tieA: `semantic-place-a-${suffix}`,
    tieB: `semantic-place-b-${suffix}`,
    strongestB: `semantic-place-z-${suffix}`,
    wrongProfile: `semantic-place-wrong-${suffix}`,
    stale: `semantic-place-stale-${suffix}`,
    missing: `semantic-place-missing-${suffix}`,
    inactive: `semantic-place-inactive-${suffix}`,
    otherVenue: `semantic-place-other-venue-${suffix}`,
    otherTenant: `semantic-place-other-tenant-${suffix}`,
  }
  const knowledgeIds = {
    current: `semantic-knowledge-current-${suffix}`,
    wrongProfile: `semantic-knowledge-wrong-${suffix}`,
    stale: `semantic-knowledge-stale-${suffix}`,
    missing: `semantic-knowledge-missing-${suffix}`,
    missingClaim: `semantic-knowledge-missing-claim-${suffix}`,
    nonComplete: `semantic-knowledge-non-complete-${suffix}`,
    disabled: `semantic-knowledge-disabled-${suffix}`,
    otherVenue: `semantic-knowledge-other-venue-${suffix}`,
    otherTenant: `semantic-knowledge-other-tenant-${suffix}`,
  }

  async function seedPlace(params: {
    id: string
    tenantId: string
    venueId: string
    vector?: number[]
    active?: boolean
    claimMutation?: 'wrong-profile' | 'stale'
  }): Promise<void> {
    const place = await db.place.create({
      data: {
        id: params.id,
        tenantId: params.tenantId,
        venueId: params.venueId,
        name: params.id,
        type: 'exhibit',
        tags: ['semantic-integration'],
      },
    })
    if (params.vector) {
      const leaseToken = randomUUID()
      const acquisition = await acquireEmbeddingWork({
        tenantId: params.tenantId,
        venueId: params.venueId,
        entityType: 'PLACE',
        entityId: place.id,
        contentUpdatedAt: place.updatedAt,
        sourceHash: 'a'.repeat(64),
        embeddingProfile: placeProfile,
        leaseToken,
      })
      if (acquisition.state !== 'acquired') throw new Error('Expected a new place embedding claim')
      await expect(
        storePlaceEmbeddingForScope({
          placeId: place.id,
          tenantId: params.tenantId,
          venueId: params.venueId,
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
          embedding: params.vector,
          claimId: acquisition.claimId,
          leaseToken,
        }),
      ).resolves.toEqual({ claimCompleted: true, stored: true })

      if (params.claimMutation === 'wrong-profile') {
        await db.embeddingWorkClaim.updateMany({
          where: { id: acquisition.claimId, tenantId: params.tenantId },
          data: { embeddingProfile: 'integration:wrong-profile:1536' },
        })
      } else if (params.claimMutation === 'stale') {
        await db.embeddingWorkClaim.updateMany({
          where: { id: acquisition.claimId, tenantId: params.tenantId },
          data: { contentUpdatedAt: new Date(place.updatedAt.getTime() - 1) },
        })
      }
    }
    if (params.active === false) {
      await db.place.updateMany({
        where: { id: place.id, tenantId: params.tenantId },
        data: { isActive: false },
      })
    }
  }

  async function seedKnowledge(params: {
    id: string
    tenantId: string
    venueId: string
    vector?: number[]
    enabled?: boolean
    claimMutation?: 'wrong-profile' | 'stale' | 'missing-claim' | 'non-complete'
  }): Promise<void> {
    const entry = await db.venueKnowledgeEntry.create({
      data: {
        id: params.id,
        tenantId: params.tenantId,
        venueId: params.venueId,
        title: params.id,
        category: 'integration',
        content: 'Semantic duplicate integration evidence.',
      },
    })
    if (params.vector) {
      const leaseToken = randomUUID()
      const acquisition = await acquireEmbeddingWork({
        tenantId: params.tenantId,
        venueId: params.venueId,
        entityType: 'KNOWLEDGE_ENTRY',
        entityId: entry.id,
        contentUpdatedAt: entry.updatedAt,
        sourceHash: 'b'.repeat(64),
        embeddingProfile: knowledgeProfile,
        leaseToken,
      })
      if (acquisition.state !== 'acquired') {
        throw new Error('Expected a new knowledge embedding claim')
      }
      await expect(
        storeKnowledgeEntryEmbeddingForScope({
          entryId: entry.id,
          tenantId: params.tenantId,
          venueId: params.venueId,
          contentUpdatedAt: entry.updatedAt,
          source: {
            title: entry.title,
            category: entry.category,
            content: entry.content,
            isEnabled: entry.isEnabled,
          },
          embedding: params.vector,
          claimId: acquisition.claimId,
          leaseToken,
        }),
      ).resolves.toEqual({ claimCompleted: true, stored: true })

      if (params.claimMutation === 'wrong-profile') {
        await db.embeddingWorkClaim.updateMany({
          where: { id: acquisition.claimId, tenantId: params.tenantId },
          data: { embeddingProfile: 'integration:wrong-profile:1536' },
        })
      } else if (params.claimMutation === 'stale') {
        await db.embeddingWorkClaim.updateMany({
          where: { id: acquisition.claimId, tenantId: params.tenantId },
          data: { contentUpdatedAt: new Date(entry.updatedAt.getTime() - 1) },
        })
      } else if (params.claimMutation === 'missing-claim') {
        await db.embeddingWorkClaim.deleteMany({
          where: { id: acquisition.claimId, tenantId: params.tenantId },
        })
      } else if (params.claimMutation === 'non-complete') {
        await db.embeddingWorkClaim.updateMany({
          where: { id: acquisition.claimId, tenantId: params.tenantId },
          data: { status: 'SUPERSEDED' },
        })
      }
    }
    if (params.enabled === false) {
      await db.venueKnowledgeEntry.updateMany({
        where: { id: entry.id, tenantId: params.tenantId },
        data: { isEnabled: false },
      })
    }
  }

  beforeAll(async () => {
    assertDisposableDatabase()
    await db.tenant.createMany({
      data: [
        { id: tenantId, name: tenantId, slug: tenantId },
        { id: otherTenantId, name: otherTenantId, slug: otherTenantId },
      ],
    })
    await db.venue.createMany({
      data: [
        { id: venueId, tenantId, name: venueId, slug: venueId },
        { id: otherVenueId, tenantId, name: otherVenueId, slug: otherVenueId },
        {
          id: otherTenantVenueId,
          tenantId: otherTenantId,
          name: otherTenantVenueId,
          slug: otherTenantVenueId,
        },
      ],
    })

    await seedPlace({ id: placeIds.tieA, tenantId, venueId, vector: vectorA })
    await seedPlace({ id: placeIds.tieB, tenantId, venueId, vector: vectorA })
    await seedPlace({ id: placeIds.strongestB, tenantId, venueId, vector: vectorB })
    await seedPlace({
      id: placeIds.wrongProfile,
      tenantId,
      venueId,
      vector: vectorA,
      claimMutation: 'wrong-profile',
    })
    await seedPlace({
      id: placeIds.stale,
      tenantId,
      venueId,
      vector: vectorA,
      claimMutation: 'stale',
    })
    await seedPlace({ id: placeIds.missing, tenantId, venueId })
    await seedPlace({ id: placeIds.inactive, tenantId, venueId, vector: vectorA, active: false })
    await seedPlace({ id: placeIds.otherVenue, tenantId, venueId: otherVenueId, vector: vectorA })
    await seedPlace({
      id: placeIds.otherTenant,
      tenantId: otherTenantId,
      venueId: otherTenantVenueId,
      vector: vectorA,
    })

    await seedKnowledge({ id: knowledgeIds.current, tenantId, venueId, vector: vectorB })
    await seedKnowledge({
      id: knowledgeIds.wrongProfile,
      tenantId,
      venueId,
      vector: vectorB,
      claimMutation: 'wrong-profile',
    })
    await seedKnowledge({
      id: knowledgeIds.stale,
      tenantId,
      venueId,
      vector: vectorB,
      claimMutation: 'stale',
    })
    await seedKnowledge({ id: knowledgeIds.missing, tenantId, venueId })
    await seedKnowledge({
      id: knowledgeIds.missingClaim,
      tenantId,
      venueId,
      vector: vectorB,
      claimMutation: 'missing-claim',
    })
    await seedKnowledge({
      id: knowledgeIds.nonComplete,
      tenantId,
      venueId,
      vector: vectorB,
      claimMutation: 'non-complete',
    })
    await seedKnowledge({
      id: knowledgeIds.disabled,
      tenantId,
      venueId,
      vector: vectorB,
      enabled: false,
    })
    await seedKnowledge({
      id: knowledgeIds.otherVenue,
      tenantId,
      venueId: otherVenueId,
      vector: vectorB,
    })
    await seedKnowledge({
      id: knowledgeIds.otherTenant,
      tenantId: otherTenantId,
      venueId: otherTenantVenueId,
      vector: vectorB,
    })
  })

  afterAll(async () => {
    for (const scopedTenantId of [tenantId, otherTenantId]) {
      await db.embeddingDispatch.deleteMany({ where: { tenantId: scopedTenantId } })
      await db.embeddingWorkClaim.deleteMany({ where: { tenantId: scopedTenantId } })
      await db.venueKnowledgeEntry.deleteMany({ where: { tenantId: scopedTenantId } })
      await db.place.deleteMany({ where: { tenantId: scopedTenantId } })
      await db.venue.deleteMany({ where: { tenantId: scopedTenantId } })
    }
    // ContentVersion is append-only and retains the synthetic tenant FK. The
    // required disposable database is the final cleanup boundary for those rows.
  })

  it('distinguishes missing and incompatible vectors within the exact tenant venue', async () => {
    await expect(
      getVenuePackageSemanticCoverage(db, {
        tenantId,
        venueId,
        placeProfile,
        knowledgeProfile,
        scanPlaces: true,
        scanKnowledgeEntries: true,
      }),
    ).resolves.toEqual({
      places: {
        eligibleCount: 6,
        searchableCount: 3,
        missingVectorCount: 1,
        incompatibleVectorCount: 2,
      },
      knowledgeEntries: {
        eligibleCount: 6,
        searchableCount: 1,
        missingVectorCount: 1,
        incompatibleVectorCount: 4,
      },
    })

    await expect(
      getVenuePackageSemanticCoverage(db, {
        tenantId,
        venueId,
        placeProfile,
        knowledgeProfile,
        scanPlaces: true,
        scanKnowledgeEntries: true,
        excludedPlaceIds: [placeIds.tieA],
        excludedKnowledgeEntryIds: [knowledgeIds.current],
      }),
    ).resolves.toEqual({
      places: {
        eligibleCount: 5,
        searchableCount: 2,
        missingVectorCount: 1,
        incompatibleVectorCount: 2,
      },
      knowledgeEntries: {
        eligibleCount: 5,
        searchableCount: 0,
        missingVectorCount: 1,
        incompatibleVectorCount: 4,
      },
    })
  })

  it('uses only current COMPLETE claims and orders strongest matches then ID ties', async () => {
    await expect(
      findVenuePackagePlaceSemanticDuplicates(db, {
        tenantId,
        venueId,
        profile: placeProfile,
        maxCosineDistance: 0,
        candidates: [
          { draftIndex: 2, embedding: vectorB },
          { draftIndex: 0, embedding: vectorA },
          { draftIndex: 1, embedding: vectorA, excludeId: placeIds.tieA },
        ],
      }),
    ).resolves.toEqual([
      {
        entityType: 'PLACE',
        draftIndex: 0,
        existingId: placeIds.tieA,
        existingLabel: placeIds.tieA,
        cosineDistance: 0,
      },
      {
        entityType: 'PLACE',
        draftIndex: 1,
        existingId: placeIds.tieB,
        existingLabel: placeIds.tieB,
        cosineDistance: 0,
      },
      {
        entityType: 'PLACE',
        draftIndex: 2,
        existingId: placeIds.strongestB,
        existingLabel: placeIds.strongestB,
        cosineDistance: 0,
      },
    ])
  })

  it('keeps entity types separate and includes an exact threshold-boundary match', async () => {
    await expect(
      findVenuePackageKnowledgeSemanticDuplicates(db, {
        tenantId,
        venueId,
        profile: knowledgeProfile,
        maxCosineDistance: 0,
        candidates: [{ draftIndex: 0, embedding: vectorA }],
      }),
    ).resolves.toEqual([])

    await expect(
      findVenuePackageKnowledgeSemanticDuplicates(db, {
        tenantId,
        venueId,
        profile: knowledgeProfile,
        maxCosineDistance: 0,
        candidates: [{ draftIndex: 1, embedding: vectorB }],
      }),
    ).resolves.toEqual([
      {
        entityType: 'KNOWLEDGE_ENTRY',
        draftIndex: 1,
        existingId: knowledgeIds.current,
        existingLabel: knowledgeIds.current,
        cosineDistance: 0,
      },
    ])

    await expect(
      findVenuePackageKnowledgeSemanticDuplicates(db, {
        tenantId,
        venueId,
        profile: knowledgeProfile,
        maxCosineDistance: 0,
        candidates: [{ draftIndex: 2, embedding: vectorB, excludeId: knowledgeIds.current }],
      }),
    ).resolves.toEqual([])
  })
})
