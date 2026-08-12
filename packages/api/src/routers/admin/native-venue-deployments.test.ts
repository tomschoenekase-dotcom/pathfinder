import { beforeEach, describe, expect, it, vi } from 'vitest'

import { router } from '../../core'
import type { TRPCContext } from '../../context'

const actions = vi.hoisted(() => ({
  create: vi.fn(),
  project: vi.fn(),
  approve: vi.fn(),
  apply: vi.fn(),
  revert: vi.fn(),
}))
const releaseReads = vi.hoisted(() => ({ findMany: vi.fn(), findFirst: vi.fn() }))
const headReads = vi.hoisted(() => ({ findFirst: vi.fn() }))
vi.mock('@pathfinder/db', async (original) => ({
  ...(await original<typeof import('@pathfinder/db')>()),
  db: { nativeVenueDeploymentRelease: releaseReads, nativeVenueDeploymentHead: headReads },
  withTenantIsolationBypass: (fn: () => unknown) => fn(),
  createNativeVenueDeploymentAction: actions.create,
  projectNativeVenueStateAction: actions.project,
  approveNativeVenueDeploymentAction: actions.approve,
  applyNativeVenueDeploymentAction: actions.apply,
  revertNativeVenueDeploymentAction: actions.revert,
}))

import { adminNativeVenueDeploymentsRouter } from './native-venue-deployments'

const app = router({ admin: adminNativeVenueDeploymentsRouter })
const context = (isPlatformAdmin = true): TRPCContext => ({
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: { userId: 'admin-1', activeTenantId: null, role: null, isPlatformAdmin },
})

describe('admin native venue deployments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    headReads.findFirst.mockResolvedValue(null)
  })

  it('returns only bounded allowlisted release metadata', async () => {
    releaseReads.findMany.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        profile: 'NATIVE_CORE_V1',
        manifestHash: 'a'.repeat(64),
        baseStateHash: 'b'.repeat(64),
        desiredStateHash: 'c'.repeat(64),
        status: 'DRAFT',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ])
    const result = await app
      .createCaller(context())
      .admin.listNativeVenueDeployments({ tenantId: 'tenant-1', venueId: 'venue-1', limit: 20 })
    expect(result.items).toHaveLength(1)
    expect(releaseReads.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 21,
        where: { tenantId: 'tenant-1', venueId: 'venue-1' },
        select: expect.not.objectContaining({ plan: true, createdBy: true }),
      }),
    )
  })

  it('requires platform-admin authorization before every service call', async () => {
    const caller = app.createCaller(context(false))
    const scope = { tenantId: 'tenant-1', venueId: 'venue-1' }
    const lifecycle = {
      ...scope,
      releaseId: '11111111-1111-4111-8111-111111111111',
      commandId: '22222222-2222-4222-8222-222222222222',
      expectedUpdatedAt: '2026-08-12T12:00:00.000Z',
    }
    await expect(caller.admin.projectNativeVenueDeployment(scope)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      caller.admin.createNativeVenueDeployment({ ...scope, manifestJson: '{}' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller.admin.approveNativeVenueDeployment(lifecycle)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(caller.admin.applyNativeVenueDeployment(lifecycle)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(caller.admin.revertNativeVenueDeployment(lifecycle)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(Object.values(actions).every((action) => action.mock.calls.length === 0)).toBe(true)
  })

  it('returns a safe create summary without immutable plan or actor evidence', async () => {
    actions.create.mockResolvedValue({
      id: 'release-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      profile: 'NATIVE_CORE_V1',
      manifestHash: 'a'.repeat(64),
      baseStateHash: 'b'.repeat(64),
      desiredStateHash: 'c'.repeat(64),
      status: 'DRAFT',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      plan: { secret: 'must-not-leak' },
      createdBy: 'admin-1',
    })
    const result = await app.createCaller(context()).admin.createNativeVenueDeployment({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      manifestJson: '{}',
    })
    expect(result).toMatchObject({ id: 'release-1', status: 'DRAFT' })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(result).not.toHaveProperty('createdBy')
    expect(result).not.toHaveProperty('manifestHash')
    expect(result).not.toHaveProperty('baseStateHash')
    expect(result).not.toHaveProperty('desiredStateHash')
    expect(actions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'admin-1' },
      }),
      expect.anything(),
    )
  })

  it('derives bounded coverage, impacts, and action gates without exposing the plan', async () => {
    releaseReads.findFirst.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      profile: 'NATIVE_CORE_V1',
      manifestHash: 'a'.repeat(64),
      baseStateHash: 'b'.repeat(64),
      desiredStateHash: 'c'.repeat(64),
      status: 'APPROVED',
      createdAt: new Date(0),
      updatedAt: new Date('2026-08-12T12:00:00.000Z'),
      approvedAt: new Date('2026-08-12T12:00:00.000Z'),
      appliedAt: null,
      revertedAt: null,
      expectedEffectCount: 3,
      plan: {
        secret: 'must-not-leak',
        effects: [{ kind: 'PLACE' }, { kind: 'PLACE' }, { kind: 'VENUE' }],
      },
      _count: { effects: 0, commands: 1 },
    })
    const result = await app.createCaller(context()).admin.getNativeVenueDeployment({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      releaseId: '11111111-1111-4111-8111-111111111111',
    })
    expect(result.coverage).toHaveLength(7)
    expect(result.impactSummary).toEqual([
      { kind: 'PLACE', count: 2 },
      { kind: 'VENUE', count: 1 },
    ])
    expect(result.effectSummary).toEqual({
      expected: 3,
      recorded: 0,
      byKind: result.impactSummary,
    })
    expect(result.allowedActions).toMatchObject({
      approve: { allowed: false },
      apply: { allowed: true, reason: null },
      revert: { allowed: false },
    })
    expect(result).toMatchObject({
      materializable: true,
      unsupported: false,
      issues: [],
      issueCount: 0,
      nextIssueCursor: null,
    })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(result).not.toHaveProperty('manifestHash')
    expect(result).not.toHaveProperty('plan')
  })

  it('projects lifecycle results and strips hashes, universes, and internal evidence', async () => {
    actions.apply.mockResolvedValue({
      releaseId: '11111111-1111-4111-8111-111111111111',
      status: 'APPLIED',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      profile: 'NATIVE_CORE_V1',
      updatedAt: '2026-08-12T12:00:00.000Z',
      version: '2026-08-12T12:00:00.000Z',
      effectCount: 4,
      appliedUniverse: { secret: 'must-not-leak' },
      head: {
        releaseId: '11111111-1111-4111-8111-111111111111',
        revision: 2,
        manifestHash: 'a'.repeat(64),
        stateHash: 'b'.repeat(64),
      },
    })
    const result = await app.createCaller(context()).admin.applyNativeVenueDeployment({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      releaseId: '11111111-1111-4111-8111-111111111111',
      commandId: '22222222-2222-4222-8222-222222222222',
      expectedUpdatedAt: '2026-08-12T11:00:00.000Z',
    })
    expect(result).toMatchObject({
      releaseId: '11111111-1111-4111-8111-111111111111',
      status: 'APPLIED',
      updatedAt: '2026-08-12T12:00:00.000Z',
      effectCount: 4,
      head: { present: true, revision: 2 },
      allowedActions: { revert: { allowed: true, reason: null } },
    })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(JSON.stringify(result)).not.toContain('manifestHash')
    expect(JSON.stringify(result)).not.toContain('stateHash')
  })

  it('does not offer revert when a later release is the exact current head', async () => {
    releaseReads.findFirst.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      profile: 'NATIVE_CORE_V1',
      status: 'APPLIED',
      createdAt: new Date(0),
      updatedAt: new Date('2026-08-12T12:00:00.000Z'),
      approvedAt: new Date(0),
      appliedAt: new Date(0),
      revertedAt: null,
      expectedEffectCount: 0,
      plan: { effects: [] },
      _count: { effects: 0, commands: 2 },
    })
    headReads.findFirst.mockResolvedValue({
      releaseId: '33333333-3333-4333-8333-333333333333',
    })
    const result = await app.createCaller(context()).admin.getNativeVenueDeployment({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      releaseId: '11111111-1111-4111-8111-111111111111',
    })
    expect(result.allowedActions.revert).toEqual({
      allowed: false,
      reason: 'A later release is the current venue deployment.',
    })
    expect(headReads.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', venueId: 'venue-1' },
      select: { releaseId: true },
    })
  })

  it('maps invalid JSON to a bounded typed error without calling the service', async () => {
    await expect(
      app.createCaller(context()).admin.createNativeVenueDeployment({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        manifestJson: '{',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(actions.create).not.toHaveBeenCalled()
  })
})
