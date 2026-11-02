import { describe, expect, it } from 'vitest'
import { guestNoticeIsCovered } from './guest-required-notices'

describe('notice assertion mutations', () => {
  const notice = 'Children under 12 must wear wristbands before boarding.'
  it.each([
    'Adults under 12 must wear wristbands before boarding.',
    'Children over 12 must wear wristbands before boarding.',
    'Children under 14 must wear wristbands before boarding.',
    'Children under 12 must wear wristbands after boarding.',
    'Children under 12 might be required to wear wristbands before boarding.',
    'Must children under 12 wear wristbands before boarding?',
    'Children under 12 do not need to wear wristbands before boarding.',
  ])('does not mistake an altered assertion for the authored rule: %s', (answer) => {
    expect(guestNoticeIsCovered(answer, notice)).toBe(false)
  })
  it('does not equate a parent with a qualifying adult', () => {
    expect(
      guestNoticeIsCovered(
        'A parent must accompany children under 12 before boarding.',
        'An adult must accompany children under 12 before boarding.',
      ),
    ).toBe(false)
  })
  it('recognizes the passive form of a complete prerequisite', () => {
    expect(
      guestNoticeIsCovered(
        'Rings must be removed before participating.',
        'Remove rings before participating; wearing rings prevents participation.',
      ),
    ).toBe(true)
  })
})
