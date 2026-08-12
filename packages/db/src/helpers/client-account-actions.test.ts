import { describe, expect, it, vi } from 'vitest'

import {
  ClientAccountActionError,
  createClientAccountAction,
  setClientPaymentDueAction,
  updateClientStatusAction,
} from './client-account-actions'

const revision = new Date('2026-08-11T14:30:00.000Z')
const actor = { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' } as const
const tenant = {
  id: 'tenant-1',
  name: 'Northstar',
  slug: 'northstar',
  status: 'ACTIVE',
  planTier: 'free',
  nextPaymentDue: null,
  createdAt: revision,
  updatedAt: revision,
}

function fixture() {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    tenant: {
      findUnique: vi.fn(),
      create: vi.fn(async () => tenant),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    user: {
      findUnique: vi.fn(),
      upsert: vi.fn(async () => ({})),
    },
    tenantMembership: {
      findUnique: vi.fn(),
      upsert: vi.fn(async () => ({})),
    },
    venue: {
      findFirst: vi.fn(),
      create: vi.fn(async () => ({ id: 'venue-1', name: 'Lobby', slug: 'lobby' })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  }
  return { tx, client: { $transaction: vi.fn(async (callback) => callback(tx)) } }
}

describe('canonical client account actions', () => {
  it('creates the client, owner, optional venue, and sanitized audit atomically', async () => {
    const { tx, client } = fixture()
    tx.tenant.findUnique.mockResolvedValueOnce(null)
    const result = await createClientAccountAction(
      {
        tenantId: 'tenant-1',
        name: 'Northstar',
        slug: 'northstar',
        owner: { id: 'owner-1', email: 'owner@example.com' },
        actor,
        initialVenue: { name: 'Lobby', slug: 'lobby', guideMode: 'non_location' },
      },
      client as never,
    )
    expect(result).toMatchObject({ replayed: false, tenant: { id: 'tenant-1' } })
    expect(tx.$executeRaw).toHaveBeenCalledTimes(7)
    expect(tx.$executeRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
      tx.venue.create.mock.invocationCallOrder[0]!,
    )
    expect(tx.tenantMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ tenantId: 'tenant-1', role: 'OWNER' }),
      }),
    )
    const audit = JSON.stringify(tx.auditLog.create.mock.calls)
    expect(audit).toContain('admin.client.created')
    expect(audit).not.toContain('owner@example.com')
  })

  it('returns an exact natural-key replay without mutating or duplicating audit', async () => {
    const { tx, client } = fixture()
    tx.tenant.findUnique.mockResolvedValueOnce(tenant)
    tx.user.findUnique.mockResolvedValueOnce({ id: 'owner-1', email: 'owner@example.com' })
    tx.tenantMembership.findUnique.mockResolvedValueOnce({ role: 'OWNER', status: 'ACTIVE' })
    const result = await createClientAccountAction(
      {
        tenantId: 'tenant-1',
        name: 'Northstar',
        slug: 'northstar',
        owner: { id: 'owner-1', email: 'owner@example.com' },
        actor,
      },
      client as never,
    )
    expect(result.replayed).toBe(true)
    expect(tx.tenant.create).not.toHaveBeenCalled()
    expect(tx.user.upsert).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('rejects a natural-key replay with different account details', async () => {
    const { tx, client } = fixture()
    tx.tenant.findUnique.mockResolvedValueOnce({ ...tenant, name: 'Different' })
    await expect(
      createClientAccountAction(
        {
          tenantId: 'tenant-1',
          name: 'Northstar',
          slug: 'northstar',
          owner: { id: 'owner-1', email: 'owner@example.com' },
          actor,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<ClientAccountActionError>)
    expect(tx.user.upsert).not.toHaveBeenCalled()
  })

  it('updates exact tenant scope with updatedAt CAS and strict same-transaction audit', async () => {
    const { tx, client } = fixture()
    tx.tenant.findUnique.mockResolvedValueOnce(tenant).mockResolvedValueOnce({
      ...tenant,
      status: 'SUSPENDED',
      updatedAt: new Date(revision.getTime() + 1),
    })
    await updateClientStatusAction(
      { tenantId: 'tenant-1', status: 'SUSPENDED', expectedUpdatedAt: revision, actor },
      client as never,
    )
    expect(tx.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tenant-1', updatedAt: revision } }),
    )
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).toContain('status_updated')
  })

  it('fails closed on stale revision and writes no audit', async () => {
    const { tx, client } = fixture()
    tx.tenant.findUnique.mockResolvedValueOnce({
      ...tenant,
      updatedAt: new Date(revision.getTime() + 1),
    })
    await expect(
      setClientPaymentDueAction(
        {
          tenantId: 'tenant-1',
          nextPaymentDue: new Date('2026-09-01T00:00:00.000Z'),
          expectedUpdatedAt: revision,
          actor,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<ClientAccountActionError>)
    expect(tx.tenant.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('rejects non-platform actors before opening a transaction', async () => {
    const { client } = fixture()
    await expect(
      updateClientStatusAction(
        {
          tenantId: 'tenant-1',
          status: 'ACTIVE',
          expectedUpdatedAt: revision,
          actor: { type: 'HUMAN', id: 'owner-1', role: 'OWNER' } as never,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<ClientAccountActionError>)
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('fails the canonical create transaction when strict audit persistence fails', async () => {
    const { tx, client } = fixture()
    tx.tenant.findUnique.mockResolvedValueOnce(null)
    tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(
      createClientAccountAction(
        {
          tenantId: 'tenant-1',
          name: 'Northstar',
          slug: 'northstar',
          owner: { id: 'owner-1', email: 'owner@example.com' },
          actor,
        },
        client as never,
      ),
    ).rejects.toThrow('audit unavailable')
    expect(tx.tenant.create).toHaveBeenCalledOnce()
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })
})
