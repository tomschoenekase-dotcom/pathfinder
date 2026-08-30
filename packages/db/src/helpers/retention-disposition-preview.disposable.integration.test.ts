import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { previewRetentionDispositionAction } from './retention-disposition-preview'

const enabled =
  process.env.RUN_RETENTION_DISPOSITION_PREVIEW_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_retention_preview_[a-z0-9]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('retention disposition preview disposable evidence', () => {
  afterAll(async () => db.$disconnect())

  it('counts only the exact client, exposes coverage gaps, and performs no disposition effect', async () => {
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `tenant-retention-${suffix}`
    const otherTenantId = `tenant-retention-other-${suffix}`
    const venueId = `venue-retention-${suffix}`
    const otherVenueId = `venue-retention-other-${suffix}`

    await withTenantIsolationBypass(async () => {
      await db.tenant.createMany({
        data: [
          { id: tenantId, name: 'Synthetic retention tenant', slug: tenantId },
          { id: otherTenantId, name: 'Synthetic other tenant', slug: otherTenantId },
        ],
      })
      await db.venue.createMany({
        data: [
          { id: venueId, tenantId, name: 'Synthetic Retention Venue', slug: venueId },
          {
            id: otherVenueId,
            tenantId: otherTenantId,
            name: 'Synthetic Other Venue',
            slug: otherVenueId,
          },
        ],
      })
      await db.visitorSession.createMany({
        data: [
          {
            id: `session-${suffix}`,
            tenantId,
            venueId,
            anonymousToken: randomUUID(),
            experienceScope: 'PUBLIC',
          },
          {
            id: `session-other-${suffix}`,
            tenantId: otherTenantId,
            venueId: otherVenueId,
            anonymousToken: randomUUID(),
            experienceScope: 'PUBLIC',
          },
        ],
      })
    })

    const before = {
      tenants: await db.tenant.count(),
      venues: await withTenantIsolationBypass(() => db.venue.count()),
      sessions: await withTenantIsolationBypass(() => db.visitorSession.count()),
      audits: await withTenantIsolationBypass(() => db.auditLog.count()),
    }
    const preview = await previewRetentionDispositionAction(
      { tenantId, generatedAt: new Date('2026-08-25T02:00:00.000Z') },
      db as never,
    )
    const after = {
      tenants: await db.tenant.count(),
      venues: await withTenantIsolationBypass(() => db.venue.count()),
      sessions: await withTenantIsolationBypass(() => db.visitorSession.count()),
      audits: await withTenantIsolationBypass(() => db.auditLog.count()),
    }

    expect(after).toEqual(before)
    expect(preview).toMatchObject({
      mode: 'READ_ONLY_NO_EFFECT',
      tenantExists: true,
      scope: { tenantId, venueIds: null, fullTenantOnly: true },
      policy: { ready: false, policyVersion: null },
      coverage: { unavailableCountModels: 0 },
      boundaries: {
        readyForExecution: false,
        destructiveActionAvailable: false,
        anonymizationActionAvailable: false,
        approvalGrantAvailable: false,
      },
    })
    expect(preview.inventory.find((item) => item.model === 'Tenant')).toMatchObject({
      rowCount: '1',
      countState: 'EXACT',
    })
    expect(preview.inventory.find((item) => item.model === 'Venue')).toMatchObject({
      rowCount: '1',
      countState: 'EXACT',
    })
    expect(preview.inventory.find((item) => item.model === 'VisitorSession')).toMatchObject({
      rowCount: '1',
      countState: 'EXACT',
      decisionKey: 'guest-conversations',
    })
    expect(preview.inventory.find((item) => item.model === 'ProspectEmailMessage')).toMatchObject({
      rowCount: null,
      countState: 'UNSCOPED',
      scopeClass: 'PLATFORM_UNSCOPED',
    })
    expect(preview.blockers).toEqual(
      expect.arrayContaining([
        'UNRESOLVED_POLICY',
        'UNCLASSIFIED_TENANT_DATA',
        'PLATFORM_UNSCOPED_DATA',
        'EXTERNAL_ARTIFACTS_NOT_COUNTED',
        'NO_REVIEWED_EXECUTOR',
      ]),
    )
    expect(preview.blockers).not.toContain('COUNT_UNAVAILABLE')
  })
})
