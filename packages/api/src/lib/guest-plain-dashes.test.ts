import { describe, expect, it } from 'vitest'

import { guestPlainDashes, guestPlainDashesStablePrefix } from './guest-plain-dashes'

const EM = '\u2014'
const EN = '\u2013'

describe('plain dashes in visitor answers', () => {
  it('turns a dash used as punctuation into a comma', () => {
    expect(guestPlainDashes(`It's a seated film with loud sound${EM}not a ride.`)).toBe(
      "It's a seated film with loud sound, not a ride.",
    )
    expect(guestPlainDashes(`The Comet ${EM} our big wooden coaster ${EM} opened in 1996.`)).toBe(
      'The Comet, our big wooden coaster, opened in 1996.',
    )
    expect(guestPlainDashes('Try the Comet - it is the classic.')).toBe(
      'Try the Comet, it is the classic.',
    )
  })

  it('preserves range dashes without inferring language or translating them', () => {
    expect(
      guestPlainDashes(`Open Friday${EN}Saturday, 9 am${EN}5 pm, and Sunday, 1${EN}5 pm.`),
    ).toBe('Open Friday-Saturday, 9 am-5 pm, and Sunday, 1-5 pm.')
    expect(guestPlainDashes(`Weekends May ${EN} October.`)).toBe('Weekends May-October.')
  })

  it('keeps minus signs and writes bare number ranges in a language-neutral way', () => {
    expect(guestPlainDashes('Abierto lunes–viernes.')).toBe('Abierto lunes-viernes.')
    expect(guestPlainDashes('Abierto 10 h–18 h.')).toBe('Abierto 10 h-18 h.')
    expect(guestPlainDashes('Ouvert lundi–vendredi, 10 h – 18 h.')).toBe(
      'Ouvert lundi-vendredi, 10 h-18 h.',
    )
    expect(guestPlainDashes('Es hat −5 Grad.')).toBe('Es hat −5 Grad.')
    expect(guestPlainDashes(`Geöffnet 10${EN}18 Uhr.`)).toBe('Geöffnet 10-18 Uhr.')
    expect(guestPlainDashes(`Call 555${EN}1234.`)).toBe('Call 555-1234.')
    expect(guestPlainDashes(`Ages 6 ${EN} 17 pay $6.`)).toBe('Ages 6-17 pay $6.')
  })

  it('never leaves doubled or dangling punctuation and keeps hyphenated words', () => {
    expect(guestPlainDashes(`Grab a slushie${EM}, then head out.`)).toBe(
      'Grab a slushie, then head out.',
    )
    expect(guestPlainDashes(`${EM} Start at the carousel ${EM}`)).toBe('Start at the carousel')
    expect(guestPlainDashes('A family-friendly, 48-inch ride.')).toBe(
      'A family-friendly, 48-inch ride.',
    )
    expect(guestPlainDashes('No dashes here.')).toBe('No dashes here.')
  })

  it('preserves exact bare and Markdown URL destinations while normalizing prose', () => {
    for (const url of [
      'https://example.org/hours/Friday–Saturday',
      'https://example.org/plan/arrival—parking?group=6–17#north—gate',
      'HTTPS://example.org/Friday–Saturday',
      'https://example.org/area/(north—gate)/Friday–Saturday',
      String.raw`https://example.org/north\)—gate`,
      String.raw`https://example.org/north\(—gate`,
    ]) {
      expect(guestPlainDashes(`Visit ${url} for details—before you arrive.`)).toBe(
        `Visit ${url} for details, before you arrive.`,
      )
      expect(guestPlainDashes(`[Official hours](${url})—check first.`)).toBe(
        `[Official hours](${url}), check first.`,
      )
    }
  })

  it('keeps streamed URL destinations stable at every character boundary', () => {
    for (const text of [
      'Visit https://example.org/arrival—parking?ages=6–17 for details—before arrival.',
      '[Official hours](https://example.org/Friday–Saturday)—check first.',
      '[Official hours](https://example.org/(north—gate)/Friday–Saturday)—check first.',
      'Visit https://example.org/(north—gate)/Friday–Saturday for hours.',
      String.raw`[Hours](https://example.org/north\)—gate)—check first.`,
      String.raw`[Hours](https://example.org/north\(—gate)—check first.`,
      String.raw`[Hours](https://example.org/north\\)—check first.`,
      '[Hours]( https://example.org/north—gate)—check first.',
    ]) {
      const final = guestPlainDashes(text)
      let shown = ''
      for (let end = 1; end <= text.length; end += 1) {
        const visible = guestPlainDashes(guestPlainDashesStablePrefix(text.slice(0, end)))
        expect(visible.startsWith(shown) || shown.startsWith(visible)).toBe(true)
        if (visible.length > shown.length) shown = visible
        expect(final.startsWith(shown)).toBe(true)
      }
    }
  })

  it('honors Markdown destination escapes and optional opening whitespace', () => {
    expect(
      guestPlainDashes(String.raw`[Hours](https://example.org/north\)—gate)—check first.`),
    ).toBe(String.raw`[Hours](https://example.org/north\)—gate), check first.`)
    expect(
      guestPlainDashes(String.raw`[Hours](https://example.org/north\(—gate)—check first.`),
    ).toBe(String.raw`[Hours](https://example.org/north\(—gate), check first.`)
    expect(guestPlainDashes(String.raw`[Hours](https://example.org/north\\)—check first.`)).toBe(
      String.raw`[Hours](https://example.org/north\\), check first.`,
    )
    expect(guestPlainDashes('[Hours]( https://example.org/north—gate)—check first.')).toBe(
      '[Hours]( https://example.org/north—gate), check first.',
    )
  })

  it('streams the same text it finally stores, one character at a time', () => {
    for (const text of [
      `Open Friday${EN}Saturday, 9 am${EN}5 pm. The Saturn V model${EM}huge${EM}is near Sat${EM}Saturn.`,
      'Try the Comet - it is the classic - then lunch.',
      'Abierto lunes–viernes, 10 h–18 h. Ouvert lundi–vendredi. 日曜日–金曜日。',
      `Mon${EM}Monkeys first, then Sat ${EM} Sun.`,
      `Ages 6${EN}17 and 10 ${EN} 18 Uhr, call 555${EN}1234.`,
    ]) {
      const final = guestPlainDashes(text)
      let shown = ''
      for (let end = 1; end <= text.length; end += 1) {
        const visible = guestPlainDashes(guestPlainDashesStablePrefix(text.slice(0, end)))
        // Text already shown is never rewritten; it only grows.
        expect(visible.startsWith(shown) || shown.startsWith(visible)).toBe(true)
        if (visible.length > shown.length) shown = visible
        expect(final.startsWith(shown)).toBe(true)
      }
      expect(final).not.toMatch(/[\u2012-\u2015]/u)
    }
  })
})
