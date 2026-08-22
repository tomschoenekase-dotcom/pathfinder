import { describe, expect, it, vi } from 'vitest'

vi.mock('./audit', () => ({ writeAuditLogStrict: vi.fn().mockResolvedValue(undefined) }))

import { emergencyStopProspectDeliveryAction } from './prospect-delivery-control-actions'

describe('prospect delivery emergency stop', () => {
  it('atomically disables global delivery and pauses active campaigns', async () => {
    const tx = {
      prospectDeliveryControl: {
        findUnique: vi.fn().mockResolvedValue({ deliveryEnabled: true }),
        upsert: vi
          .fn()
          .mockResolvedValue({ id: 'global', deliveryEnabled: false, changedBy: 'admin-1' }),
      },
      prospectOutreachCampaign: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      auditLog: { create: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    const result = await emergencyStopProspectDeliveryAction(
      {
        reason: 'Unexpected provider behavior',
        actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
      },
      client as never,
    )

    expect(result.deliveryEnabled).toBe(false)
    expect(tx.prospectDeliveryControl.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ deliveryEnabled: false }) }),
    )
    expect(tx.prospectOutreachCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE', pausedAt: null } }),
    )
  })

  it('has no enable operation and rejects non-human authority', async () => {
    await expect(
      emergencyStopProspectDeliveryAction(
        {
          reason: 'Agent attempted stop',
          actor: { type: 'AGENT', id: 'agent-1', role: 'PLATFORM_ADMIN' } as never,
        },
        {} as never,
      ),
    ).rejects.toThrow(/human platform administrator/i)
  })
})
