// Figure dash, en dash, em dash, horizontal bar and minus sign, plus a hyphen used as a spaced dash.
const DASH_CHARS = '\u2012-\u2015\u2212'
const DASH = new RegExp(String.raw`[ \t]*(?:[${DASH_CHARS}]|(?<=\S) -(?= ))[ \t]*`, 'gu')
const ANY_DASH = new RegExp(String.raw`[${DASH_CHARS}]| - `, 'u')
const TRAILING = new RegExp(String.raw`[\s${DASH_CHARS}-]+$`, 'u')
const DAY = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|urday)?'
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*'
// A number, a time, a weekday or a month on both sides makes a dash read as "to".
const RANGE_END = new RegExp(
  String.raw`(?:\d(?:\s?(?:am|pm|a\.m\.|p\.m\.))?|\b${DAY}\.?|\b${MONTH}\.?)$`,
  'iu',
)
const RANGE_START = new RegExp(String.raw`^(?:\d|${DAY}\b|${MONTH}\b)`, 'iu')

/**
 * Visitor answers never contain dashes used as punctuation. A range ("9 am to 5 pm",
 * "Friday to Sunday") reads "to"; any other dash becomes a comma, and disappears before other
 * punctuation or at either end of the text. Hyphenated words are unchanged.
 *
 * Each dash is decided by the text before it and the word after it, so a streamed prefix cut at
 * guestPlainDashesStablePrefix is never rewritten by later text.
 */
export function guestPlainDashes(text: string): string {
  if (!ANY_DASH.test(text)) return text
  return text.replace(DASH, (match: string, offset: number, whole: string) => {
    const before = whole.slice(0, offset)
    const after = whole.slice(offset + match.length)
    if (!before.trim() || !after.trim()) return ''
    if (/^[,.;:!?)\]]/u.test(after)) return ''
    if (/[,;:(\[]$/u.test(before.trimEnd())) return ' '
    if (RANGE_END.test(before.trimEnd()) && RANGE_START.test(after)) return ' to '
    return ', '
  })
}

/**
 * The part of a streamed text whose dashes are already decided: trailing whitespace and dashes
 * wait for the next word, and so does a dash whose following word is still being written, since
 * "Sat" may become "Saturday" or "Saturn".
 */
export function guestPlainDashesStablePrefix(text: string): string {
  const settled = text.replace(TRAILING, '')
  let lastDashEnd = -1
  let lastDashStart = -1
  for (const match of settled.matchAll(DASH)) {
    lastDashStart = match.index
    lastDashEnd = match.index + match[0].length
  }
  if (lastDashEnd < 0) return settled
  return /[\s,.;:!?)\]]/u.test(settled.slice(lastDashEnd))
    ? settled
    : settled.slice(0, lastDashStart).trimEnd()
}
