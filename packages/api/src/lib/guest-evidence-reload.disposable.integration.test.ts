import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { loadGuestVenueDirectory } from './guest-venue-directory'

const enabled =
  process.env.RUN_GUEST_EVIDENCE_DB_INTEGRATION === '1' &&
  /^postgres(?:ql)?:\/\/[^/]+\/pathfinder_disposable_[a-z0-9_]+(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

describe.skipIf(!enabled)('evidence ref reload on disposable PostgreSQL', () => {
  afterAll(async () => {
    if (enabled) await db.$disconnect()
  })

  it('reloads only requested public authorized rows across publication, time and tenant fences', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID()
      const tenantId = `evidence-${suffix}`
      const otherTenantId = `other-${suffix}`
      const venueId = `venue-${suffix}`
      const otherVenueId = `other-venue-${suffix}`
      const asOf = new Date('2026-11-01T15:00:00Z')
      for (const [tenant, venue] of [
        [tenantId, venueId],
        [otherTenantId, otherVenueId],
      ]) {
        await db.tenant.create({
          data: { id: tenant!, name: 'Fictional evidence fixture', slug: tenant! },
        })
        await db.venue.create({
          data: { id: venue!, tenantId: tenant!, name: 'Fictional lantern hall', slug: venue! },
        })
      }
      const ids: string[] = []
      for (const status of [
        'public',
        'unrequested',
        'disabled',
        'second-layer',
        'foreign',
        'source',
      ]) {
        const id = `${status}-${suffix}`
        if (status !== 'unrequested') ids.push(id)
        await db.venueKnowledgeEntry.create({
          data: {
            id,
            tenantId: status === 'foreign' ? otherTenantId : tenantId,
            venueId: status === 'foreign' ? otherVenueId : venueId,
            title: `Lantern ${status}`,
            category: 'GENERAL',
            content: `Fictional ${status} facts.`,
            isEnabled: status !== 'disabled',
            visibility: status === 'second-layer' ? 'SECOND_LAYER' : 'PUBLIC',
            sourceType: status === 'source' ? 'SOURCE_CONNECTION' : 'FOUNDER_PROVIDED',
          },
        })
      }
      let publishedKnowledgeId = ''
      for (const status of ['published', 'unpublished', 'expired', 'future', 'withdrawn']) {
        const moduleId = `module-${status}-${suffix}`
        const revisionId = `revision-${status}-${suffix}`
        const publicationId = `publication-${status}-${suffix}`
        const id = `knowledge-${status}-${suffix}`
        if (status === 'unpublished') ids.push(id)
        await db.contentModuleIdentity.create({
          data: { id: moduleId, tenantId, venueId, kind: 'POLICY' },
        })
        await db.contentModuleRevision.create({
          data: {
            id: revisionId,
            moduleId,
            tenantId,
            venueId,
            kind: 'POLICY',
            version: 1,
            audience: 'PUBLIC',
            createdBy: 'disposable-test',
            effectiveUntil: status === 'expired' ? asOf : null,
            effectiveFrom: status === 'future' ? new Date('2026-11-02T00:00:00Z') : null,
          },
        })
        await db.policyContent.create({
          data: {
            revisionId,
            tenantId,
            venueId,
            title: `Lantern ${status}`,
            rule: `Fictional ${status} policy.`,
            appliesTo: [],
          },
        })
        if (status !== 'unpublished')
          await db.contentModulePublication.create({
            data: {
              id: publicationId,
              tenantId,
              venueId,
              moduleId,
              revisionId,
              moduleKind: 'POLICY',
              action: 'PUBLISH',
              requestId: randomUUID(),
              actorId: 'disposable-test',
            },
          })
        if (status !== 'unpublished') {
          const projection = await db.venueKnowledgeEntry.findFirstOrThrow({
            where: { tenantId, venueId, contentModuleId: moduleId },
            select: { id: true },
          })
          ids.push(projection.id)
          if (status === 'published') publishedKnowledgeId = projection.id
        }
        if (status === 'withdrawn')
          await db.contentModulePublication.create({
            data: {
              tenantId,
              venueId,
              moduleId,
              revisionId,
              moduleKind: 'POLICY',
              action: 'WITHDRAW',
              requestId: randomUUID(),
              actorId: 'disposable-test',
            },
          })
      }
      const placeIds: string[] = []
      for (const status of ['public', 'disabled', 'second-layer', 'foreign']) {
        const id = `place-${status}-${suffix}`
        placeIds.push(id)
        await db.place.create({
          data: {
            id,
            tenantId: status === 'foreign' ? otherTenantId : tenantId,
            venueId: status === 'foreign' ? otherVenueId : venueId,
            name: `Fictional ${status} hall`,
            type: 'EXHIBIT',
            tags: [],
            isActive: status !== 'disabled',
            visibility: status === 'second-layer' ? 'SECOND_LAYER' : 'PUBLIC',
          },
        })
      }
      const result = await loadGuestVenueDirectory({
        reader: db,
        tenantId,
        venueId,
        asOf,
        includeSecondLayer: false,
        onlyIds: { knowledge: ids, places: placeIds },
      })
      expect(result.knowledge.map((row) => row.id).sort()).toEqual(
        [`public-${suffix}`, publishedKnowledgeId].sort(),
      )
      expect(result.places.map((row) => row.id)).toEqual([`place-public-${suffix}`])
      expect(result.incomplete).toBe(false)
      const empty = await loadGuestVenueDirectory({
        reader: db,
        tenantId,
        venueId,
        asOf,
        includeSecondLayer: false,
        onlyIds: { knowledge: [], places: [] },
      })
      expect(empty.knowledge).toEqual([])
      expect(empty.places).toEqual([])
    })
  }, 30_000)
})
