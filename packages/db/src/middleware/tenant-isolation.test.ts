import { describe, expect, it, vi } from 'vitest'

import {
  PLATFORM_TABLES_LIST,
  TENANTED_TABLES_LIST,
  TenantIsolationError,
  tenantIsolationInternals,
  tenantIsolationMiddleware,
  withTenantIsolationBypass,
} from './tenant-isolation'

function createParams(
  overrides: Partial<Parameters<typeof tenantIsolationMiddleware>[0]> = {},
): Parameters<typeof tenantIsolationMiddleware>[0] {
  return {
    action: 'findMany',
    args: {},
    model: 'TenantMembership',
    ...overrides,
  }
}

function createMockDb() {
  const next = vi.fn(async (params) => params)

  const run = (params: Parameters<typeof tenantIsolationMiddleware>[0]) =>
    tenantIsolationMiddleware(params, next)

  return {
    next,
    venue: {
      findMany: (args: Record<string, unknown> = {}) =>
        run(createParams({ action: 'findMany', args, model: 'Venue' })),
      create: (args: Record<string, unknown>) =>
        run(createParams({ action: 'create', args, model: 'Venue' })),
    },
    place: {
      findMany: (args: Record<string, unknown> = {}) =>
        run(createParams({ action: 'findMany', args, model: 'Place' })),
    },
    tenantMembership: {
      create: (args: Record<string, unknown>) =>
        run(createParams({ action: 'create', args, model: 'TenantMembership' })),
      deleteMany: (args: Record<string, unknown>) =>
        run(createParams({ action: 'deleteMany', args, model: 'TenantMembership' })),
      findMany: (args: Record<string, unknown> = {}) =>
        run(createParams({ action: 'findMany', args, model: 'TenantMembership' })),
      updateMany: (args: Record<string, unknown>) =>
        run(createParams({ action: 'updateMany', args, model: 'TenantMembership' })),
      upsert: (args: Record<string, unknown>) =>
        run(createParams({ action: 'upsert', args, model: 'TenantMembership' })),
    },
    tenantFeatureFlag: {
      createMany: (args: Record<string, unknown>) =>
        run(createParams({ action: 'createMany', args, model: 'TenantFeatureFlag' })),
    },
    user: {
      findMany: (args: Record<string, unknown> = {}) =>
        run(createParams({ action: 'findMany', args, model: 'User' })),
    },
  }
}

describe('tenantIsolationMiddleware', () => {
  it('exports the expected table lists', () => {
    expect(TENANTED_TABLES_LIST).toEqual([
      'TenantMembership',
      'TenantFeatureFlag',
      'Venue',
      'Place',
      'VisitorSession',
      'Message',
      'DataAdapter',
      'OperationalUpdate',
      'AnalyticsEvent',
      'GuestSession',
      'DailyRollup',
      'WeeklyDigest',
    ])
    expect(PLATFORM_TABLES_LIST).toEqual(['User', 'Tenant', 'AuditLog', 'PlatformConfig'])
  })

  it('findMany on a tenanted table with tenantId passes', async () => {
    const db = createMockDb()

    await expect(
      db.tenantMembership.findMany({ where: { tenantId: 'org_1' } }),
    ).resolves.toMatchObject({
      args: { where: { tenantId: 'org_1' } },
      model: 'TenantMembership',
    })
  })

  it('findMany on a tenanted table without tenantId throws', async () => {
    const db = createMockDb()

    await expect(db.tenantMembership.findMany({})).rejects.toEqual(
      new TenantIsolationError('TenantMembership', 'findMany'),
    )
  })

  it('create on a tenanted table with tenantId in data passes', async () => {
    const db = createMockDb()

    await expect(
      db.tenantMembership.create({
        data: { tenantId: 'org_1', role: 'OWNER' },
      }),
    ).resolves.toMatchObject({
      args: { data: { tenantId: 'org_1', role: 'OWNER' } },
      action: 'create',
    })
  })

  it('create on a tenanted table without tenantId throws', async () => {
    const db = createMockDb()

    await expect(
      db.tenantMembership.create({
        data: { role: 'OWNER' },
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantMembership', 'create'))
  })

  it('findMany on a platform table without tenantId passes', async () => {
    const db = createMockDb()

    await expect(db.user.findMany({})).resolves.toMatchObject({
      model: 'User',
      action: 'findMany',
    })
  })

  it('admin bypass allows tenanted queries without tenantId', async () => {
    const db = createMockDb()

    await expect(
      withTenantIsolationBypass(() => db.tenantMembership.findMany({})),
    ).resolves.toMatchObject({
      model: 'TenantMembership',
      action: 'findMany',
    })
  })

  it('updateMany requires where.tenantId', async () => {
    const db = createMockDb()

    await expect(
      db.tenantMembership.updateMany({
        where: { status: 'ACTIVE' },
        data: { status: 'REMOVED' },
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantMembership', 'updateMany'))

    await expect(
      db.tenantMembership.updateMany({
        where: { tenantId: 'org_1', status: 'ACTIVE' },
        data: { status: 'REMOVED' },
      }),
    ).resolves.toMatchObject({
      action: 'updateMany',
    })
  })

  it('deleteMany requires where.tenantId', async () => {
    const db = createMockDb()

    await expect(
      db.tenantMembership.deleteMany({
        where: { status: 'REMOVED' },
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantMembership', 'deleteMany'))

    await expect(
      db.tenantMembership.deleteMany({
        where: { tenantId: 'org_1' },
      }),
    ).resolves.toMatchObject({
      action: 'deleteMany',
    })
  })

  it('upsert requires create.tenantId but not where.tenantId', async () => {
    const db = createMockDb()

    // Missing tenantId in create — must throw regardless of where
    await expect(
      db.tenantMembership.upsert({
        where: { id: 'membership_1' },
        update: { role: 'MANAGER' },
        create: { userId: 'user_1', role: 'OWNER' },
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantMembership', 'upsert'))

    // create has tenantId but where does not — allowed (where uses a unique key)
    await expect(
      db.tenantMembership.upsert({
        where: { id: 'membership_1' },
        update: { role: 'MANAGER' },
        create: { tenantId: 'org_1', userId: 'user_1', role: 'OWNER' },
      }),
    ).resolves.toMatchObject({ action: 'upsert' })

    // both have tenantId — also allowed
    await expect(
      db.tenantMembership.upsert({
        where: { tenantId: 'org_1' },
        update: { role: 'MANAGER' },
        create: { tenantId: 'org_1', userId: 'user_1', role: 'OWNER' },
      }),
    ).resolves.toMatchObject({ action: 'upsert' })
  })

  it('createMany checks every payload item and ignores nested writes beyond the top-level model', async () => {
    const db = createMockDb()

    await expect(
      db.tenantFeatureFlag.createMany({
        data: [
          { tenantId: 'org_1', flagKey: 'integrations.square' },
          { flagKey: 'analytics.advanced' },
        ],
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantFeatureFlag', 'createMany'))

    await expect(
      db.tenantFeatureFlag.createMany({
        data: [{ tenantId: 'org_1', flagKey: 'integrations.square', memberships: { create: {} } }],
      }),
    ).resolves.toMatchObject({
      action: 'createMany',
    })
  })

  it('findMany on Venue without tenantId throws TenantIsolationError', async () => {
    const db = createMockDb()

    await expect(db.venue.findMany({})).rejects.toEqual(
      new TenantIsolationError('Venue', 'findMany'),
    )
  })

  it('findMany on Venue with tenantId passes', async () => {
    const db = createMockDb()

    await expect(db.venue.findMany({ where: { tenantId: 'org_1' } })).resolves.toMatchObject({
      model: 'Venue',
      action: 'findMany',
    })
  })

  it('create on Venue without tenantId throws TenantIsolationError', async () => {
    const db = createMockDb()

    await expect(db.venue.create({ data: { name: 'City Zoo', slug: 'city-zoo' } })).rejects.toEqual(
      new TenantIsolationError('Venue', 'create'),
    )
  })

  it('findMany on Place without tenantId throws TenantIsolationError', async () => {
    const db = createMockDb()

    await expect(db.place.findMany({})).rejects.toEqual(
      new TenantIsolationError('Place', 'findMany'),
    )
  })

  it('findMany on Place with tenantId passes', async () => {
    const db = createMockDb()

    await expect(db.place.findMany({ where: { tenantId: 'org_1' } })).resolves.toMatchObject({
      model: 'Place',
      action: 'findMany',
    })
  })

  it('helper branches handle unknown actions and raw tenant key checks', async () => {
    const next = vi.fn(async (params) => params)

    expect(tenantIsolationInternals.hasOwnTenantKey(null)).toBe(false)
    expect(tenantIsolationInternals.hasOwnTenantKey([])).toBe(false)
    expect(tenantIsolationInternals.hasOwnTenantKey({ tenantId: undefined })).toBe(true)
    expect(tenantIsolationInternals.hasOwnTenantKey({})).toBe(false)
    expect(tenantIsolationInternals.hasTenantIdValue({ tenantId: null })).toBe(false)
    expect(tenantIsolationInternals.hasTenantIdValue({ tenant_id: 'org_1' })).toBe(true)
    expect(tenantIsolationInternals.hasTenantIdInCreateData([{ tenantId: 'org_1' }])).toBe(true)
    expect(tenantIsolationInternals.requiresWhereTenantId('findUnique')).toBe(true)
    expect(tenantIsolationInternals.requiresWhereTenantId('aggregate')).toBe(false)
    expect(tenantIsolationInternals.isBypassEnabled()).toBe(false)

    await expect(
      tenantIsolationMiddleware(
        createParams({
          action: 'aggregate',
          model: 'TenantMembership',
          args: {},
        }),
        next,
      ),
    ).resolves.toMatchObject({
      action: 'aggregate',
    })
  })
})
