import { describe, expect, it } from 'vitest'

import { buildGuestChatUrl } from './guest-chat-url'

describe('guest chat URL boundary', () => {
  it('builds an encoded chat URL from an exact HTTPS origin', () => {
    expect(buildGuestChatUrl('https://guide.example.com/', 'museum west')).toBe(
      'https://guide.example.com/museum%20west/chat',
    )
  })

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
    'allows an explicit loopback HTTP origin for local development: %s',
    (origin) => {
      expect(buildGuestChatUrl(origin, 'museum', { allowLoopbackHttp: true })).toBe(
        `${origin}/museum/chat`,
      )
    },
  )

  it('rejects loopback HTTP unless the caller explicitly enables local development', () => {
    expect(buildGuestChatUrl('http://localhost:3000', 'museum')).toBeNull()
  })

  it.each([
    undefined,
    '',
    'not a URL',
    'javascript:alert(1)',
    'http://guide.example.com',
    'https://user:password@guide.example.com',
    'https://guide.example.com/base',
    'https://guide.example.com/..',
    'https://guide.example.com/%2e%2e',
    'https://guide.example.com/?tenant=one',
    'https://guide.example.com/#preview',
    'http://2130706433:3000',
  ])('returns unavailable for an unsafe or ambiguous public origin: %s', (origin) => {
    expect(buildGuestChatUrl(origin, 'museum')).toBeNull()
  })

  it.each(['   ', '.', '..'])('returns unavailable for an unsafe venue slug: %s', (slug) => {
    expect(buildGuestChatUrl('https://guide.example.com', slug)).toBeNull()
  })
})
