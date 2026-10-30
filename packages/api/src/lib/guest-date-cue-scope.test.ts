import { describe, expect, it } from 'vitest'
import { guestDateCueLunaScope, guestDateCuesForModel } from './guest-date-cue-scope'
import { guestTodayStatusEnabled } from './guest-today-status'
import { guestStatedDatesEnabled } from './guest-stated-dates'

describe('guest date cue pilot scope', () => {
  const flags = { GUEST_CHAT_TODAY_STATUS: 'on', GUEST_CHAT_STATED_DATES: 'on' }
  const scoped = { ...flags, GUEST_CHAT_DATE_CUES_MODEL_SCOPE: 'luna' }

  it.each(['guest-chat', 'guest-chat-sol-fast', 'guest-chat-luna-reasoning-high-fast', null])(
    'preserves existing all-model flags for %s when scope is absent',
    (key) => {
      expect(guestDateCueLunaScope(flags)).toBe(false)
      expect(guestDateCuesForModel(key, flags)).toBe(true)
    },
  )

  it.each(['guest-chat', 'guest-chat-sol-fast', 'guest-chat-lunatic', null])(
    'disables both cues for non-Luna model %s in Luna scope',
    (key) => {
      const admitted = guestDateCuesForModel(key, scoped)
      expect(admitted && guestTodayStatusEnabled(scoped)).toBe(false)
      expect(admitted && guestStatedDatesEnabled(scoped)).toBe(false)
    },
  )

  it.each(['guest-chat-luna', 'guest-chat-luna-reasoning-high-fast'])(
    'keeps both existing flags identical for %s',
    (key) => {
      const admitted = guestDateCuesForModel(key, scoped)
      expect(admitted && guestTodayStatusEnabled(scoped)).toBe(guestTodayStatusEnabled(flags))
      expect(admitted && guestStatedDatesEnabled(scoped)).toBe(guestStatedDatesEnabled(flags))
      expect(admitted && guestTodayStatusEnabled({})).toBe(false)
      expect(admitted && guestStatedDatesEnabled({})).toBe(false)
    },
  )
})
