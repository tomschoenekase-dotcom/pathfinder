import { describe, expect, it } from 'vitest'

import { enforceGuestRequiredNotices, guestNoticeCoverage } from './guest-required-notices'

// Fictional records only.
const rain = {
  text: 'Using the Rain Check Pass gives up the rest of your day, with no refund.',
  names: ['Rain Check Pass'],
  ref: 'k-rain',
}
const wristband = {
  text: 'A wristband is required for every guest.',
  names: ['Splash Zone'],
  ref: 'k-splash',
}

const enforce = (response: string, notices = [rain], actionable = false, threshold?: number) =>
  enforceGuestRequiredNotices({ response, notices, actionable, ...(threshold === undefined ? {} : { threshold }) })

describe('enforceGuestRequiredNotices', () => {
  it('appends the notice when the answer names the thing but omits the notice', () => {
    const r = enforce('The Rain Check Pass is sold at the front gate.')
    expect(r.appended).toEqual([rain.text])
    expect(r.checked).toBe(1)
    expect(r.response).toBe(`The Rain Check Pass is sold at the front gate. ${rain.text}`)
  })

  it('does not append when the answer paraphrases the notice with equivalent words', () => {
    const r = enforce('The Rain Check Pass means you forfeit the remainder of the day and get no money back.')
    expect(r.appended).toEqual([])
    expect(r.response).toBe('The Rain Check Pass means you forfeit the remainder of the day and get no money back.')
    expect(r.checked).toBe(1)
  })

  it('does not append when the thing is not mentioned and the question is not actionable', () => {
    const r = enforce('The park opens at nine.')
    expect(r.appended).toEqual([])
    expect(r.checked).toBe(0)
    expect(r.response).toBe('The park opens at nine.')
  })

  it('appends when actionable even without a name mention', () => {
    const r = enforce('You can get a pass at the gate.', [rain], true)
    expect(r.appended).toEqual([rain.text])
    expect(r.checked).toBe(1)
  })

  it('does not append for an actionable question when the answer already covers the notice', () => {
    const r = enforce('If you use it you give up the rest of the day and get no refund.', [rain], true)
    expect(r.appended).toEqual([])
    expect(r.checked).toBe(1)
  })

  it('matches names on identity keys (case, punctuation)', () => {
    const r = enforce('the rain-check pass is great.')
    expect(r.appended).toHaveLength(1)
  })

  it('does not match a name that is only part of a longer word', () => {
    expect(enforce('Our Rain Check Passes are cheap.').checked).toBe(0)
  })

  it('appends each distinct notice and counts them', () => {
    const r = enforce('Rain Check Pass and Splash Zone are open.', [rain, wristband])
    expect(r.appended).toEqual([rain.text, wristband.text])
    expect(r.checked).toBe(2)
    expect(r.response).toBe(`Rain Check Pass and Splash Zone are open. ${rain.text} ${wristband.text}`)
  })

  it('appends duplicate notice text once', () => {
    const r = enforce('The Rain Check Pass is sold here.', [rain, { ...rain, ref: 'other' }])
    expect(r.appended).toEqual([rain.text])
    expect(r.checked).toBe(1)
  })

  it('adds a period separator when the answer lacks final punctuation', () => {
    const r = enforce('The Rain Check Pass is sold at the gate')
    expect(r.response).toBe(`The Rain Check Pass is sold at the gate. ${rain.text}`)
  })

  it('uses a plain space after ?, ! or a closing quote or paren', () => {
    expect(enforce('Rain Check Pass?').response).toBe(`Rain Check Pass? ${rain.text}`)
    expect(enforce('Rain Check Pass!').response).toBe(`Rain Check Pass! ${rain.text}`)
    expect(enforce('Try the "Rain Check Pass."').response).toBe(`Try the "Rain Check Pass." ${rain.text}`)
    expect(enforce('(Rain Check Pass.)').response).toBe(`(Rain Check Pass.) ${rain.text}`)
  })

  it('trims trailing whitespace before appending', () => {
    expect(enforce('Rain Check Pass is sold here.  \n').response).toBe(`Rain Check Pass is sold here. ${rain.text}`)
  })

  it('trims the notice text when appending', () => {
    const padded = { ...rain, text: `  ${rain.text}  ` }
    expect(enforce('Rain Check Pass is here.', [padded]).appended).toEqual([rain.text])
  })

  it('returns the same response object text when nothing is appended and handles no notices', () => {
    expect(enforce('Anything.', []).response).toBe('Anything.')
    expect(enforce('Anything.', [], true)).toEqual({ response: 'Anything.', appended: [], checked: 0 })
  })

  it('honors a custom threshold', () => {
    const partial = 'Rain Check Pass: you give up the rest.'
    // coverage of this answer is 0.43 (name words ignored), so it passes at 0.4 and fails at 0.5
    expect(enforce(partial, [rain], false, 0.4).appended).toEqual([])
    expect(enforce(partial, [rain], false, 0.5).appended).toEqual([rain.text])
    expect(enforce('Rain Check Pass is here.', [rain], false, 0).appended).toEqual([])
  })

  it('skips a notice with no names when not actionable', () => {
    const r = enforce('Anything here.', [{ text: 'Be kind.', names: [], ref: 'x' }])
    expect(r.checked).toBe(0)
  })

  // Documented limitation from the module header: a negated mention counts as present.
  it('counts a negated mention as present (known lexical limit)', () => {
    const r = enforce('The Rain Check Pass does not make you give up the rest of the day, and refund is easy.')
    expect(r.appended).toEqual([])
  })
})

describe('guestNoticeCoverage', () => {
  it('is 1 for a notice with no distinctive words', () => {
    expect(guestNoticeCoverage('anything', 'It is the')).toBe(1)
  })

  it('is the fraction of notice words (by class) in the answer', () => {
    expect(guestNoticeCoverage('wristbands matter', 'A wristband is required for every guest.')).toBeCloseTo(1 / 4, 5)
    expect(guestNoticeCoverage('nothing relevant', 'A wristband is required for every guest.')).toBe(0)
  })

  it('treats equivalent words and plurals as the same word', () => {
    // "gives up" -> "up" has no equivalent in the answer, so a paraphrase is 3/4, still over the 0.5 threshold.
    expect(guestNoticeCoverage('You forfeit the remainder of today', 'You give up the rest of the day')).toBe(0.75)
    expect(guestNoticeCoverage('Refunds and remaining visits', 'Refund the rest')).toBe(1)
    expect(guestNoticeCoverage('parents need a wristband', 'A guardian is required')).toBe(1)
  })

  it('ignores the thing\'s own name words', () => {
    const notice = 'The Rain Check Pass is not refundable.'
    // Without ignore, "rain check pass" words must appear; with ignore only "refundable" counts.
    expect(guestNoticeCoverage('It is a refund thing', notice)).toBe(0.2)
    // rain/check/pass dropped; "not" (class cannot) is still wanted and missing
    expect(guestNoticeCoverage('It is a refund thing', notice, ['Rain Check Pass'])).toBe(0.5)
    expect(guestNoticeCoverage('It is not a refund thing', notice, ['Rain Check Pass'])).toBe(1)
  })

  it('keeps a name word that carries the notice meaning (equivalence class members)', () => {
    // "day" is in an equivalence class, so it is not ignored even when it is part of the name.
    const notice = 'The Sunny Day Pass ends the visit.'
    const withIgnore = guestNoticeCoverage('Sunny skies today', notice, ['Sunny Day Pass'])
    // wanted after ignoring: class:day (from "day" and "visit") and class:forfeit ("ends"); "today" covers day.
    expect(withIgnore).toBe(0.5)
  })

  it('is 1 when every notice word is a name word', () => {
    expect(guestNoticeCoverage('hello', 'Rain Check Pass', ['Rain Check Pass'])).toBe(1)
  })
})
