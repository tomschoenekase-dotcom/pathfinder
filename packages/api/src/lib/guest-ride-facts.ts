/**
 * Server-collected ride facts for "who made it", "how tall or fast", "oldest" and "does <maker>
 * have any rides here" questions. Lighter models answer well from a stated fact but scan a long
 * guide unreliably for the one line that holds a maker or a speed, and cannot be trusted to
 * conclude "none" across dozens of records. This module gathers the park's own labelled fact lines
 * ("Made by:", "Size and speed:", "Opened:") into one compact block, and for a named maker states
 * which rides name it and which rides have no maker on record. It never adds a fact: every value is
 * copied from a record, and a ride without the line is reported as having none on record.
 */

type FactRecord = { title: string; category: string; content: string }
type PlaceLike = {
  name: string
  type: string
  shortDescription: string | null
  longDescription: string | null
}
type DirectoryLike = { knowledge: ReadonlyArray<FactRecord>; places?: ReadonlyArray<PlaceLike> }

// Labelled lines that carry ride facts. "Height:" is the rider requirement and is handled elsewhere.
const FACT_LABEL =
  /^(made by|built by|designed by|designers?|designed and built by|manufacturer|maker|model|size and speed|size|speed|top speed|track|length|drop|inversions|opened|history|status)\s*:\s*(.+)$/i
const MAKER_LABEL =
  /^(made by|built by|designed by|designers?|designed and built by|manufacturer|maker)$/i

const QUESTION_CUES =
  /\b(who (made|built|designed|makes|builds)|made (it|this|that)|built (it|this|that)|manufactur\w*|maker|designer|build (their|its|your) own|make (their|its|your) own|how (tall|high|fast|big|long|old)|top speed|mph|feet tall|inversions?|upside down|loops?|tallest|fastest|biggest|oldest|newest|steepest|longest|when did .* open|what year)\b/i

// Well-known ride manufacturers, so a question naming one can be checked even when no record names it.
const KNOWN_MAKERS = [
  'Intamin',
  'Vekoma',
  'Bolliger & Mabillard',
  'B&M',
  'Rocky Mountain Construction',
  'RMC',
  'Mack',
  'Gerstlauer',
  'Zamperla',
  'Zierer',
  'Maurer',
  'S&S',
  'Premier Rides',
  'Great Coasters International',
  'GCI',
  'Gravity Group',
  'Custom Coasters International',
  'CCI',
  'Philadelphia Toboggan',
  'PTC',
  'Arrow',
  'Schwarzkopf',
  'Chance',
  'E&F Miler',
  'SBF',
  'Vekoma',
  'Hopkins',
  'Allan Herschell',
  'Morgan',
  'Togo',
  'Pinfari',
  'Larson',
]

const RIDE_KIND =
  /\b(coaster|ride|wheel|carousel|flume|drop tower|tower|swing|spinner|pendulum|log)\b/i

export type RideFact = {
  ride: string
  kind: string
  lines: string[]
  makers: string[]
  isCoaster: boolean
}

function firstSentence(text: string): string {
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? ''
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence
}

/** Each record's labelled fact lines, keyed by the record title. */
export function collectRideFacts(directory: DirectoryLike): RideFact[] {
  const facts: RideFact[] = []
  for (const record of directory.knowledge) {
    const lines: string[] = []
    const makers: string[] = []
    for (const raw of record.content.split('\n')) {
      const match = FACT_LABEL.exec(raw.trim())
      if (!match) continue
      // A "Size" line without a measurement is a rider-fit note, not a ride statistic.
      if (/^size$/i.test(match[1]!) && !/\d/.test(match[2]!)) continue
      lines.push(`${match[1]}: ${match[2]!.trim()}`)
      if (
        MAKER_LABEL.test(match[1]!) &&
        !/^(?:unknown|not (?:known|documented|published|available)|unconfirmed|tbd|n\/?a)\.?$/i.test(
          match[2]!.trim(),
        )
      )
        makers.push(match[2]!.trim())
    }
    const kind = firstSentence(record.content)
    const isRide = RIDE_KIND.test(kind)
    if (!lines.length && !isRide) continue
    // Overview records restate other records; only individual ride records are indexed.
    if (/overview|roller coasters$|^rides\b|history$/i.test(record.title) && !lines.length) continue
    // A current coaster: its own first sentence calls it one, and not a future or "not a coaster" ride.
    const isCoaster =
      /\bis an? [^.]*\bcoaster\b/i.test(kind) &&
      !/not an? (roller )?coaster/i.test(kind) &&
      !/\b(future|coming|not open yet|not (?:yet )?open|has not opened|will open|scheduled to open|planned|former|retired|permanently closed)\b/i.test(
        record.content
          .split(/\r?\n/)
          .filter((line) => !/^\s*[\w ]+:/.test(line) || /^\s*status:/i.test(line))
          .join(' '),
      )
    facts.push({ ride: record.title, kind, lines, makers, isCoaster })
  }
  return facts
}

function namedMaker(question: string, facts: RideFact[]): string | null {
  const recordMakers = facts.flatMap((f) => f.makers)
  for (const maker of [...recordMakers, ...KNOWN_MAKERS]) {
    const short = maker.split(/[(,;]/)[0]!.trim()
    const words = short.split(/\s+/)
    // Visitors shorten names ("custom coasters", "rocky mountain"); two leading words are enough.
    const forms = [short, ...(words.length > 2 ? [words.slice(0, 2).join(' ')] : [])]
    for (const form of forms) {
      if (form.length < 3) continue
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(^|[^\\w&])${escaped}(?![\\w&])`, 'i').test(question)) return short
    }
  }
  return null
}

/** The ride-facts block for this question, or null when the question is not about ride facts. */
export function guestRideFacts(input: {
  question: string
  directory: DirectoryLike
}): string | null {
  const facts = collectRideFacts(input.directory)
  const withLines = facts.filter((f) => f.lines.length)
  const maker = namedMaker(input.question, facts)
  if (!maker && !QUESTION_CUES.test(input.question)) return null
  if (!withLines.length && !maker) return null
  const out: string[] = [
    "RIDE FACTS (collected by the server from the park's own ride records; every value is the record's own wording):",
  ]
  // Keep an explicitly requested ride even when it falls beyond the compact block's budget.
  const named = (fact: RideFact) => {
    const title = fact.ride
      .replace(/\s*:\s*(?:ride facts|facts|ride details|details)\s*$/i, '')
      .trim()
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^\\w])${escaped}(?![\\w])`, 'i').test(input.question)
  }
  const selected = [...withLines.filter(named), ...withLines.filter((fact) => !named(fact))]
  for (const fact of selected.slice(0, 40))
    out.push(`- ${fact.ride} (${fact.kind.replace(/\s+/g, ' ')}) ${fact.lines.join(' | ')}`)
  const coasters = facts.filter((f) => f.isCoaster)
  const withoutMaker = coasters.filter((f) => !f.makers.length).map((f) => f.ride)
  if (coasters.length)
    out.push(
      withoutMaker.length
        ? `Roller coasters with no maker on record: ${withoutMaker.join(', ')}.`
        : 'Every roller coaster record names its maker or designer.',
    )
  if (maker) {
    const matches = facts.filter((f) =>
      f.makers.some((m) => m.toLowerCase().includes(maker.toLowerCase())),
    )
    out.push(
      matches.length
        ? `MAKER CHECK for ${maker}: ${matches.map((f) => f.ride).join(', ')} name ${maker} as maker or designer.`
        : withoutMaker.length
          ? `MAKER CHECK for ${maker}: no ride record names ${maker}, but the coasters with no maker on record (${withoutMaker.join(', ')}) could be by anyone, so whether the park has a ${maker} coaster is unknown.`
          : `MAKER CHECK for ${maker}: no ride record names ${maker}, and every roller coaster names a different maker, so none of the park's roller coasters are by ${maker}.`,
    )
  }
  return out.join('\n')
}
