import { describe, expect, it } from 'vitest'

import {
  GUEST_ANSWER_SHAPE_INSTRUCTION,
  appendGuestAnswerShapeInstruction,
  guestAnswerShapeMode,
  isGuestAnswerShapeEnabled,
} from './guest-answer-shape'

describe('guest answer shape', () => {
  it('is off unless decision-first is selected explicitly', () => {
    expect(guestAnswerShapeMode({})).toBe('off')
    expect(guestAnswerShapeMode({ GUEST_CHAT_ANSWER_SHAPE: 'on' })).toBe('off')
    expect(guestAnswerShapeMode({ GUEST_CHAT_ANSWER_SHAPE: ' Decision-First ' })).toBe(
      'decision-first',
    )
  })

  it('applies to the evaluated Luna primary only, not to other economy or standard models', () => {
    expect(isGuestAnswerShapeEnabled('decision-first', 'guest-chat-luna')).toBe(true)
    for (const key of [
      'guest-chat',
      'guest-chat-openai',
      'guest-chat-deepseek-flash',
      'guest-chat-deepseek-pro',
      'guest-chat-sol',
      'not-a-model',
    ])
      expect(isGuestAnswerShapeEnabled('decision-first', key)).toBe(false)
    expect(isGuestAnswerShapeEnabled('decision-first', undefined)).toBe(false)
    expect(isGuestAnswerShapeEnabled('off', 'guest-chat-luna')).toBe(false)
  })

  it('appends plain-prose guidance without changing earlier text or adding a private format', () => {
    const dynamic = 'DATE: x\n\nEND OF UNTRUSTED RETRIEVED DATA.'
    const appended = appendGuestAnswerShapeInstruction(dynamic)
    expect(appended.startsWith(`${dynamic}\n\n`)).toBe(true)
    expect(appended.endsWith(GUEST_ANSWER_SHAPE_INSTRUCTION)).toBe(true)
    expect(GUEST_ANSWER_SHAPE_INSTRUCTION).not.toMatch(/[\u2012-\u2015{}<>`]/u)
    // No clock times or case phrases that a model could echo into an answer.
    expect(GUEST_ANSWER_SHAPE_INSTRUCTION).not.toMatch(/\d/u)
  })
})
