import { beforeEach, describe, expect, it, vi } from 'vitest'

const { setContext, lockEntity, lockCapacity, writeAudit } = vi.hoisted(() => ({
  setContext: vi.fn(),
  lockEntity: vi.fn(),
  lockCapacity: vi.fn(),
  writeAudit: vi.fn(),
}))

vi.mock('./content-version-context', () => ({
  setContentVersionContext: setContext,
  lockContentVersionEntity: lockEntity,
  lockOperationalUpdateCapacity: lockCapacity,
}))
vi.mock('./audit', () => ({ writeAuditLogStrict: writeAudit }))

import {
  buildOperationalUpdatePreview,
  createOperationalUpdateAction,
  expireOperationalUpdateAction,
  scheduleOperationalUpdateAction,
  updateOperationalUpdateAction,
  type OperationalUpdateActionClient,
} from './operational-update-actions'

const venueFindFirst = vi.fn()
const placeFindFirst = vi.fn()
const findFirst = vi.fn()
const create = vi.fn()
const updateMany = vi.fn()
const count = vi.fn()
const tx = {
  venue: { findFirst: venueFindFirst },
  place: { findFirst: placeFindFirst },
  operationalUpdate: { findFirst, create, updateMany, count },
  auditLog: { create: vi.fn() },
}
const client = {
  $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
} as unknown as OperationalUpdateActionClient

const startsAt = new Date('2030-01-01T08:00:00.000Z')
const expiresAt = new Date('2030-01-01T12:00:00.000Z')
const now = new Date('2030-01-01T09:00:00.000Z')
const expectedUpdatedAt = new Date('2029-12-31T23:00:00.000Z')
const actor = { type: 'HUMAN' as const, id: 'manager_1', role: 'MANAGER' as const }
const machineActor = {
  type: 'AGENT' as const,
  actorId: 'agent_1',
  role: 'AGENT' as const,
  agentIdentityId: 'agent_1',
  agentRunId: 'run_1',
  workerId: 'worker_1',
  credentialId: 'credential_1',
  approvalGrantId: 'grant_1',
  capability: 'updates:draft',
  idempotencyKey: 'operation_1',
}
const fields = {
  venueId: 'venue_1',
  placeId: 'place_1',
  updateType: 'TEMPORARY_CLOSURE' as const,
  severity: 'CLOSURE' as const,
  priority: 'URGENT' as const,
  title: 'Reptile House closed',
  body: 'Use the west trail.',
  redirectTo: '/west-trail',
  startsAt,
  expiresAt,
}
const published = {
  id: 'update_1',
  tenantId: 'tenant_1',
  ...fields,
  status: 'PUBLISHED',
  isActive: true,
  createdBy: 'manager_1',
  publishedBy: 'manager_1',
  publishedAt: now,
  createdAt: now,
  updatedAt: expectedUpdatedAt,
  venue: { id: 'venue_1', name: 'Zoo' },
  place: { id: 'place_1', name: 'Reptile House' },
}

describe('operational update domain actions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    venueFindFirst.mockResolvedValue({ id: 'venue_1' })
    placeFindFirst.mockResolvedValue({ id: 'place_1' })
    count.mockResolvedValue(0)
    setContext.mockResolvedValue(undefined)
    lockEntity.mockResolvedValue(undefined)
    lockCapacity.mockResolvedValue(undefined)
    writeAudit.mockResolvedValue(undefined)
  })

  it('creates a scheduled update with exact scope, human content context, audit, and preview', async () => {
    create.mockResolvedValue(published)
    const result = await createOperationalUpdateAction(
      { tenantId: 'tenant_1', actor, fields, schedule: true, now },
      client,
    )

    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { id: true },
    })
    expect(placeFindFirst).toHaveBeenCalledWith({
      where: { id: 'place_1', venueId: 'venue_1', tenantId: 'tenant_1' },
      select: { id: true },
    })
    expect(setContext).toHaveBeenCalledWith(tx, { actorId: 'manager_1' })
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        actorRole: 'MANAGER',
        action: 'operational-update.created-published',
      }),
      tx,
    )
    expect(result.preview).toMatchObject({ lifecycle: 'LIVE', guestVisibleNow: true })
  })

  it('does not disclose or write across tenant scope', async () => {
    venueFindFirst.mockResolvedValue(null)
    await expect(
      createOperationalUpdateAction(
        { tenantId: 'tenant_attacker', actor, fields, schedule: false, now },
        client,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(create).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('creates a draft with honest machine attribution through the canonical action', async () => {
    const draft = {
      ...published,
      status: 'DRAFT',
      isActive: false,
      createdBy: 'agent_1',
      publishedBy: null,
      publishedAt: null,
    }
    create.mockResolvedValue(draft)

    const result = await createOperationalUpdateAction(
      { tenantId: 'tenant_1', actor: machineActor, fields, schedule: false, now },
      client,
    )

    expect(setContext).toHaveBeenCalledWith(tx, { actorId: 'agent_1' })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DRAFT',
          isActive: false,
          createdBy: 'agent_1',
          publishedBy: null,
        }),
      }),
    )
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: machineActor,
        action: 'operational-update.created-draft',
      }),
      tx,
    )
    expect(result.preview.lifecycle).toBe('DRAFT')
  })

  it('does not let a machine actor publish or schedule an update', async () => {
    await expect(
      createOperationalUpdateAction(
        { tenantId: 'tenant_1', actor: machineActor, fields, schedule: true, now },
        client,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(create).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('rejects stale updates without a false platform audit', async () => {
    findFirst.mockResolvedValueOnce(published)
    updateMany.mockResolvedValue({ count: 0 })
    await expect(
      updateOperationalUpdateAction(
        {
          tenantId: 'tenant_1',
          actor,
          id: 'update_1',
          expectedUpdatedAt,
          fields,
          schedule: false,
          now,
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          updatedAt: expectedUpdatedAt,
        }),
      }),
    )
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('rejects an expired scheduling window before mutation', async () => {
    const draft = { ...published, status: 'DRAFT', isActive: false, expiresAt: now }
    findFirst.mockResolvedValue(draft)
    await expect(
      scheduleOperationalUpdateAction(
        { tenantId: 'tenant_1', actor, id: 'update_1', expectedUpdatedAt, now },
        client,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('enforces the bounded overlapping guest-update capacity under the venue lock', async () => {
    const draft = { ...published, status: 'DRAFT', isActive: false }
    findFirst.mockResolvedValue(draft)
    count.mockResolvedValue(20)
    await expect(
      scheduleOperationalUpdateAction(
        { tenantId: 'tenant_1', actor, id: 'update_1', expectedUpdatedAt, now },
        client,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(lockCapacity).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      startsAt,
      expiresAt,
      excludeId: 'update_1',
    })
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('expires only an active published update with tenant-scoped CAS', async () => {
    findFirst
      .mockResolvedValueOnce(published)
      .mockResolvedValueOnce({ ...published, isActive: false })
    updateMany.mockResolvedValue({ count: 1 })
    const result = await expireOperationalUpdateAction(
      { tenantId: 'tenant_1', actor, id: 'update_1', expectedUpdatedAt, now },
      client,
    )
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'update_1',
        tenantId: 'tenant_1',
        status: 'PUBLISHED',
        isActive: true,
        updatedAt: expectedUpdatedAt,
      },
      data: { isActive: false },
    })
    expect(result.preview).toMatchObject({ lifecycle: 'INACTIVE', guestVisibleNow: false })
  })

  it('reports future scheduled and naturally expired preview states', () => {
    expect(buildOperationalUpdatePreview(published, new Date('2029-12-01'))).toMatchObject({
      lifecycle: 'SCHEDULED',
    })
    expect(buildOperationalUpdatePreview(published, new Date('2030-01-02'))).toMatchObject({
      lifecycle: 'EXPIRED',
      guestVisibleNow: false,
    })
  })
})
