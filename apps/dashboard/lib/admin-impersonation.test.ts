import { afterEach, describe, expect, it, vi } from 'vitest'

import { ADMIN_IMPERSONATION_ERROR, setAdminImpersonation } from './admin-impersonation'

describe('setAdminImpersonation', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('accepts only a successful audited transition and cancels its unused response body', async () => {
    const cancel = vi.fn()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 }))

    await setAdminImpersonation('tenant_1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/impersonate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tenantId: 'tenant_1' }),
        signal: expect.any(AbortSignal),
      }),
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects a failed audited transition with fixed operator-safe copy', async () => {
    const cancel = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 }),
    )

    await expect(setAdminImpersonation(null)).rejects.toThrow(ADMIN_IMPERSONATION_ERROR)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('aborts and rejects a stalled transition at the fixed deadline', async () => {
    vi.useFakeTimers()
    let observedSignal: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      observedSignal = init?.signal ?? undefined
      return new Promise<Response>(() => undefined)
    })

    const rejection = expect(setAdminImpersonation('tenant_1')).rejects.toThrow(
      ADMIN_IMPERSONATION_ERROR,
    )
    await vi.advanceTimersByTimeAsync(10_000)

    await rejection
    expect(observedSignal?.aborted).toBe(true)
  })
})
