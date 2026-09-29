import { describe, expect, it } from 'vitest'

import {
  ChatAppearanceSchema,
  DEFAULT_CHAT_APPEARANCE,
  chatAppearanceEquals,
  decodeChatAppearanceParam,
  encodeChatAppearanceParam,
  parseChatAppearance,
} from './chat-appearance'

describe('chat appearance contract', () => {
  it('keeps existing venues on the plain default when nothing is stored', () => {
    for (const stored of [null, undefined, 'dark', 7, []]) {
      expect(parseChatAppearance(stored)).toEqual(DEFAULT_CHAT_APPEARANCE)
    }
    expect(DEFAULT_CHAT_APPEARANCE.background.mode).toBe('none')
    expect(DEFAULT_CHAT_APPEARANCE.requestMore).toBe(true)
  })

  it('falls back field by field and drops unknown keys', () => {
    const parsed = parseChatAppearance({
      userBubble: false,
      userTextColor: 'red',
      headerColor: '#0b1426',
      title: '   ',
      background: { mode: 'image', focalX: 140, dim: 30 },
      extra: '<script>',
    })
    expect(parsed).toEqual({
      ...DEFAULT_CHAT_APPEARANCE,
      userBubble: false,
      headerColor: '#0b1426',
      background: { mode: 'image', focalX: 50, focalY: 50, dim: 30 },
    })
    expect(ChatAppearanceSchema.safeParse(parsed).success).toBe(true)
  })

  it('rejects unknown or invalid fields at the write boundary', () => {
    expect(
      ChatAppearanceSchema.safeParse({ ...DEFAULT_CHAT_APPEARANCE, extra: true }).success,
    ).toBe(false)
    expect(
      ChatAppearanceSchema.safeParse({ ...DEFAULT_CHAT_APPEARANCE, headerColor: 'blue' }).success,
    ).toBe(false)
    expect(
      ChatAppearanceSchema.safeParse({ ...DEFAULT_CHAT_APPEARANCE, title: 'x'.repeat(81) }).success,
    ).toBe(false)
    expect(
      ChatAppearanceSchema.safeParse({
        ...DEFAULT_CHAT_APPEARANCE,
        background: { mode: 'image', focalX: 50, focalY: 50, dim: 90 },
      }).success,
    ).toBe(false)
  })

  it('compares stored appearances without depending on JSON key order', () => {
    const reordered = Object.fromEntries(Object.entries(DEFAULT_CHAT_APPEARANCE).reverse())
    expect(chatAppearanceEquals(reordered, DEFAULT_CHAT_APPEARANCE)).toBe(true)
    expect(chatAppearanceEquals(null, null)).toBe(true)
    expect(chatAppearanceEquals(null, DEFAULT_CHAT_APPEARANCE)).toBe(false)
    expect(
      chatAppearanceEquals(DEFAULT_CHAT_APPEARANCE, {
        ...DEFAULT_CHAT_APPEARANCE,
        requestMore: false,
      }),
    ).toBe(false)
  })

  it('round-trips a preview parameter, including non-Latin titles, and rejects tampering', () => {
    const appearance = { ...DEFAULT_CHAT_APPEARANCE, title: 'متحف الفضاء · 宇宙博物館' }
    const encoded = encodeChatAppearanceParam(appearance)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(decodeChatAppearanceParam(encoded)).toEqual(appearance)
    expect(decodeChatAppearanceParam('not base64!')).toBeNull()
    expect(decodeChatAppearanceParam('x'.repeat(5000))).toBeNull()
    expect(decodeChatAppearanceParam(null)).toBeNull()
  })
})
