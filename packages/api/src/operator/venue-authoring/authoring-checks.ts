import type { VenuePackagePayload } from '../../schemas/venue-package'

/**
 * Meaning checks on a package that already matches the schema. They are advice for the authoring
 * agent: they never block an import and never change `ready`, because each one can be a false
 * positive on real venue text. Each finding names the field, the problem and the correction.
 */
export type AuthoringFinding = {
  code: string
  path: string
  message: string
  fix: string
}

type Field = { path: string; text: string }
type AuthoringRecord = {
  path: string
  kind: 'place' | 'knowledge'
  title: string
  fields: Field[]
  hours: string | null
}

const MONTH =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?'
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'iu')
const DATE_RANGE = new RegExp(
  `\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\s*(?:-|–|—|to|through|thru|until)\\s*(?:${MONTH}\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\b`,
  'iu',
)
const RANGE_END_WITH_YEAR = new RegExp(
  `(?:-|–|—|to|through|thru|until)\\s*(${MONTH})?\\s*(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:19|20)\\d{2})\\b`,
  'giu',
)
const YEAR = /\b(?:1[0-9]|20)\d{2}\b/gu
const SEASON_CUE =
  /\b(?:season|runs?|running|opens?|reopens?|returns?|festival|event|celebration|nights?|weekends?|through|until|from)\b/iu
const PAST_CUE =
  /\b(?:ended|ran|was|were|took place|returns?|returning|next|founded|built|opened in|since|history|historic|dates? not announced|not announced)\b/iu
const NUMERIC_DATE = /(?<![\d/.$])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/gu
const MEASURE_AFTER =
  /^\s*(?:mi(?:les?)?|cups?|lbs?|in(?:ch(?:es)?)?|hours?|hrs?|off|price|of|tsp|tbsp|oz)\b/iu
const OPEN_ENDED =
  /\b(?:TBD|TBA|to be (?:announced|determined|confirmed)|until further notice|coming soon|date[s]? pending)\b/iu
const PLACEHOLDER_LINE =
  /^\s*([A-Z][A-Za-z /&-]{1,30}):\s*(?:|TBD|TBA|N\/?A|unknown|\?+|none|-+|—|pending|not available|not listed|unconfirmed)\s*\.?\s*$/iu
const LABEL_LINE = /^\s*(Hours|Height|Age|Admission)\s*:\s*(.+?)\s*$/iu
const CLAIM =
  /\b(?:world'?s (?:largest|biggest|best|first|only|tallest|fastest)|#1|number one|guaranteed?|never (?:crowded|busy)|no (?:lines|waits?) ever|always open)\b/iu
const FACT_IN_NOTES =
  /(?:\$\s?\d|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\bheight\b|\b\d{2}\s?(?:in(?:ch(?:es)?)?|")\s|\bclosed on\b|\bopen (?:daily|until)\b)/iu
const GENERIC_TITLE_WORDS =
  /\b(?:information|info|details|policy|policies|guide|faq|faqs|rules|notes|the|and|&)\b/giu
const DAY_WORD =
  /\b(?:mon|tue|wed|thu|fri|sat|sun|daily|weekdays?|weekends?|closed|open|season|year-round|holidays?)/iu

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}

function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"“])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function placeFields(path: string, value: Record<string, unknown>): AuthoringRecord {
  const fields: Field[] = []
  for (const key of ['shortDescription', 'longDescription'] as const) {
    if (typeof value[key] === 'string' && value[key]) {
      fields.push({ path: `${path}.${key}`, text: value[key] as string })
    }
  }
  return {
    path,
    kind: 'place',
    title: String(value.name ?? ''),
    fields,
    hours: typeof value.hours === 'string' && value.hours ? value.hours : null,
  }
}

function knowledgeFields(path: string, value: Record<string, unknown>): AuthoringRecord {
  return {
    path,
    kind: 'knowledge',
    title: String(value.title ?? ''),
    fields: [{ path: `${path}.content`, text: String(value.content ?? '') }],
    hours: null,
  }
}

/** Every record a visitor could read after import, with its package path. */
export function authoringRecords(payload: VenuePackagePayload): AuthoringRecord[] {
  if (payload.schemaVersion === 3) {
    return [
      ...payload.places.create.map((operation, index) =>
        placeFields(`places.create.${index}.value`, operation.value as Record<string, unknown>),
      ),
      ...payload.places.update.flatMap((operation, index) =>
        operation.value.isActive
          ? [placeFields(`places.update.${index}.value`, operation.value)]
          : [],
      ),
      ...payload.knowledgeEntries.create.flatMap((operation, index) =>
        operation.value.isEnabled === false
          ? []
          : [knowledgeFields(`knowledgeEntries.create.${index}.value`, operation.value)],
      ),
      ...payload.knowledgeEntries.update.flatMap((operation, index) =>
        operation.value.isEnabled
          ? [knowledgeFields(`knowledgeEntries.update.${index}.value`, operation.value)]
          : [],
      ),
    ]
  }
  return [
    ...payload.places.map((place, index) =>
      placeFields(`places.${index}`, place as Record<string, unknown>),
    ),
    ...payload.knowledgeEntries.flatMap((entry, index) =>
      entry.isEnabled === false ? [] : [knowledgeFields(`knowledgeEntries.${index}`, entry)],
    ),
  ]
}

function dateChecks(field: Field, now: Date): AuthoringFinding[] {
  const findings: AuthoringFinding[] = []
  const currentYear = now.getUTCFullYear()
  const today = Date.UTC(currentYear, now.getUTCMonth(), now.getUTCDate())
  // A record that already says its run ended may keep the old dates on a labeled line.
  const saysEnded = /\b(?:ended|closed for the season)\b/iu.test(field.text)
  const lines = field.text.split(/\n+/u)
  for (const [line, sentence] of lines.flatMap((line) =>
    sentences(line).map((sentence) => [line, sentence] as const),
  )) {
    for (const match of sentence.matchAll(NUMERIC_DATE)) {
      const first = Number(match[1])
      const second = Number(match[2])
      const after = sentence.slice((match.index ?? 0) + match[0].length)
      const fraction = !match[3] && first < second && [2, 3, 4, 8].includes(second)
      if (first > 12 || second > 31 || fraction || MEASURE_AFTER.test(after)) continue
      findings.push({
        code: 'AMBIGUOUS_DATE',
        path: field.path,
        message: `"${match[0]}" can be read as two different dates, and visitors and the guide may read it differently.`,
        fix: 'Write the month name, day and year: "October 11, 2026".',
      })
      break
    }
    const years = [...sentence.matchAll(YEAR)].map((match) => Number(match[0]))
    const dated = MONTH_DAY.test(sentence)
    const range = DATE_RANGE.test(sentence)
    // A list of fixed holiday closures recurs every year and needs no year.
    const fixedClosures =
      /\bholidays?\b/iu.test(line) || (!range && /\b(?:closed|closures?)\b/iu.test(sentence))
    if (dated && years.length === 0 && !fixedClosures && (range || SEASON_CUE.test(sentence))) {
      findings.push({
        code: 'UNDATED_SEASON',
        path: field.path,
        message: `"${clip(sentence)}" gives dates without a year, so the guide cannot tell whether they are this year's, last year's or next year's.`,
        fix: `Add the year ("May 23 to August 16, ${currentYear}"). If next season's dates are not announced, say so ("${currentYear + 1} dates are not announced yet") instead of guessing.`,
      })
      continue
    }
    if (saysEnded || PAST_CUE.test(sentence)) continue
    let ended = false
    for (const match of sentence.matchAll(RANGE_END_WITH_YEAR)) {
      const monthText = (match[1] ?? sentence.match(new RegExp(MONTH, 'iu'))?.[0] ?? '')
        .slice(0, 3)
        .toLowerCase()
      const month = MONTHS[monthText]
      if (month === undefined) continue
      if (Date.UTC(Number(match[3]), month, Number(match[2])) < today) ended = true
    }
    const allPast =
      dated && years.length > 0 && SEASON_CUE.test(sentence) && Math.max(...years) < currentYear
    if (ended || allPast) {
      findings.push({
        code: 'STALE_DATE',
        path: field.path,
        message: `"${clip(sentence)}" describes a run that has already ended but reads as current.`,
        fix: 'Say it ended and, only if announced, when it returns ("The 2026 run ended October 31; 2027 dates are not announced yet"), or remove the record.',
      })
    }
  }
  return findings
}

function lineChecks(record: AuthoringRecord, field: Field): AuthoringFinding[] {
  const findings: AuthoringFinding[] = []
  const labels = new Map<string, string>()
  for (const line of field.text.split(/\n/u)) {
    const placeholder = line.match(PLACEHOLDER_LINE)
    if (placeholder) {
      findings.push({
        code: 'PLACEHOLDER_FACT',
        path: field.path,
        message: `"${clip(line.trim())}" is a label with no real value; the guide may repeat it to visitors.`,
        fix: `Remove the ${placeholder[1]} line. If visitors need to know it is unconfirmed, say so once in visitor terms ("Ask at Guest Services about ...").`,
      })
      continue
    }
    const label = line.match(LABEL_LINE)
    if (record.kind === 'place' && label) {
      const key = label[1]!.toLowerCase()
      const previous = labels.get(key)
      if (previous !== undefined && previous.toLowerCase() !== label[2]!.toLowerCase()) {
        findings.push({
          code: 'CONFLICTING_FACT',
          path: field.path,
          message: `"${record.title}" has two different ${label[1]} lines ("${clip(previous, 50)}" and "${clip(label[2]!, 50)}").`,
          fix: `Keep one ${label[1]} line with the best-supported value (the safer one for a safety rule). If it truly differs by day or season, write each case on the same line with its dates.`,
        })
      }
      labels.set(key, label[2]!)
    }
  }
  for (const sentence of sentences(field.text)) {
    // A placeholder line is already reported once as PLACEHOLDER_FACT.
    if (OPEN_ENDED.test(sentence) && !PLACEHOLDER_LINE.test(sentence)) {
      findings.push({
        code: 'OPEN_ENDED_TIME',
        path: field.path,
        message: `"${clip(sentence)}" leaves the time open with a research placeholder.`,
        fix: 'State what is known in visitor terms ("2027 dates are not announced yet"). For a live closure or change, use venues.propose_operational_update with a start and end instead of record text.',
      })
      break
    }
  }
  const claim = field.text.match(CLAIM)
  // "does not guarantee a place" is a caution, not a claim.
  const negated =
    claim?.index !== undefined &&
    /\b(?:not|no|never|cannot|can't|isn't|without)\s+(?:\w+\s+)?$/iu.test(
      field.text.slice(Math.max(0, claim.index - 30), claim.index),
    )
  if (claim && !negated) {
    findings.push({
      code: 'UNSUPPORTED_CLAIM',
      path: field.path,
      message: `"${claim[0]}" is a claim the guide will repeat as fact.`,
      fix: 'Keep it only if the venue itself states it (and keep its source in provenance); otherwise describe what the thing is.',
    })
  }
  return findings
}

function hoursCheck(record: AuthoringRecord): AuthoringFinding[] {
  if (record.kind !== 'place' || !record.hours) return []
  const hours = record.hours
  const misplaced = /\$|\bprice\b|\bheight\b|\btickets?\b/iu.test(hours)
  const notHours = !/\d/u.test(hours) && !DAY_WORD.test(hours)
  if (!misplaced && !notHours) return []
  return [
    {
      code: 'MISPLACED_FACT',
      path: `${record.path}.hours`,
      message: misplaced
        ? `The hours field carries other facts: "${clip(hours, 80)}".`
        : `The hours field does not read as opening times: "${clip(hours, 80)}".`,
      fix: 'Keep only days and times in hours ("10am-6pm daily, May 23 to August 16, 2026"). Prices, heights and rules go on labeled lines in longDescription.',
    },
  ]
}

function normalizedSentence(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function repeatedText(records: readonly AuthoringRecord[]): AuthoringFinding[] {
  const seen = new Map<string, { sentence: string; paths: string[] }>()
  for (const record of records) {
    const inRecord = new Set<string>()
    for (const field of record.fields) {
      for (const sentence of sentences(field.text)) {
        const key = normalizedSentence(sentence)
        if (key.split(' ').length < 8 || inRecord.has(key)) continue
        inRecord.add(key)
        const entry = seen.get(key) ?? { sentence, paths: [] }
        entry.paths.push(field.path)
        seen.set(key, entry)
      }
    }
  }
  return [...seen.values()]
    .filter((entry) => entry.paths.length >= 3)
    .map((entry) => ({
      code: 'REPEATED_TEXT',
      path: entry.paths[0]!,
      message: `The same sentence appears in ${entry.paths.length} records ("${clip(entry.sentence, 80)}"), first at ${entry.paths.slice(0, 3).join(', ')}.`,
      fix: 'Give it one home: keep it in the one topic it belongs to (for example a venue-wide caution in the hours or contact topic) and remove the copies.',
    }))
}

function topicKey(title: string): string {
  return title
    .toLowerCase()
    .replace(GENERIC_TITLE_WORDS, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function exactKey(title: string): string {
  return title.toLowerCase().replace(/\s+/gu, ' ').trim()
}

function nearDuplicateTopics(records: readonly AuthoringRecord[]): AuthoringFinding[] {
  const groups = new Map<string, AuthoringRecord[]>()
  for (const record of records) {
    if (record.kind !== 'knowledge') continue
    const key = topicKey(record.title)
    if (!key) continue
    groups.set(key, [...(groups.get(key) ?? []), record])
  }
  return [...groups.values()]
    .filter((group) => new Set(group.map((record) => exactKey(record.title))).size > 1)
    .map((group) => ({
      code: 'NEAR_DUPLICATE_TOPIC',
      path: group[1]!.path,
      message: `${group.map((record) => `"${record.title}"`).join(' and ')} look like the same subject in separate topics.`,
      fix: 'Merge them into one topic so the guide cannot read two versions of the same policy. Keep separate topics only when each covers a different subject, and make its title say which.',
    }))
}

function venueNotesCheck(payload: VenuePackagePayload): AuthoringFinding[] {
  if (payload.schemaVersion === 1) return []
  const notes = payload.venue?.aiBehavior?.aiGuideNotes
  if (!notes || !FACT_IN_NOTES.test(notes)) return []
  return [
    {
      code: 'FACT_IN_VOICE_NOTES',
      path: 'venue.aiBehavior.aiGuideNotes',
      message:
        'The AI guide notes contain a fact (a price, time, height or opening rule). These notes are voice and behavior instructions, not a fact source, and they are not dated or checked like records.',
      fix: 'Move the fact into the knowledge topic it belongs to (Hours and season, Tickets and prices, a ride record) and keep the notes about how the guide talks.',
    },
  ]
}

export function venuePackageAuthoringFindings(
  payload: VenuePackagePayload,
  now: Date,
): AuthoringFinding[] {
  const records = authoringRecords(payload)
  return [
    ...records.flatMap((record) => [
      ...record.fields.flatMap((field) => [
        ...dateChecks(field, now),
        ...lineChecks(record, field),
      ]),
      ...hoursCheck(record),
    ]),
    ...repeatedText(records),
    ...nearDuplicateTopics(records),
    ...venueNotesCheck(payload),
  ]
}
