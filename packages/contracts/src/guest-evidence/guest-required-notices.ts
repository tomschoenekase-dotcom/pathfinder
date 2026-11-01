// Required notices: authored "Must mention:" sentences that must reach the visitor whenever the
// answer discusses the thing they belong to. The model is asked to include them; this check makes
// the outcome deterministic by appending the authored sentence when the answer lacks it.
//
// Why: in the 2026-11-01 diagnostic a weather pass's forfeiture was omitted in 3/10 answers with
// the existing prompt, 9/10 with compact prose and still 1/10 with typed fields. Instructions
// reduce omission; they do not remove it. The same pattern already guarantees the venue
// recommendation disclosure server-side.
//
// Limits: this is a conservative lexical check, not semantic verification. Unknown paraphrases
// and translations can still cause an append. Only authored notices are enforced.

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

/** Positive use advice, fenced to a clause that names this notice's subject.
 * This is an additional relevance signal, never a classifier of the visitor's intent. */
export function guestAnswerAdvisesUse(response: string, names: ReadonlyArray<string>): boolean {
  return normalizedClauses(response.replace(/,|\b(?:and|but|which|whereas)\b/giu, ';')).some((clause) => {
    if (!names.some((name) => mentions(clause, name))) return false
    if (/\b(?:do not|not|never) recommend\b/u.test(clause)
      || /\b(?:excluded|not included|does not include|is not included|is not available|is unavailable)\b/u.test(clause)) return false
    return /\b(?:you|we|they|guests?|visitors?|participants?) (?:can|should|may|could) (?:visit|use|buy|purchase|ride|participate|take|accept|collect|try|book|enter)\b/u.test(clause)
      || /\b(?:i|we) recommend (?:using|buying|purchasing|riding|visiting|taking|accepting|booking|trying)\b/u.test(clause)
      || /^(?:try|use|buy|purchase|ride|visit|take|accept|collect|book)\b/u.test(clause)
  })
}

function normalizedClauses(text: string): string[] {
  return text
    .replace(/[’']/gu, "'")
    .replace(/\b(can't|cannot)\b/giu, 'can not')
    .replace(/n't\b/giu, ' not')
    .split(/[.!?;\n]+/u)
    .map(guestPlaceIdentityKey)
    .filter(Boolean)
}

const NEGATIVE = /\b(?:not|no|never|without|nonrefundable|prohibited|forbidden)\b/u

/** Resolve only nested name occurrences by specificity. A separate short-name
 * occurrence still competes; the longest name elsewhere cannot erase it. */
function namedSubjects(text: string, names: ReadonlyArray<string>, knownOtherNames: ReadonlyArray<string>): { own: boolean; other: boolean } {
  const key = ` ${guestPlaceIdentityKey(text)} `
  const ownKeys = new Set(names.map(guestPlaceIdentityKey))
  const candidates = [
    ...names.map((name) => ({ name, own: true })),
    ...knownOtherNames.filter((name) => !ownKeys.has(guestPlaceIdentityKey(name))).map((name) => ({ name, own: false })),
  ]
  const spans: Array<{ start: number; end: number; own: boolean }> = []
  for (const candidate of candidates) {
    const name = guestPlaceIdentityKey(candidate.name)
    if (name.length < 3) continue
    let start = key.indexOf(` ${name} `)
    while (start >= 0) {
      spans.push({ start: start + 1, end: start + 1 + name.length, own: candidate.own })
      start = key.indexOf(` ${name} `, start + 1)
    }
  }
  const specific = spans.filter((span) => !spans.some((other) => other.start <= span.start && other.end >= span.end
    && other.end - other.start > span.end - span.start))
  return { own: specific.some((span) => span.own), other: specific.some((span) => !span.own) }
}

/** Keep a named subject's policy from satisfying another subject's notice. Unnamed follow-up
 * clauses inherit the last explicit subject; a single-subject answer can still use "it" or
 * "the pass". Names come from authorized evidence, never guesses about capitalized prose. */
function subjectClauses(answer: string, names: ReadonlyArray<string>, knownOtherNames: ReadonlyArray<string>): string[] {
  const clauses = normalizedClauses(answer.replace(/,|\b(?:and|but)\b/giu, ';'))
  const hasOther = clauses.some((clause) => namedSubjects(clause, names, knownOtherNames).other)
  let current = !hasOther
  return clauses.filter((clause) => {
    const { own, other } = namedSubjects(clause, names, knownOtherNames)
    if (own || other) current = own && !other
    return current
  })
}

/** Recognize a prerequisite plus a restatement of its participation consequence.
 * Objects must match exactly. No refund, fee, timing, or other consequence is discarded. */
function prerequisiteCovered(answer: string, notice: string): boolean {
  const parts = normalizedClauses(notice)
  if (parts.length !== 2) return false
  const removal = /^remove (.+) before participating$/u.exec(parts[0]!)
  const wearing = /^wear (.+) for (.+)$/u.exec(parts[0]!)
  const object = removal?.[1] ?? wearing?.[1]
  if (!object) return false
  if (removal && parts[1] !== `wearing ${object} prevents participation`) return false
  // A closed/open modifier is a lexical complement, not a general semantic guess.
  if (wearing && (!object.startsWith('closed ') || parts[1] !== `${object.replace(/^closed /u, 'open ')} prevent participation`)) return false
  const clauses = normalizedClauses(answer)
  if (wearing && !/^(?:workshops|activities|participation)$/u.test(wearing[2]!)
    && !clauses.some((clause) => ` ${clause} `.includes(` ${wearing[2]} `))) return false
  const relevant = clauses.filter((clause) => ` ${clause} `.includes(` ${object} `))
  const escaped = object.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  // A contradictory clause cannot be repaired by a second matching phrase elsewhere.
  if (relevant.some((clause) => new RegExp(`\\b(?:not|never|no)\\b(?:(?!\\band\\b).){0,60}\\b${escaped}\\b|\\b${escaped}\\b.{0,25}\\b(?:not required|not needed|not mandatory|not necessary|optional|recommended|unnecessary|allowed|permitted|forbidden|prohibited)\\b`, 'u').test(clause))) return false
  return relevant.filter((clause) => !/\b(?:staff|companions?|instructors?|guides?|some|certain)\b/u.test(clause)).some((clause) => removal
    ? new RegExp(`\\b(?:must|need to|have to) remove (?:your |all )?${escaped}\\b`, 'u').test(clause)
      || new RegExp(`\\b${escaped} (?:must|have to|need to) be removed\\b`, 'u').test(clause)
      || new RegExp(`\\b(?:requires?|required|need)\\b.{0,60}\\b(?:removing|removal of) ${escaped}\\b`, 'u').test(clause)
      || new RegExp(`^remove (?:your |all )?${escaped}\\b`, 'u').test(clause)
    : new RegExp(`\\b${escaped}\\b.{0,60}\\b(?:required|mandatory|needed)\\b`, 'u').test(clause)
      || new RegExp(`\\b(?:requires?|need|must wear|have to wear)\\b.{0,60}\\b${escaped}\\b`, 'u').test(clause)
      || new RegExp(`^wear ${escaped}\\b`, 'u').test(clause))
}

/** Do not let a high bag-of-words score erase polarity, quantities, or a condition.
 * Clause-local checks also prevent unrelated sentences from supplying missing words. */
export function guestNoticeIsCovered(answer: string, notice: string, names: ReadonlyArray<string> = [], threshold = 0.5, knownOtherNames: ReadonlyArray<string> = []): boolean {
  // A question repeats words without asserting them. Keep other declarative sentences
  // available so an unrelated question does not discard a correctly supplied notice.
  const assertions = (answer.match(/[^.!?\n]+[.!?]?/gu) ?? [])
    .filter((sentence) => !/\?\s*$/u.test(sentence))
    .join(' ')
  const relevantClauses = subjectClauses(assertions, names, knownOtherNames)
  // Preserve conjunctions inside a prerequisite when there is no competing named subject.
  const hasOtherSubject = namedSubjects(assertions, names, knownOtherNames).other
  const relevantAssertions = hasOtherSubject ? relevantClauses.join('. ') : assertions
  const tentative = /\b(?:might|maybe|perhaps|possibly|uncertain|unclear|may)\b/iu
  if ((!tentative.test(relevantAssertions) || tentative.test(notice)) && prerequisiteCovered(relevantAssertions, notice)) return true
  const canonical = (text: string) => {
    let key = guestPlaceIdentityKey(text.replace(/[’']/gu, "'"))
    key = key.replace(/\b(?:give|gives|giving) up\b/gu, 'forfeit')
    key = key.replace(/\bnon refundable\b/gu, 'no refund')
    key = key.replace(/\bre enter\b/gu, 'reentry')
    key = key.replace(/\bleaving (?:the (?:park|venue) )?ends same day re entry\b/gu, 'no reentry after leaving')
    key = key.replace(/\bcan not reentry\b/gu, 'no reentry')
    for (const name of names) {
      const label = guestPlaceIdentityKey(name)
      if (label) key = key.replace(`using the ${label}`, label).replace(`using ${label}`, label)
    }
    return key
  }
  const answerClauses = relevantClauses.map(canonical)
  const noticeClauses = normalizedClauses(notice.replace(/,|\b(?:and|but)\b/giu, ';')).map(canonical)
  return noticeClauses.every((wanted) => {
    if (answerClauses.some((present) => NEGATIVE.test(wanted) !== NEGATIVE.test(present)
      && guestNoticeCoverage(present, wanted, names) >= 0.8)) return false
    return answerClauses.some((present) => {
    if (tentative.test(present) && !tentative.test(wanted)) return false
    if (NEGATIVE.test(wanted) !== NEGATIVE.test(present)) return false
    const obligation = /\b(?:must|required|requires?|needs?|mandatory)\b/u
    if (obligation.test(wanted) && !obligation.test(present)) return false
    const quantities = wanted.match(/\b\d+(?: \d+)?\b/gu) ?? []
    if (quantities.some((quantity) => !` ${present} `.includes(` ${quantity} `))) return false
    // Conditions and comparison directions are material even though legacy coverage ignores them.
    for (const marker of ['if', 'unless', 'before', 'after', 'under', 'over', 'below', 'above', 'only', 'at least', 'at most', 'minimum', 'maximum']) {
      if (new RegExp(`\\b${marker}\\b`, 'u').test(wanted) && !new RegExp(`\\b${marker}\\b`, 'u').test(present)) return false
    }
    for (const role of [/\briders?\b/u, /\bparticipants?\b/u, /\bcompanions?\b/u, /\badults?\b/u, /\b(?:child|children)\b/u, /\bparents?\b/u, /\bguardians?\b/u]) {
      if (role.test(wanted) && !role.test(present)) return false
    }
    for (const unit of ['inch', 'feet', 'year', 'month', 'dollar', 'minute', 'hour']) {
      if (tokens(wanted).some((token) => classOf(token) === classOf(unit))
        && !tokens(present).some((token) => classOf(token) === classOf(unit))) return false
    }
    // Avoid treating lexical antonyms as equivalent policy statements.
    for (const [left, right] of [['required', 'optional'], ['ends', 'continues'], ['lose', 'keep'], ['before', 'after'], ['under', 'over'], ['below', 'above']]) {
      if (new RegExp(`\\b${left}\\b`, 'u').test(wanted) && new RegExp(`\\b${right}\\b`, 'u').test(present)) return false
    }
    return guestNoticeCoverage(present, wanted, names) >= Math.max(threshold, 0.8)
    })
  })
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
  /** Other authorized thing names in the answer's evidence, including things without notices. */
  knownOtherNames?: ReadonlyArray<string>
  /** Additional turn-specific relevance fence; absence keeps the existing name/action gate. */
  shouldEnforce?: (notice: GuestRequiredNotice) => boolean
}): GuestRequiredNoticeResult {
  const threshold = input.threshold ?? 0.5
  const answerKey = guestPlaceIdentityKey(input.response)
  const appended: string[] = []
  let checked = 0
  const seen = new Set<string>()
  for (const notice of input.notices) {
    if (input.shouldEnforce && !input.shouldEnforce(notice)) continue
    if (notice.requiredForQuestion === false && !guestAnswerAdvisesUse(input.response, notice.names)) continue
    if (seen.has(notice.text)) continue
    // A named policy may contain the product name without discussing product use.
    // Strip only authorized context names for this local gate; coverage and the
    // visitor-facing answer retain the original text. Independent product mentions
    // elsewhere in the answer still count.
    let mentionKey = ` ${answerKey} `
    for (const name of [...(notice.mentionExcludingNames ?? [])].sort((left, right) => right.length - left.length)) {
      const contextKey = guestPlaceIdentityKey(name)
      if (contextKey) mentionKey = mentionKey.replaceAll(` ${contextKey} `, ' ')
    }
    const needed =
      (input.actionable && notice.onAction !== false) || notice.names.some((name) => mentions(mentionKey.trim(), name))
    if (!needed) continue
    checked += 1
    const otherNames = [...(input.knownOtherNames ?? []), ...input.notices.flatMap((candidate) => candidate.names)]
    if (guestNoticeIsCovered(input.response, notice.text, notice.names, threshold, otherNames)) continue
    // Coverage for one subject does not establish the same text for another subject.
    // Deduplicate appended sentences only, after each subject's coverage has been checked.
    seen.add(notice.text)
    appended.push(notice.text.trim())
  }
  if (!appended.length) return { response: input.response, appended, checked }
  const separator = /[.!?]["”')]?\s*$/u.test(input.response) ? ' ' : '. '
  return { response: `${input.response.trimEnd()}${separator}${appended.join(' ')}`, appended, checked }
}
