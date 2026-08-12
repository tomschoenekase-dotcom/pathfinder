import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setTenantEngagementModeAction, TenantSettingsActionError } from './tenant-settings-actions'

const REVISION = new Date('2026-08-11T15:00:00.000Z')
const NEXT_REVISION = new Date('2026-08-11T15:00:01.000Z')

function client() {
  const tx = {
    tenant: {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce({ id: 'tenant-1', engagementMode: 'BALANCED', updatedAt: REVISION })
        .mockResolvedValueOnce({
          id: 'tenant-1',
          engagementMode: 'CURIOUS',
          updatedAt: NEXT_REVISION,
        }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  return {
    tx,
    db: { $transaction: vi.fn(async (work) => work(tx)) },
  }
}

const actor = { type: 'HUMAN' as const, id: 'manager-1', role: 'MANAGER' as const }

describe('setTenantEngagementModeAction', () => {
  beforeEach(() => vi.useRealTimers())

  it('fences the exact tenant revision and commits a sanitized audit in the transaction', async () => {
    const { db, tx } = client()

    const result = await setTenantEngagementModeAction({
      db: db as never,
      tenantId: 'tenant-1',
      mode: 'CURIOUS',
      expectedUpdatedAt: REVISION,
      actor,
      now: NEXT_REVISION,
    })

    expect(result).toEqual({
      id: 'tenant-1',
      engagementMode: 'CURIOUS',
      updatedAt: NEXT_REVISION,
      replayed: false,
    })
    expect(tx.tenant.updateMany).toHaveBeenCalledWith({
      where: { id: 'tenant-1', updatedAt: REVISION },
      data: { engagementMode: 'CURIOUS', updatedAt: NEXT_REVISION },
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        actorId: 'manager-1',
        actorRole: 'MANAGER',
        action: 'tenant.engagement-mode.updated',
        targetType: 'Tenant',
        targetId: 'tenant-1',
        beforeState: { engagementMode: 'BALANCED' },
        afterState: { engagementMode: 'CURIOUS' },
      },
    })
  })

  it('rejects a stale revision before writing or auditing', async () => {
    const { db, tx } = client()
    tx.tenant.findUnique.mockReset().mockResolvedValue({
      id: 'tenant-1',
      engagementMode: 'BALANCED',
      updatedAt: NEXT_REVISION,
    })

    await expect(
      setTenantEngagementModeAction({
        db: db as never,
        tenantId: 'tenant-1',
        mode: 'CURIOUS',
        expectedUpdatedAt: REVISION,
        actor,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<TenantSettingsActionError>)
    expect(tx.tenant.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('treats a same-revision same-mode request as an idempotent no-op', async () => {
    const { db, tx } = client()

    const result = await setTenantEngagementModeAction({
      db: db as never,
      tenantId: 'tenant-1',
      mode: 'BALANCED',
      expectedUpdatedAt: REVISION,
      actor,
    })

    expect(result.replayed).toBe(true)
    expect(tx.tenant.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('rejects an empty tenant scope and non-human/unauthorized actor', async () => {
    const { db } = client()

    await expect(
      setTenantEngagementModeAction({
        db: db as never,
        tenantId: '',
        mode: 'STOIC',
        expectedUpdatedAt: REVISION,
        actor,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<TenantSettingsActionError>)
    await expect(
      setTenantEngagementModeAction({
        db: db as never,
        tenantId: 'tenant-1',
        mode: 'STOIC',
        expectedUpdatedAt: REVISION,
        actor: { type: 'HUMAN', id: '', role: 'OWNER' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<TenantSettingsActionError>)
    await expect(
      setTenantEngagementModeAction({
        db: db as never,
        tenantId: 'tenant-1',
        mode: 'UNSUPPORTED' as never,
        expectedUpdatedAt: REVISION,
        actor,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<TenantSettingsActionError>)
  })

  it('fails closed when the strict audit cannot be written', async () => {
    const { db, tx } = client()
    tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))

    await expect(
      setTenantEngagementModeAction({
        db: db as never,
        tenantId: 'tenant-1',
        mode: 'CURIOUS',
        expectedUpdatedAt: REVISION,
        actor,
        now: NEXT_REVISION,
      }),
    ).rejects.toThrow('audit unavailable')
  })
})
