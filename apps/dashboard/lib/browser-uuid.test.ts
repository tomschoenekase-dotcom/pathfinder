import { describe, expect, it, vi } from 'vitest'

import { browserUuid } from './browser-uuid'

describe('browserUuid', () => {
  it('uses the native secure-context implementation when available', () => {
    const randomUUID = vi.fn(() => '11111111-1111-4111-8111-111111111111')
    expect(browserUuid({ randomUUID, getRandomValues: (array) => array })).toBe(
      '11111111-1111-4111-8111-111111111111',
    )
    expect(randomUUID).toHaveBeenCalledOnce()
  })

  it('builds an RFC 4122 v4 UUID from random bytes when randomUUID is unavailable', () => {
    const value = browserUuid({
      getRandomValues: (array) => {
        if (array instanceof Uint8Array) array.fill(0xab)
        return array
      },
    })

    expect(value).toBe('abababab-abab-4bab-abab-abababababab')
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  })
})
