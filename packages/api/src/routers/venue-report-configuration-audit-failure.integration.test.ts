import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/jobs', () => ({
  enqueueGenerationDispatchKick: vi.fn(),
  enqueueWeeklyDigest: vi.fn(),
}))

vi.mock('@pathfinder/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/auth')>()
  return { ...actual, createOrganization: vi.fn(), currentUser: vi.fn() }
})

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { adminRouter } from './admin/_admin'

const runIntegration = process.env.RUN_VENUE_REPORT_AUDIT_FAILURE_INTEGRATION === '1'
const integrationDescribe = runIntegration ? describe : describe.skip
const suffix = randomUUID().slice(0, 8)
const tenantId = `report-audit-failure-tenant-${suffix}`
const venueId = `report-audit-failure-venue-${suffix}`
const app = router({ admin: adminRouter })
let disposableConfirmed = false

function assertDisposableDatabase(): void {
  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) throw new Error('DATABASE_URL is required for report audit integration')
  const url = new URL(rawUrl)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(host) ||
    url.port.length === 0 ||
    !/^pathfinder_disposable_[a-z0-9_]+$/.test(database)
  ) {
    throw new Error('Report audit integration requires a loopback pathfinder_disposable_* database')
  }
}

function adminCaller() {
  return app.createCaller({
    db,
    headers: new Headers(),
    session: {
      userId: `report-audit-failure-admin-${suffix}`,
      activeTenantId: null,
      role: null,
      isPlatformAdmin: true,
    },
  } satisfies TRPCContext).admin
}

integrationDescribe('venue report configuration audit rollback integration', () => {
  beforeAll(async () => {
    assertDisposableDatabase()
    disposableConfirmed = true
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: venueId, slug: venueId },
      })
    })
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION pathfinder_test_reject_report_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.actor_id LIKE 'report-audit-failure-admin-%'
           AND NEW.action IN ('admin.venue-reports.enabled', 'admin.venue-reports.disabled', 'admin.report.published') THEN
          RAISE EXCEPTION 'deliberate report audit integration failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `)
    await db.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS pathfinder_test_reject_report_audit ON audit_logs',
    )
    await db.$executeRawUnsafe(`
      CREATE TRIGGER pathfinder_test_reject_report_audit
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION pathfinder_test_reject_report_audit()
    `)
  })

  afterAll(async () => {
    if (!disposableConfirmed) return
    try {
      await withTenantIsolationBypass(async () => {
        await db.weeklyReport.deleteMany({ where: { tenantId } })
        await db.auditLog.deleteMany({ where: { tenantId } })
        await db.venueReportConfiguration.deleteMany({ where: { tenantId } })
        await db.$executeRaw`DELETE FROM "venues" WHERE "tenant_id" = ${tenantId}`
        // The disposable database is the cleanup boundary for immutable content history.
      })
    } finally {
      try {
        await db.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS pathfinder_test_reject_report_audit ON audit_logs',
        )
        await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS pathfinder_test_reject_report_audit()')
      } finally {
        await db.$disconnect()
      }
    }
  })

  it('rolls the configuration back when strict audit persistence fails', async () => {
    const admin = adminCaller()

    await expect(
      admin.updateVenueReportConfiguration({
        tenantId,
        venueId,
        enabled: true,
        expectedUpdatedAt: null,
      }),
    ).rejects.toBeTruthy()

    await expect(
      withTenantIsolationBypass(() =>
        db.venueReportConfiguration.count({ where: { tenantId, venueId } }),
      ),
    ).resolves.toBe(0)
  })

  it('rolls a report publication back when strict audit persistence fails', async () => {
    const reportId = randomUUID()
    const updatedAt = await withTenantIsolationBypass(async () => {
      await db.venueReportConfiguration.create({
        data: {
          tenantId,
          venueId,
          enabled: true,
          updatedBy: 'integration-setup',
        },
      })
      const report = await db.weeklyReport.create({
        data: {
          id: reportId,
          tenantId,
          venueId,
          weekStart: new Date('2026-08-01T00:00:00.000Z'),
          weekEnd: new Date('2026-08-07T23:59:59.999Z'),
          status: 'DRAFT',
          content: 'Reviewed report content',
          createdBy: 'integration-setup',
        },
        select: { updatedAt: true },
      })
      return report.updatedAt
    })

    await expect(
      adminCaller().publishWeeklyReport({
        tenantId,
        venueId,
        reportId,
        expectedUpdatedAt: updatedAt.toISOString(),
      }),
    ).rejects.toBeTruthy()

    await expect(
      withTenantIsolationBypass(() =>
        db.weeklyReport.findFirst({
          where: { id: reportId, tenantId, venueId },
          select: { status: true, publishedAt: true },
        }),
      ),
    ).resolves.toEqual({ status: 'DRAFT', publishedAt: null })
  })
})
