import { describe, expect, it } from 'vitest'

import { buildGuestChatUrl, buildGuideItemEntryUrl } from './guest-chat-url'

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

describe('guide item entry URL boundary', () => {
  it('builds a bounded, non-sending item prompt', () => {
    const url = buildGuideItemEntryUrl('https://guide.example.com/museum/chat', {
      id: 'place_1',
      name: 'Tide Clock & Gallery',
    })
    expect(url).toBe(
      'https://guide.example.com/museum/chat?entry=guide-item&item=place_1&prompt=Tell+me+about+Tide+Clock+%26+Gallery.',
    )
  })

  it.each([
    [null, { id: 'place_1', name: 'Gallery' }],
    ['https://guide.example.com/museum/chat?existing=1', { id: 'place_1', name: 'Gallery' }],
    ['https://guide.example.com/museum/chat', { id: '', name: 'Gallery' }],
    ['https://guide.example.com/museum/chat', { id: 'place_1', name: ' '.repeat(121) }],
  ])('rejects ambiguous or incomplete inputs %#', (base, guideItem) => {
    expect(buildGuideItemEntryUrl(base, guideItem)).toBeNull()
  })
})
