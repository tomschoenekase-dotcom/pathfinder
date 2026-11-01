import { describe, expect, it } from 'vitest'

import { enforceGuestRequiredNotices, guestAnswerAdvisesUse, guestNoticeCoverage, guestNoticeIsCovered } from './guest-required-notices'

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

  it('does not let a low custom threshold bypass missing material clauses', () => {
    const partial = 'Rain Check Pass: you give up the rest.'
    // A numeric threshold cannot authorize erasing the refund clause.
    expect(enforce(partial, [rain], false, 0.4).appended).toEqual([rain.text])
    expect(enforce(partial, [rain], false, 0.5).appended).toEqual([rain.text])
    expect(enforce('Rain Check Pass is here.', [rain], false, 0).appended).toEqual([rain.text])
  })

  it('skips a notice with no names when not actionable', () => {
    const r = enforce('Anything here.', [{ text: 'Be kind.', names: [], ref: 'x' }])
    expect(r.checked).toBe(0)
  })

  it('does not count a negated consequence as present', () => {
    const r = enforce('The Rain Check Pass does not make you give up the rest of the day, and refund is easy.')
    expect(r.appended).toEqual([rain.text])
  })
})

describe('conservative notice satisfaction', () => {
  const removal = 'Remove bracelets before participating; wearing bracelets prevents participation.'
  const footwear = 'Wear closed-toe boots for workshops; open-toe boots prevent participation.'

  it.each([
    'Participants must remove bracelets.',
    'The encounter requires a photo badge and removing bracelets.',
    'Remove bracelets before the encounter.',
  ])('recognizes the required removal and its logical participation consequence: %s', (answer) => {
    expect(guestNoticeIsCovered(answer, removal)).toBe(true)
  })

  it.each([
    'Closed-toe boots are required.',
    'The workshop requires a badge and closed-toe boots; pauses do not guarantee refunds.',
    'It requires closed-toe boots and a badge.',
  ])('recognizes mandatory protective clothing: %s', (answer) => {
    expect(guestNoticeIsCovered(answer, footwear)).toBe(true)
  })

  it.each([
    'You do not need to remove bracelets.',
    'You never have to remove bracelets.',
    'Bracelets are optional.',
    'You must remove necklaces.',
    'Staff must remove bracelets.',
    'You can wear bracelets while participating.',
    'Bracelets are allowed; participants must remove bracelets.',
  ])('does not accept missing or contradictory removal: %s', (answer) => {
    expect(guestNoticeIsCovered(answer, removal)).toBe(false)
  })

  it.each([
    'Closed-toe boots are not required.',
    'Closed-toe boots are optional.',
    'Open-toe boots are required.',
    'Closed-toe shoes are required.',
    'You do not need closed-toe boots.',
    'Closed-toe boots are not needed and a badge is required.',
  ])('does not accept negated or different clothing: %s', (answer) => {
    expect(guestNoticeIsCovered(answer, footwear)).toBe(false)
  })

  it('does not discard an independent consequence', () => {
    expect(guestNoticeIsCovered('Participants must remove bracelets.', `${removal} Removing them costs $5.`)).toBe(false)
    expect(guestNoticeIsCovered('Remove bracelets before participating.', 'Remove bracelets before participating; stored bracelets cannot be returned.')).toBe(false)
  })

  it.each([
    ['A companion must be at least 18 years old.', 'A companion must be at least 16 years old.'],
    ['A companion must be at least 18 years old.', 'A participant must be at least 18 years old.'],
    ['A companion must be at least 18 years old.', 'A companion must be under 18 years old.'],
    ['Participants must be at least 48 inches tall.', 'Participants must be at least 48 years tall.'],
    ['If you accept credit, admission ends immediately.', 'Admission ends immediately.'],
    ['Admission ends immediately.', 'Admission continues immediately.'],
    ['No refunds are guaranteed.', 'Refunds are guaranteed.'],
    ['All participants must wear a yellow wristband.', 'All participants wear a yellow wristband.'],
  ])('retains conditions, roles, quantities, and polarity: %s', (notice, answer) => {
    expect(guestNoticeIsCovered(answer, notice)).toBe(false)
  })

  it('accepts literal non-English authored content but does not guess translations', () => {
    expect(guestNoticeIsCovered('Se requiere una pulsera para participar.', 'Se requiere una pulsera para participar.')).toBe(true)
    expect(guestNoticeIsCovered('A wristband is required.', 'Se requiere una pulsera para participar.')).toBe(false)
  })

  it('does not assemble an unrelated fact out of separate sentences', () => {
    expect(guestNoticeIsCovered('Admission ends tomorrow. Credit is available immediately.', 'Accepting credit ends admission immediately.')).toBe(false)
  })

  it('retains a specific activity scope on clothing notices', () => {
    const notice = 'Wear closed-toe boots for welding workshops; open-toe boots prevent participation.'
    expect(guestNoticeIsCovered('Closed-toe boots are required for pottery workshops.', notice)).toBe(false)
    expect(guestNoticeIsCovered('Closed-toe boots are required for welding workshops.', notice)).toBe(true)
  })

  it('supports an additional relevance fence without changing default enforcement', () => {
    const base = { response: 'Rain Check Pass is available.', notices: [rain], actionable: true }
    expect(enforceGuestRequiredNotices(base).checked).toBe(1)
    expect(enforceGuestRequiredNotices({ ...base, shouldEnforce: () => false })).toEqual({ response: base.response, appended: [], checked: 0 })
  })
})

describe('guestAnswerAdvisesUse', () => {
  it.each([
    'You can ride the Comet.',
    'You should buy the Comet pass.',
    'Guests may participate in Comet.',
    'I recommend using the Comet pass.',
    'Try Comet after lunch.',
    'Comet costs $8; you can ride it.',
  ])('recognizes subject-scoped advice when present in the same clause: %s', (answer) => {
    // A clause with only a pronoun cannot identify the notice subject safely.
    expect(guestAnswerAdvisesUse(answer, ['Comet'])).toBe(!answer.includes(';'))
  })

  it.each([
    'Comet costs $8.',
    'Comet is not included.',
    'You cannot ride Comet.',
    'You can’t use the Comet pass.',
    'I do not recommend using Comet.',
    'You can visit the aquarium. Comet is not included.',
    'You should buy the bundle; Comet is excluded.',
    'You can buy the bundle, which excludes Comet.',
    'Comet is not included and you can buy the bundle.',
    'A ticket can be bought for Comet.',
  ])('does not infer advice from mere mentions or another product: %s', (answer) => {
    expect(guestAnswerAdvisesUse(answer, ['Comet'])).toBe(false)
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

describe('notice subject attribution', () => {
  const cloud = {text: 'Cloud Pass has no refunds.', names: ['Cloud Pass'], ref: 'cloud'}
  const stone = {text: 'Stone Pass has no refunds.', names: ['Stone Pass'], ref: 'stone'}

  it('checks two offers with the same policy independently', () => {
    expect(enforceGuestRequiredNotices({
      response: 'Cloud Pass gives admission. Stone Pass has no refunds.',
      notices: [cloud, stone], actionable: true,
    }).appended).toEqual([cloud.text])
  })
  it('keeps an ordinary pronoun follow-up attached to its named subject', () => {
    expect(guestNoticeIsCovered('Cloud Pass is available. It has no refunds.', cloud.text, cloud.names, 0.5, stone.names)).toBe(true)
    expect(guestNoticeIsCovered('Cloud Pass gives admission. Stone Pass is available. It has no refunds.', cloud.text, cloud.names, 0.5, stone.names)).toBe(false)
  })
  it('rejects a named other subject even when it has no notice of its own', () => {
    expect(enforceGuestRequiredNotices({
      response: 'Cloud Pass gives admission. Stone Pass has no refunds.',
      notices: [cloud], actionable: true, knownOtherNames: stone.names,
    }).appended).toEqual([cloud.text])
  })
  it('accepts a generic refund statement for a single pass', () => {
    expect(guestNoticeIsCovered('The pass has no refunds.', cloud.text, cloud.names, 0.5, stone.names)).toBe(true)
    expect(guestNoticeIsCovered('It has no refunds.', cloud.text, cloud.names)).toBe(true)
  })
  it('fences an authored notice that does not contain its own thing name', () => {
    expect(guestNoticeIsCovered('Cloud Pass gives admission. Stone Pass has no refunds.', 'No refunds.', cloud.names, 0.5, stone.names)).toBe(false)
    expect(guestNoticeIsCovered('Cloud Pass has no refunds.', 'No refunds.', cloud.names, 0.5, stone.names)).toBe(true)
  })
})

describe('known subject context boundaries', () => {
  it('documents that names absent from evidence cannot be distinguished from ordinary prose', () => {
    expect(guestNoticeIsCovered('Cloud Pass gives admission. Stone Pass has no refunds.', 'Cloud Pass has no refunds.', ['Cloud Pass'])).toBe(true)
  })
  it('does not borrow a policy from an ambiguous pronoun after multiple offers', () => {
    expect(guestNoticeIsCovered('Cloud Pass and Stone Pass are available. It has no refunds.', 'Cloud Pass has no refunds.', ['Cloud Pass'], 0.5, ['Stone Pass'])).toBe(false)
  })
  it('accepts each offer when both notices are explicitly stated', () => {
    const notices = ['Cloud Pass', 'Stone Pass'].map(name => ({text: `${name} has no refunds.`, names: [name], ref: name}))
    expect(enforceGuestRequiredNotices({response: 'Cloud Pass has no refunds. Stone Pass has no refunds.', notices, actionable: true}).appended).toEqual([])
  })
})

it('does not let covered generic notice text skip another subjects missing notice', () => {
  const notices = ['Cloud Pass', 'Stone Pass'].map(name => ({text: 'No refunds.', names: [name], ref: name}))
  expect(enforceGuestRequiredNotices({response: 'Cloud Pass has no refunds. Stone Pass gives admission.', notices, actionable: true}).appended).toEqual(['No refunds.'])
})
