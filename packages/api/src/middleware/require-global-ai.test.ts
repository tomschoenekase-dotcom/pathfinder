import { describe, expect, it, vi } from 'vitest'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { publicAiProcedure } from '../trpc'

function context(findUnique: () => Promise<unknown>): TRPCContext {
  return {
    db: { platformConfig: { findUnique } } as unknown as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: null,
      activeTenantId: null,
      role: null,
      isPlatformAdmin: false,
    },
  }
}

describe('global AI admission middleware', () => {
  it('allows downstream work when the control is not configured', async () => {
    const downstream = vi.fn(() => 'ok')
    const caller = router({ gated: publicAiProcedure.query(downstream) }).createCaller(
      context(vi.fn().mockResolvedValue(null)),
    )

    await expect(caller.gated()).resolves.toBe('ok')
    expect(downstream).toHaveBeenCalledOnce()
  })

  it('fails before downstream work with a generic response while paused', async () => {
    const downstream = vi.fn(() => 'unexpected')
    const privateReason = 'provider account investigation 12345'
    const caller = router({ gated: publicAiProcedure.query(downstream) }).createCaller(
      context(
        vi.fn().mockResolvedValue({
          value: { schemaVersion: 1, paused: true, reason: privateReason },
          updatedAt: new Date('2026-08-08T20:00:00.000Z'),
          updatedBy: 'admin_1',
        }),
      ),
    )

    const error = await caller.gated().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(error).not.toHaveProperty('message', expect.stringContaining(privateReason))
    expect(downstream).not.toHaveBeenCalled()
  })

  it('fails closed before downstream work when control storage is unavailable', async () => {
    const downstream = vi.fn(() => 'unexpected')
    const caller = router({ gated: publicAiProcedure.query(downstream) }).createCaller(
      context(vi.fn().mockRejectedValue(new Error('private database detail'))),
    )

    await expect(caller.gated()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(downstream).not.toHaveBeenCalled()
  })
})
