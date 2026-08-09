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
import { venueRouter } from './venue'

const runIntegration = process.env.RUN_VENUE_AVAILABILITY_INTEGRATION === '1'
const integrationDescribe = runIntegration ? describe : describe.skip
const suffix = randomUUID().replaceAll('-', '').slice(0, 24)
const tenantId = `venue-availability-tenant-${suffix}`
const venueId = `c${suffix}`
const app = router({ admin: adminRouter, venue: venueRouter })
let disposableConfirmed = false

function assertDisposableDatabase(): void {
  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) throw new Error('DATABASE_URL is required for venue availability integration')
  const url = new URL(rawUrl)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(host) ||
    url.port.length === 0 ||
    !/^pathfinder_disposable_[a-z0-9_]+$/.test(database)
  ) {
    throw new Error('Venue availability integration requires a loopback disposable database')
  }
}

function context(options: {
  userId: string
  activeTenantId: string | null
  role: 'MANAGER' | null
  isPlatformAdmin: boolean
}): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: options,
  }
}

integrationDescribe('venue availability cross-surface concurrency', () => {
  beforeAll(async () => {
    assertDisposableDatabase()
    disposableConfirmed = true
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: tenantId, name: 'Venue Availability Integration', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Availability Venue', slug: venueId },
      })
    })
  })

  afterAll(async () => {
    if (disposableConfirmed) await db.$disconnect()
  })

  it('serializes tenant and platform-admin writes so one exact revision wins', async () => {
    const manager = app.createCaller(
      context({
        userId: `manager-${suffix}`,
        activeTenantId: tenantId,
        role: 'MANAGER',
        isPlatformAdmin: false,
      }),
    )
    const admin = app.createCaller(
      context({
        userId: `admin-${suffix}`,
        activeTenantId: null,
        role: null,
        isPlatformAdmin: true,
      }),
    )
    const initial = await admin.admin.getVenueAvailability({ tenantId, venueId })

    const results = await Promise.allSettled([
      manager.venue.setAvailability({
        venueId,
        enabled: false,
        expectedUpdatedAt: initial.updatedAt,
        reason: 'Tenant incident response',
      }),
      admin.admin.setVenueAvailability({
        tenantId,
        venueId,
        enabled: false,
        expectedUpdatedAt: initial.updatedAt,
        reason: 'Platform incident response',
      }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } })

    await expect(admin.admin.getVenueAvailability({ tenantId, venueId })).resolves.toMatchObject({
      isActive: false,
    })
    await expect(
      withTenantIsolationBypass(() =>
        db.auditLog.count({
          where: {
            tenantId,
            targetType: 'Venue',
            targetId: venueId,
            action: {
              in: ['venue.availability.disabled', 'admin.venue-availability.disabled'],
            },
          },
        }),
      ),
    ).resolves.toBe(1)
  })
})
