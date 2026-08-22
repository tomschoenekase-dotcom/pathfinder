import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findControl, findMany, enqueueProspectOutreach } = vi.hoisted(() => ({
  findControl: vi.fn(),
  findMany: vi.fn(),
  enqueueProspectOutreach: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    prospectDeliveryControl: { findUnique: findControl },
    prospectSendOutbox: { findMany },
  },
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueProspectOutreach }))
vi.mock('@pathfinder/config', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}))

import { dispatchPendingProspectOutbox } from './prospect-outbox-dispatcher'

describe('prospect outbox dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED = 'true'
    findControl.mockResolvedValue({ deliveryEnabled: true })
  })

  it('publishes nothing when the environment or global emergency stop is dark', async () => {
    process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED = 'false'
    await expect(dispatchPendingProspectOutbox()).resolves.toEqual({
      discovered: 0,
      enqueued: 0,
      failed: 0,
    })
    expect(findControl).not.toHaveBeenCalled()

    process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED = 'true'
    findControl.mockResolvedValue({ deliveryEnabled: false })
    await expect(dispatchPendingProspectOutbox()).resolves.toEqual({
      discovered: 0,
      enqueued: 0,
      failed: 0,
    })
    expect(findMany).not.toHaveBeenCalled()
    expect(enqueueProspectOutreach).not.toHaveBeenCalled()
  })

  it('re-publishes pending and expired durable operations by outbox identity', async () => {
    findMany.mockResolvedValue([{ id: 'outbox-1' }, { id: 'outbox-2' }])
    enqueueProspectOutreach.mockResolvedValue(undefined)

    await expect(dispatchPendingProspectOutbox(new Date('2026-08-20T12:00:00Z'))).resolves.toEqual({
      discovered: 2,
      enqueued: 2,
      failed: 0,
    })
    expect(enqueueProspectOutreach).toHaveBeenNthCalledWith(1, { outboxId: 'outbox-1' })
    expect(enqueueProspectOutreach).toHaveBeenNthCalledWith(2, { outboxId: 'outbox-2' })
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
        take: 100,
      }),
    )
  })

  it('keeps failed publication durable for the next scan', async () => {
    findMany.mockResolvedValue([{ id: 'outbox-1' }, { id: 'outbox-2' }])
    enqueueProspectOutreach
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis unavailable'))

    await expect(dispatchPendingProspectOutbox()).resolves.toEqual({
      discovered: 2,
      enqueued: 1,
      failed: 1,
    })
  })
})
