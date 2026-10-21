/** Text normalization shared by venue-index compile and guest linking. Deterministic, locale-free. */

const STOPWORDS = new Set(
  (
    'a an and are as at be but by can could do does for from get go got had has have how i if in into is it its ' +
    'me my near of on or our out so than that the their them there these they this to too up us was we were what when ' +
    'where which who why will with would you your any all every some much many also just only please there here'
  ).split(' '),
)

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token)
}

/** Lowercase, fold quotes and accents, drop apostrophes, keep letters, digits and spaces. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc'`]/gu, '')
    .replace(/&/gu, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Light plural folding so "rides"/"ride" and "dippin dots"/"dippin dot" meet. Never shortens below 3 chars. */
export function stem(token: string): string {
  if (token.length <= 3 || /\d/u.test(token)) return token
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`
  if (/(ches|shes|xes|sses|zes)$/u.test(token)) return token.slice(0, -2)
  if (token.endsWith('s') && !/(ss|us|is)$/u.test(token)) return token.slice(0, -1)
  return token
}

export function stemTokens(value: string): string[] {
  const normalized = normalizeText(value)
  return normalized ? normalized.split(' ').map(stem) : []
}

export function phraseKey(value: string): string {
  return stemTokens(value).join(' ')
}

/** Every string reachable by deleting exactly one character (symmetric-delete fuzzy matching). */
export function singleDeletions(token: string): string[] {
  const out: string[] = []
  for (let index = 0; index < token.length; index += 1)
    out.push(token.slice(0, index) + token.slice(index + 1))
  return out
}

/** Exact substring test after whitespace and quote folding, used to verify quoted evidence. */
export function containsVerbatim(haystack: string, needle: string): boolean {
  const fold = (value: string) =>
    value
      .normalize('NFKC')
      .replace(/[\u2018\u2019\u02bc]/gu, "'")
      .replace(/[\u201c\u201d]/gu, '"')
      .replace(/\s+/gu, ' ')
      .trim()
  const target = fold(needle)
  return target.length > 0 && fold(haystack).includes(target)
}
