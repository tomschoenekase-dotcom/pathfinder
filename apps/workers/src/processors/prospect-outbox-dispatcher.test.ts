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

import {
  dispatchPendingProspectOutbox,
  startProspectOutboxDispatcher,
} from './prospect-outbox-dispatcher'

describe('prospect outbox dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED = 'true'
    process.env.CRM_PROSPECT_OUTREACH_ENABLED = 'true'
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

  it('serializes scans and drains the active dispatch before stopping', async () => {
    vi.useFakeTimers()
    let resolveScan: ((value: Array<{ id: string }>) => void) | undefined
    findMany.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveScan = resolve
      }),
    )
    const stop = startProspectOutboxDispatcher(100)
    await Promise.resolve()
    await Promise.resolve()
    expect(findMany).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(100)
    expect(findMany).toHaveBeenCalledOnce()

    let stopped = false
    const stopping = stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    resolveScan?.([])
    await stopping
    expect(stopped).toBe(true)
    await expect(stop()).resolves.toBeUndefined()

    await vi.advanceTimersByTimeAsync(100)
    expect(findMany).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('returns an awaitable no-op stop while the dispatcher gate is dark', async () => {
    process.env.CRM_PROSPECT_OUTREACH_ENABLED = 'false'

    const stop = startProspectOutboxDispatcher(100)

    await expect(stop()).resolves.toBeUndefined()
    expect(findControl).not.toHaveBeenCalled()
  })
})
