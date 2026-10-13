import { describe, expect, it } from 'vitest'

import { guestAlreadySaidCue } from './guest-conversation-cues'

const closure = 'Fire Mountain Park is closed for the season and reopens in May 2032.'
const heights = 'The Comet needs riders to be at least 48 inches tall.'

describe('notices earlier replies already gave', () => {
  it('names a seasonal closure already given when the new question is about something else', () => {
    const cue = guestAlreadySaidCue({
      question: 'where should we eat after',
      previousReplies: [`Try the Comet. ${closure}`],
    })
    expect(cue).toContain('already told the visitor about the seasonal closure or reopening')
    expect(cue).not.toContain('rider height rules')
  })

  it('names rider height rules already given unless the question is about riding or kids', () => {
    expect(guestAlreadySaidCue({ question: 'who built it', previousReplies: [heights] })).toContain(
      'rider height rules',
    )
    for (const question of [
      'can my 5 year old ride it',
      'is she tall enough',
      'what about the kids',
    ])
      expect(guestAlreadySaidCue({ question, previousReplies: [heights] })).toBe('')
  })

  it('lets a closure come back when the visitor asks about hours, dates or a visit', () => {
    for (const question of ['when do you open next', 'is it open today', 'we are planning a trip'])
      expect(guestAlreadySaidCue({ question, previousReplies: [closure] })).toBe('')
  })

  it('says nothing on a first turn or when no notice was given', () => {
    expect(guestAlreadySaidCue({ question: 'where should we eat', previousReplies: [] })).toBe('')
    expect(
      guestAlreadySaidCue({
        question: 'where should we eat',
        previousReplies: ['The Comet is a wooden coaster from 1996.'],
      }),
    ).toBe('')
  })

  it('names both notices together', () => {
    expect(
      guestAlreadySaidCue({ question: 'any good snacks', previousReplies: [closure, heights] }),
    ).toContain('the seasonal closure or reopening and rider height rules. Do not repeat them')
  })
})
