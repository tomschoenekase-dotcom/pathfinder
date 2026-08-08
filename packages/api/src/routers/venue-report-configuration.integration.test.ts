import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/jobs', () => ({
  enqueueGenerationDispatchKick: vi.fn().mockResolvedValue(undefined),
  enqueueWeeklyDigest: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@pathfinder/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/auth')>()
  return {
    ...actual,
    createOrganization: vi.fn(),
    currentUser: vi.fn(),
  }
})

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { adminRouter } from './admin/_admin'
import { analyticsRouter } from './analytics'

const runIntegration = process.env.RUN_VENUE_REPORT_CONFIGURATION_INTEGRATION === '1'
const integrationDescribe = runIntegration ? describe : describe.skip

const suffix = randomUUID().slice(0, 8)
const tenantId = `report-config-tenant-${suffix}`
const otherTenantId = `report-config-other-${suffix}`
const venueId = `report-config-venue-${suffix}`
const otherVenueId = `report-config-unconfigured-venue-${suffix}`
const app = router({ admin: adminRouter, analytics: analyticsRouter })
let disposableConfirmed = false

function assertDisposableDatabase(): void {
  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) throw new Error('DATABASE_URL is required for report configuration integration')
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
      'Report configuration integration requires a loopback pathfinder_disposable_* database',
    )
  }
}

function adminCaller() {
  return app.createCaller({
    db,
    headers: new Headers(),
    session: {
      userId: `report-config-admin-${suffix}`,
      activeTenantId: null,
      role: null,
      isPlatformAdmin: true,
    },
  } satisfies TRPCContext).admin
}

function tenantCaller() {
  return app.createCaller({
    db,
    headers: new Headers(),
    session: {
      userId: `report-config-staff-${suffix}`,
      activeTenantId: tenantId,
      role: 'STAFF',
      isPlatformAdmin: false,
    },
  } satisfies TRPCContext)
}

integrationDescribe('venue report configuration integration', () => {
  beforeAll(async () => {
    assertDisposableDatabase()
    disposableConfirmed = true
    await withTenantIsolationBypass(async () => {
      await db.tenant.createMany({
        data: [
          { id: tenantId, name: 'Report Configuration Tenant', slug: tenantId },
          { id: otherTenantId, name: 'Other Report Tenant', slug: otherTenantId },
        ],
      })
      await db.venue.createMany({
        data: [
          {
            id: venueId,
            tenantId,
            name: 'Report Configuration Venue',
            slug: venueId,
          },
          {
            id: otherVenueId,
            tenantId,
            name: 'Unconfigured Report Venue',
            slug: otherVenueId,
          },
        ],
      })
    })
  })

  afterAll(async () => {
    if (!disposableConfirmed) return
    await withTenantIsolationBypass(async () => {
      await db.generationRequestDispatch.deleteMany({ where: { tenantId } })
      await db.weeklyReport.deleteMany({ where: { tenantId } })
      await db.auditLog.deleteMany({ where: { tenantId } })
      await db.venueReportConfiguration.deleteMany({ where: { tenantId } })
      await db.$executeRaw`DELETE FROM "venues" WHERE "tenant_id" = ${tenantId}`
      // ContentVersion rows are intentionally append-only and retain the synthetic
      // tenant FK until the required disposable database is dropped as a whole.
      await db.tenant.deleteMany({ where: { id: otherTenantId } })
    })
    await db.$disconnect()
  })

  it('defaults off, preserves published history across disable, and enforces tenant ownership', async () => {
    const admin = adminCaller()
    const tenant = tenantCaller()

    await expect(admin.getVenueReportConfiguration({ tenantId, venueId })).resolves.toMatchObject({
      enabled: false,
      updatedAt: null,
    })
    await expect(tenant.analytics.listPublishedWeeklyReports({ venueId })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })

    const enabled = await admin.updateVenueReportConfiguration({
      tenantId,
      venueId,
      enabled: true,
      expectedUpdatedAt: null,
    })
    expect(enabled).toMatchObject({ enabled: true, replayed: false })

    const publishedId = randomUUID()
    await withTenantIsolationBypass(() =>
      db.weeklyReport.create({
        data: {
          id: publishedId,
          tenantId,
          venueId,
          weekStart: new Date('2026-07-01T00:00:00.000Z'),
          weekEnd: new Date('2026-07-07T23:59:59.999Z'),
          status: 'PUBLISHED',
          content: 'Published report body',
          publishedAt: new Date('2026-07-08T12:00:00.000Z'),
          createdBy: 'integration-admin',
        },
      }),
    )
    await expect(tenant.analytics.listPublishedWeeklyReports({ venueId })).resolves.toEqual([
      expect.objectContaining({ id: publishedId, content: 'Published report body' }),
    ])

    const disabled = await admin.updateVenueReportConfiguration({
      tenantId,
      venueId,
      enabled: false,
      expectedUpdatedAt: enabled.updatedAt,
    })
    expect(disabled.enabled).toBe(false)
    await expect(tenant.analytics.listPublishedWeeklyReports({ venueId })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    await expect(
      withTenantIsolationBypass(() =>
        db.weeklyReport.count({ where: { tenantId, id: publishedId } }),
      ),
    ).resolves.toBe(1)

    await expect(
      withTenantIsolationBypass(() =>
        db.venueReportConfiguration.create({
          data: {
            tenantId: otherTenantId,
            venueId: otherVenueId,
            enabled: true,
            updatedBy: 'cross-tenant-attempt',
          },
        }),
      ),
    ).rejects.toBeTruthy()
  })

  it('allows a configured venue to be deleted and cascades only its configuration', async () => {
    const deleteVenueId = `report-config-delete-venue-${suffix}`
    await withTenantIsolationBypass(async () => {
      await db.venue.create({
        data: {
          id: deleteVenueId,
          tenantId,
          name: 'Configured deletion venue',
          slug: deleteVenueId,
        },
      })
      await db.venueReportConfiguration.create({
        data: { tenantId, venueId: deleteVenueId, enabled: false, updatedBy: 'integration-setup' },
      })
      await db.$executeRaw`
        DELETE FROM "venues"
        WHERE "id" = ${deleteVenueId} AND "tenant_id" = ${tenantId}
      `
    })
    await expect(
      withTenantIsolationBypass(() =>
        db.venueReportConfiguration.count({ where: { tenantId, venueId: deleteVenueId } }),
      ),
    ).resolves.toBe(0)
  })

  it('serializes a new report request with disabling and never creates after disable wins', async () => {
    const admin = adminCaller()
    const current = await admin.getVenueReportConfiguration({ tenantId, venueId })
    const enabled = await admin.updateVenueReportConfiguration({
      tenantId,
      venueId,
      enabled: true,
      expectedUpdatedAt: current.updatedAt,
    })
    const requestId = randomUUID()
    const reportsBefore = await withTenantIsolationBypass(() =>
      db.weeklyReport.count({ where: { tenantId, venueId } }),
    )

    const [disableResult, generationResult] = await Promise.allSettled([
      admin.updateVenueReportConfiguration({
        tenantId,
        venueId,
        enabled: false,
        expectedUpdatedAt: enabled.updatedAt,
      }),
      admin.generateWeeklyReportDraft({
        tenantId,
        venueId,
        weekStart: '2026-07-08T00:00:00.000Z',
        weekEnd: '2026-07-14T23:59:59.999Z',
        requestId,
      }),
    ])

    expect(disableResult.status).toBe('fulfilled')
    const reportsAfter = await withTenantIsolationBypass(() =>
      db.weeklyReport.count({ where: { tenantId, venueId } }),
    )
    expect(reportsAfter - reportsBefore).toBe(generationResult.status === 'fulfilled' ? 1 : 0)
    if (generationResult.status === 'rejected') {
      expect(generationResult.reason).toMatchObject({ code: 'PRECONDITION_FAILED' })
    }
    await expect(
      admin.generateWeeklyReportDraft({
        tenantId,
        venueId,
        weekStart: '2026-07-15T00:00:00.000Z',
        weekEnd: '2026-07-21T23:59:59.999Z',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
