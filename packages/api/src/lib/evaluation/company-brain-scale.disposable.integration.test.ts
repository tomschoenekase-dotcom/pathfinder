import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import {
  db,
  getCompactAccountContext,
  searchCompanyKnowledge,
  withTenantIsolationBypass,
} from '@pathfinder/db'

const enabled =
  process.env.RUN_COMPANY_BRAIN_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

describe.skipIf(!enabled)('Company Brain disposable scale proof', () => {
  afterAll(async () => db.$disconnect())

  it('keeps mature-account context and knowledge retrieval bounded at realistic synthetic scale', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-scale-${suffix}`
      const venueId = `venue-scale-${suffix}`
      const organizationId = `org-scale-${suffix}`
      const actorId = `admin-scale-${suffix}`
      await db.user.create({
        data: { id: actorId, email: `${actorId}@example.test`, fullName: 'Scale Admin' },
      })
      await db.tenant.create({ data: { id: tenantId, name: 'Scale Museum', slug: tenantId } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Scale Museum Main', slug: venueId },
      })
      await db.prospectOrganization.create({
        data: {
          id: organizationId,
          canonicalName: 'Scale Museum',
          normalizedName: `scale-museum-${suffix}`,
          organizationType: 'MUSEUM',
          createdBy: actorId,
          updatedBy: actorId,
        },
      })
      await db.prospectCustomerRelationship.create({
        data: {
          organizationId,
          tenantId,
          idempotencyKey: `scale-relationship-${suffix}`,
          createdBy: actorId,
        },
      })

      const base = Date.now() - 86_400_000 * 2_000
      await db.accountMilestone.createMany({
        data: Array.from({ length: 1_200 }, (_, index) => ({
          tenantId,
          venueId,
          organizationId,
          type: index === 0 ? ('FIRST_OUTREACH' as const) : ('EXPANSION' as const),
          occurredAt: new Date(base + index * 86_400_000),
          sourceType: 'IMPORT' as const,
          sourceId: `scale-milestone-${index}`,
          idempotencyKey: `scale-milestone-${suffix}-${index}`,
        })),
      })
      await db.accountRelationshipNote.createMany({
        data: Array.from({ length: 600 }, (_, index) => ({
          tenantId,
          venueId,
          organizationId,
          category: 'RELATIONSHIP' as const,
          body: `Durable relationship observation ${index}`,
          authority: 'DURABLE_CONTEXT' as const,
          promotionStatus: 'PROMOTED' as const,
          sourceType: 'IMPORT' as const,
          sourceId: `scale-note-${index}`,
          contentHash: digest(`scale-note-${suffix}-${index}`),
          createdByType: 'SYSTEM' as const,
          createdById: actorId,
          idempotencyKey: `scale-note-${suffix}-${index}`,
        })),
      })
      await db.accountOpenLoop.createMany({
        data: Array.from({ length: 300 }, (_, index) => ({
          tenantId,
          venueId,
          organizationId,
          title: `Scale follow-up ${index}`,
          waitingOn: index % 2 === 0 ? ('CLIENT' as const) : ('TORCHIKO' as const),
          sourceType: 'IMPORT' as const,
          sourceId: `scale-loop-${index}`,
          idempotencyKey: `scale-loop-${suffix}-${index}`,
        })),
      })
      await db.companyKnowledgeItem.createMany({
        data: Array.from({ length: 2_000 }, (_, index) => ({
          tenantId,
          venueId,
          organizationId,
          type: index % 4 === 0 ? ('DECISION' as const) : ('CLIENT_INSIGHT' as const),
          title: `Museum onboarding lesson ${index}`,
          summary:
            index === 1_999
              ? 'Current outdoor venue onboarding policy requires a weather fallback.'
              : `Historical museum onboarding observation ${index}`,
          accessScope: 'TENANT' as const,
          authority:
            index === 1_999 ? ('AUTHORITATIVE_CURRENT' as const) : ('DURABLE_CONTEXT' as const),
          promotionStatus: 'PROMOTED' as const,
          contentHash: digest(`scale-knowledge-${suffix}-${index}`),
          createdByType: 'SYSTEM' as const,
          createdById: actorId,
          idempotencyKey: `scale-knowledge-${suffix}-${index}`,
          effectiveAt: new Date(base + index * 86_400_000),
          lastConfirmedAt: new Date(base + index * 86_400_000),
        })),
      })

      const contextStarted = performance.now()
      const context = await getCompactAccountContext({
        clientId: tenantId,
        organizationId,
        venueId,
        recentLimit: 8,
      })
      const contextMs = performance.now() - contextStarted
      expect(context.payload.withinTarget).toBe(true)
      expect(context.milestones.length).toBeLessThanOrEqual(12)
      expect(context.relationship.notes.length).toBeLessThanOrEqual(8)
      expect(context.openLoops.length).toBeLessThanOrEqual(10)

      const searchStarted = performance.now()
      const search = await searchCompanyKnowledge(
        {
          query: 'current outdoor venue onboarding weather fallback policy',
          clientId: tenantId,
          venueId,
          organizationId,
          types: ['DECISION', 'CLIENT_INSIGHT'],
          authorities: ['AUTHORITATIVE_CURRENT', 'DURABLE_CONTEXT'],
          limit: 5,
        },
        { kind: 'CLIENT', clientId: tenantId, roles: ['OWNER'] },
      )
      const searchMs = performance.now() - searchStarted
      expect(search.results).toHaveLength(5)
      expect(search.results[0]).toMatchObject({ authority: 'AUTHORITATIVE_CURRENT' })
      expect(search.payload.withinTarget).toBe(true)
      expect(search.results.length).toBeLessThanOrEqual(5)

      // Generous CI ceiling; payload/collection assertions are the hard scale contract.
      expect(contextMs).toBeLessThan(3_000)
      expect(searchMs).toBeLessThan(3_000)
    })
  }, 30_000)
})
