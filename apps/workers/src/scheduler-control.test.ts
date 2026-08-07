import { describe, expect, it, vi } from 'vitest'

import { applySchedulerState } from './scheduler-control'

describe('applySchedulerState', () => {
  it('upserts recurring schedulers when enabled', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined)
    const remove = vi.fn().mockResolvedValue(undefined)

    await applySchedulerState(true, [{ upsert, remove }])

    expect(upsert).toHaveBeenCalledOnce()
    expect(remove).not.toHaveBeenCalled()
  })

  it('removes previously registered schedulers when disabled', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined)
    const remove = vi.fn().mockResolvedValue(undefined)

    await applySchedulerState(false, [{ upsert, remove }])

    expect(remove).toHaveBeenCalledOnce()
    expect(upsert).not.toHaveBeenCalled()
  })
})
