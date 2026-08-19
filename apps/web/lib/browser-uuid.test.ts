import { describe, expect, it, vi } from 'vitest'

import { browserUuid } from './browser-uuid'

describe('browserUuid', () => {
  it('uses a valid platform UUID when available', () => {
    const randomUUID = vi.fn(() => '11111111-1111-4111-8111-111111111111')

    expect(browserUuid({ randomUUID })).toBe('11111111-1111-4111-8111-111111111111')
    expect(randomUUID).toHaveBeenCalledOnce()
  })

  it('builds a valid UUID v4 from cryptographic bytes when randomUUID is unavailable', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set([0, 1, 2, 3, 4, 5, 255, 7, 255, 9, 10, 11, 12, 13, 14, 15])
      return bytes
    })

    expect(browserUuid({ getRandomValues })).toBe('00010203-0405-4f07-bf09-0a0b0c0d0e0f')
    expect(getRandomValues).toHaveBeenCalledOnce()
  })

  it('falls back after an invalid or throwing platform UUID and fails closed without crypto', () => {
    const bytes = new Uint8Array(16)
    expect(
      browserUuid({
        randomUUID: () => {
          throw new Error('unavailable')
        },
        getRandomValues: (target) => {
          const typedTarget = target as Uint8Array
          typedTarget.set(bytes)
          return target
        },
      }),
    ).toBe('00000000-0000-4000-8000-000000000000')
    expect(browserUuid({})).toBeNull()
    expect(browserUuid({ randomUUID: () => 'not-a-uuid' })).toBeNull()
  })
})
