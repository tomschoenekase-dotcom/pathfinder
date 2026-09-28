import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminProspectCrmDirectoryRouter } from './prospect-crm-directory'
import { prospectGoodFitVenueWhere } from './prospect-crm-good-fit'

const run = process.env.RUN_PROSPECT_SIZE_DB_INTEGRATION === '1' ? describe : describe.skip

run('Good fit SQL predicate on a disposable database', () => {
  it('admits a measured museum with missing optional JSON paths and excludes a stadium tagged M', async () => {
    const suffix = randomUUID()
    const territoryId = `packet7-fit-territory-${suffix}`
    const organizationId = `packet7-fit-org-${suffix}`
    const venueId = `packet7-fit-venue-${suffix}`
    const stadiumOrganizationId = `packet7-fit-stadium-org-${suffix}`
    const stadiumVenueId = `packet7-fit-stadium-venue-${suffix}`
    const actor = 'packet7-disposable-human'
    const fitAttributes = {
      torchikoSizeV1: {
        class: 'M',
        basis: 'seats',
        value: 1_500,
        unit: 'seats',
        sourceUrl: 'https://example.org/synthetic-capacity',
        observedAt: '2026-09-27',
        confidence: 'measured',
      },
      torchikoTriageV1: {
        normalizedType: 'museum',
      },
      torchikoFounderPriorityV1: { bucket: 'MID_TIER_PRIORITY' },
    }
    try {
      await withTenantIsolationBypass(async () => {
        await db.prospectTerritory.create({
          data: {
            id: territoryId,
            name: 'Packet 7 Chicago',
            code: `P7${suffix.slice(0, 16)}`,
            createdBy: actor,
            updatedBy: actor,
          },
        })
        for (const [orgId, id, name] of [
          [organizationId, venueId, 'Synthetic Museum'],
          [stadiumOrganizationId, stadiumVenueId, 'Synthetic Stadium'],
        ]) {
          await db.prospectOrganization.create({
            data: {
              id: orgId!,
              canonicalName: name!,
              normalizedName: name!.toLowerCase(),
              territoryId,
              createdBy: actor,
              updatedBy: actor,
            },
          })
          await db.prospectVenue.create({
            data: {
              id: id!,
              organizationId: orgId!,
              name: name!,
              normalizedName: name!.toLowerCase(),
              venueType: 'museum',
              estimatedSize: 'M',
              fitAttributes,
              createdBy: actor,
              updatedBy: actor,
            },
          })
        }
      })
      const matching = await withTenantIsolationBypass(() =>
        db.prospectVenue.findMany({
          where: {
            AND: [
              prospectGoodFitVenueWhere(territoryId),
              { id: { in: [venueId, stadiumVenueId] } },
            ],
          },
          select: { id: true },
        }),
      )
      expect(matching.map((venue) => venue.id)).toEqual([venueId])
      const caller = router({ crm: adminProspectCrmDirectoryRouter }).createCaller({
        db: {} as TRPCContext['db'],
        headers: new Headers(),
        session: { userId: actor, activeTenantId: null, role: null, isPlatformAdmin: true },
      } as TRPCContext).crm
      const directory = await caller.listProspects({ goodFit: true, territoryId, limit: 10 })
      expect(directory.items.map((row) => row.id)).toEqual([organizationId])
      expect(directory.items[0]?.venues[0]?.goodFit?.qualifies).toBe(true)
    } finally {
      await withTenantIsolationBypass(async () => {
        await db.prospectVenue.deleteMany({ where: { id: { in: [venueId, stadiumVenueId] } } })
        await db.prospectOrganization.deleteMany({
          where: { id: { in: [organizationId, stadiumOrganizationId] } },
        })
        await db.prospectTerritory.deleteMany({ where: { id: territoryId } })
      })
    }
  })
})
