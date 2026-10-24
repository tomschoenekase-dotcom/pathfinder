// Figure dash, en dash, em dash and horizontal bar, plus a hyphen used as a spaced dash.
// The minus sign (U+2212) is a sign, not punctuation, so it is kept.
const DASH_CHARS = '\u2012-\u2015'
const DASH = new RegExp(String.raw`[ \t]*(?:[${DASH_CHARS}]|(?<=\S) -(?= ))[ \t]*`, 'gu')
const ANY_DASH = new RegExp(String.raw`[${DASH_CHARS}]| - `, 'u')
const TRAILING = new RegExp(String.raw`[\s${DASH_CHARS}-]+$`, 'u')
const NUMBER_END = /\d$/u
const NUMBER_START = /^\d/u

/**
 * Normalize typographic dashes without translating possible ranges. Figure/en dashes may be ranges in any
 * language, so preserve their relation with a plain hyphen rather than guessing words or units.
 * Em dashes, horizontal bars and spaced hyphens are punctuation and become commas, except
 * between digits. Minus signs and hyphenated words are unchanged.
 *
 * Each dash is decided by the text before it and the word after it, so a streamed prefix cut at
 * guestPlainDashesStablePrefix is never rewritten by later text.
 */
export function guestPlainDashes(text: string): string {
  if (!ANY_DASH.test(text)) return text
  // A URL's path/query bytes identify its destination. Treat bare URLs and Markdown
  // destinations alike, including a URL still arriving in a streamed answer.
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"`]+/giu)].map((match) => {
    let length = match[0].length
    if (/\]\(\s*$/u.test(text.slice(0, match.index))) {
      let depth = 0
      for (let index = 0; index < match[0].length; index += 1) {
        // Markdown escapes do not open or close the destination. Skipping pairs
        // also leaves an even run of backslashes followed by a real delimiter.
        if (match[0][index] === '\\') index += 1
        else if (match[0][index] === '(') depth += 1
        else if (match[0][index] === ')') {
          if (depth === 0) {
            length = index
            break
          }
          depth -= 1
        }
      }
    }
    return { start: match.index, end: match.index + length }
  })
  return text.replace(DASH, (match: string, offset: number, whole: string) => {
    if (urls.some((url) => offset >= url.start && offset < url.end)) return match
    const before = whole.slice(0, offset)
    const after = whole.slice(offset + match.length)
    if (!before.trim() || !after.trim()) return ''
    if (/^[,.;:!?)\]]/u.test(after)) return ''
    if (/[,;:([]$/u.test(before.trimEnd())) return ' '
    if (/[\u2012\u2013]/u.test(match)) return '-'
    if (NUMBER_END.test(before.trimEnd()) && NUMBER_START.test(after)) return '-'
    return ', '
  })
}

/**
 * The part of a streamed text whose dashes are already decided: trailing whitespace and dashes
 * wait for the next word, and so does a dash whose following word is still being written.
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
