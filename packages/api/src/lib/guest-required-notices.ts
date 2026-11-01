// Required notices: authored "Must mention:" sentences that must reach the visitor whenever the
// answer discusses the thing they belong to. The model is asked to include them; this check makes
// the outcome deterministic by appending the authored sentence when the answer lacks it.
//
// Why: in the 2026-11-01 diagnostic a weather pass's forfeiture was omitted in 3/10 answers with
// the existing prompt, 9/10 with compact prose and still 1/10 with typed fields. Instructions
// reduce omission; they do not remove it. The same pattern already guarantees the venue
// recommendation disclosure server-side.
//
// Limits: presence is judged lexically. A paraphrase using different words can cause a redundant
// append; a negated or garbled mention can be counted as present. Only authored notices are
// enforced, never sentences inferred from prose.

import { guestPlaceIdentityKey } from './guest-place-identity'
import type { GuestRequiredNotice } from './guest-evidence-assembly'

const STOP = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'is',
  'are',
  'be',
  'been',
  'it',
  'its',
  'this',
  'that',
  'your',
  'you',
  'if',
  'by',
  'as',
  'from',
  'will',
  'can',
  'any',
  'all',
  'then',
  'there',
  'their',
  'they',
  'one',
  'once',
  'only',
  'also',
  'must',
  'may',
  // The venue itself is named in most answers and proves nothing about a notice.
  'park',
  'garden',
  'gardens',
  'zoo',
  'museum',
  'venue',
])

// Small equivalence classes so ordinary paraphrases count as present.
const EQUIVALENT: ReadonlyArray<readonly string[]> = [
  ['forfeit', 'give', 'gives', 'giving', 'lose', 'loses', 'losing', 'end', 'ends', 'ending', 'surrender', 'void'],
  ['refund', 'refunds', 'refundable', 'money', 'reimburse'],
  ['rest', 'remainder', 'remaining'],
  ['day', 'today', 'visit'],
  ['leave', 'leaving', 'exit', 'exiting', 'depart'],
  ['reentry', 'readmission', 'readmit', 're', 'reenter', 'entry', 'enter', 'entering', 'admission', 'admitted'],
  ['same', 'today', 'tonight'],
  ['accept', 'accepting', 'take', 'taking', 'collect', 'collecting', 'use', 'using'],
  ['cannot', 'can\'t', 'not', 'no', 'never'],
  ['required', 'require', 'requires', 'need', 'needs', 'must'],
  ['adult', 'adults', 'parent', 'guardian', 'grownup'],
]

function stem(word: string): string {
  return word.replace(/(?:ing|ed|es|s)$/u, '')
}

function tokens(text: string): string[] {
  return (guestPlaceIdentityKey(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => !STOP.has(token))
}

function classOf(token: string): string {
  const found = EQUIVALENT.find((group) => group.includes(token) || group.some((member) => stem(member) === stem(token)))
  return found ? `class:${found[0]}` : stem(token)
}

/** Fraction of the notice's distinctive words (by class) that the answer contains. */
export function guestNoticeCoverage(answer: string, notice: string, ignore: ReadonlyArray<string> = []): number {
  // The thing's own name words prove nothing about the notice ("Rain pass" is in every answer
  // about it), unless the word carries the notice's meaning ("day" in "Sunny Day Pass").
  const ignored = new Set(
    ignore
      .flatMap(tokens)
      .map(classOf)
      .filter((token) => !token.startsWith('class:')),
  )
  const wanted = [...new Set(tokens(notice).map(classOf))].filter((token) => !ignored.has(token) && token.length > 1)
  if (!wanted.length) return 1
  const present = new Set(tokens(answer).map(classOf))
  return wanted.filter((token) => present.has(token)).length / wanted.length
}

function mentions(answerKey: string, name: string): boolean {
  const key = guestPlaceIdentityKey(name)
  return key.length >= 3 && ` ${answerKey} `.includes(` ${key} `)
}

export type GuestRequiredNoticeResult = {
  response: string
  appended: string[]
  checked: number
}

/**
 * Appends each required notice the answer needs but lacks. A notice is needed when the answer names
 * its thing, or when the question was actionable and the notice belongs to a subject or rule of
 * this turn. Fallback answers are never changed.
 */
export function enforceGuestRequiredNotices(input: {
  response: string
  notices: ReadonlyArray<GuestRequiredNotice>
  actionable: boolean
  threshold?: number
}): GuestRequiredNoticeResult {
  const threshold = input.threshold ?? 0.5
  const answerKey = guestPlaceIdentityKey(input.response)
  const appended: string[] = []
  let checked = 0
  const seen = new Set<string>()
  for (const notice of input.notices) {
    if (seen.has(notice.text)) continue
    seen.add(notice.text)
    const needed =
      (input.actionable && notice.onAction !== false) || notice.names.some((name) => mentions(answerKey, name))
    if (!needed) continue
    checked += 1
    if (guestNoticeCoverage(input.response, notice.text, notice.names) >= threshold) continue
    appended.push(notice.text.trim())
  }
  if (!appended.length) return { response: input.response, appended, checked }
  const separator = /[.!?]["”')]?\s*$/u.test(input.response) ? ' ' : '. '
  return { response: `${input.response.trimEnd()}${separator}${appended.join(' ')}`, appended, checked }
}
