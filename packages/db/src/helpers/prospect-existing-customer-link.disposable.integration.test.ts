import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

import * as audit from './audit'

import {
  createProspectAction,
  db,
  linkProspectConversionAction,
  withTenantIsolationBypass,
} from '../index'

const enabled =
  process.env.RUN_PROSPECT_CRM_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

async function fixture() {
  const suffix = randomUUID().slice(0, 8)
  const actor = { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: `repair-${suffix}` } as const
  const customers = await Promise.all(
    ['alpha', 'beta'].map(async (label) => {
      const tenant = await db.tenant.create({
        data: {
          id: `repair-${label}-${suffix}`,
          name: `Fictional ${label} ${suffix}`,
          slug: `repair-${label}-${suffix}`,
        },
      })
      const venue = await db.venue.create({
        data: { tenantId: tenant.id, name: `Fictional ${label}`, slug: tenant.id },
      })
      const prospect = await createProspectAction({
        organization: { canonicalName: `Fictional ${label} ${suffix}`, source: 'repair-db-test' },
        venue: { name: `Fictional prospect ${label}` },
        actor,
      })
      return { tenant, venue, prospect }
    }),
  )
  const [alpha, beta] = customers
  if (!alpha || !beta) throw new Error('Missing disposable fixtures')
  const input = {
    organizationId: alpha.prospect.organization.id,
    prospectVenueId: alpha.prospect.venue!.id,
    tenantId: alpha.tenant.id,
    venueId: alpha.venue.id,
    existingLink: {
      expectedVersion:
        1 +
        (await db.prospectActivity.count({
          where: { organizationId: alpha.prospect.organization.id },
        })),
    },
    actor,
  }
  const organizationIds = customers.map((customer) => customer.prospect.organization.id)
  const tenantIds = customers.map((customer) => customer.tenant.id)
  async function snapshot() {
    return {
      tenants: await db.tenant.count({ where: { id: { in: tenantIds } } }),
      venues: await db.venue.count({ where: { tenantId: { in: tenantIds } } }),
      relationships: await db.prospectCustomerRelationship.count({
        where: { organizationId: { in: organizationIds } },
      }),
      locations: await db.prospectLocationConversion.count({
        where: { tenantId: { in: tenantIds } },
      }),
      activities: await db.prospectActivity.count({
        where: { organizationId: { in: organizationIds } },
      }),
      audits: await db.auditLog.count({
        where: { actorId: actor.id, action: 'admin.prospect.converted' },
      }),
      opportunities: await db.prospectOpportunity.findMany({
        where: { organizationId: { in: organizationIds } },
        orderBy: { organizationId: 'asc' },
      }),
      stages: await db.prospectStageHistory.count({
        where: { opportunity: { organizationId: { in: organizationIds } } },
      }),
    }
  }
  return { alpha, beta, input, snapshot }
}

describe.skipIf(!enabled)(
  'existing customer repair on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    afterAll(async () => db.$disconnect())

    it('inserts once, replays exactly, and preserves customer identities and sales state', async () => {
      await withTenantIsolationBypass(async () => {
        const { input, snapshot } = await fixture()
        const before = await snapshot()
        const first = await linkProspectConversionAction(input)
        expect(first.replayed).toBe(false)
        const after = await snapshot()
        expect(after).toEqual({
          ...before,
          relationships: before.relationships + 1,
          locations: before.locations + 1,
          activities: before.activities + 1,
          audits: before.audits + 1,
        })
        const replay = await linkProspectConversionAction(input)
        expect(replay.replayed).toBe(true)
        expect(replay.relationship.id).toBe(first.relationship.id)
        expect(replay.locationConversion?.id).toBe(first.locationConversion?.id)
        expect(await snapshot()).toEqual(after)
      })
    })

    it('refuses crossed identities and existing canonical ownership without any writes', async () => {
      await withTenantIsolationBypass(async () => {
        const { beta, input, snapshot } = await fixture()
        const before = await snapshot()
        for (const patch of [
          { tenantId: beta.tenant.id },
          { prospectVenueId: beta.prospect.venue!.id },
        ]) {
          await expect(linkProspectConversionAction({ ...input, ...patch })).rejects.toMatchObject({
            code: 'INVALID_INPUT',
          })
          expect(await snapshot()).toEqual(before)
        }
        await linkProspectConversionAction(input)
        const linked = await snapshot()
        await expect(
          linkProspectConversionAction({
            ...input,
            tenantId: beta.tenant.id,
            venueId: beta.venue.id,
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(await snapshot()).toEqual(linked)
      })
    })

    it('rolls back every repair write when the final strict audit write fails', async () => {
      await withTenantIsolationBypass(async () => {
        const { input, snapshot } = await fixture()
        const before = await snapshot()
        const failure = new Error('Disposable repair audit failure')
        const auditWrite = vi.spyOn(audit, 'writeAuditLogStrict').mockRejectedValueOnce(failure)
        try {
          await expect(linkProspectConversionAction(input)).rejects.toThrow(failure)
          expect(auditWrite).toHaveBeenCalledOnce()
          expect(await snapshot()).toEqual(before)
        } finally {
          auditWrite.mockRestore()
        }
        const recovered = await linkProspectConversionAction(input)
        expect(recovered.replayed).toBe(false)
        expect(await snapshot()).toEqual({
          ...before,
          relationships: before.relationships + 1,
          locations: before.locations + 1,
          activities: before.activities + 1,
          audits: before.audits + 1,
        })
      })
    })

    it('allows only one of two concurrent competing customer repairs to commit', async () => {
      await withTenantIsolationBypass(async () => {
        const { beta, input, snapshot } = await fixture()
        const before = await snapshot()
        const results = await Promise.allSettled([
          linkProspectConversionAction(input),
          linkProspectConversionAction({
            ...input,
            tenantId: beta.tenant.id,
            venueId: beta.venue.id,
          }),
        ])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
        expect(await snapshot()).toEqual({
          ...before,
          relationships: before.relationships + 1,
          locations: before.locations + 1,
          activities: before.activities + 1,
          audits: before.audits + 1,
        })
        const winner = results.find((result) => result.status === 'fulfilled')
        if (!winner || winner.status !== 'fulfilled') throw new Error('No committed repair')
        const relationship = winner.value.relationship
        const location = winner.value.locationConversion
        expect(relationship.organizationId).toBe(input.organizationId)
        expect(location?.tenantId).toBe(relationship.tenantId)
        expect(location?.relationshipId).toBe(relationship.id)
        expect(location?.venueId).toBe(
          relationship.tenantId === input.tenantId ? input.venueId : beta.venue.id,
        )
      })
    })
  },
)
