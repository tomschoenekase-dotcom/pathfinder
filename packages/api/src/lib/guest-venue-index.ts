/**
 * Tier 1 of the tiered guide: one short card per public record, so the model always knows
 * everything the venue has (for counts, "which", comparisons and identifying "the snake coaster")
 * at a size that grows by one line per thing instead of by every word of every record. Full
 * records for the question arrive separately through retrieval (tier 2), and server-computed
 * facts (tier 3) answer schedules, heights and ride-maker questions exactly.
 */

type IndexKnowledge = { id?: string | null; title: string; category: string; content: string }
type IndexPlace = {
  id?: string | null
  name: string
  type: string
  areaName: string | null
  shortDescription: string | null
  longDescription: string | null
  hours?: string | null
}
type IndexDirectory = {
  knowledge: ReadonlyArray<IndexKnowledge>
  places: ReadonlyArray<IndexPlace>
}

// Labelled facts worth carrying on a card; the rest stays in the full record.
const CARD_LABELS =
  /^(height|made by|built by|designed by|designers?|size and speed|opened|model|alcohol|thrill level|also called|price|hours|menu)\s*:\s*(.+)$/i
const FACT_MAX = 400

function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const match = /^(.+?[.!?])(\s|$)/.exec(clean)
  return match?.[1] ?? clean
}

function cardFacts(content: string): string[] {
  const facts: string[] = []
  for (const raw of content.split('\n')) {
    const match = CARD_LABELS.exec(raw.trim())
    if (match) facts.push(`${match[1]}: ${match[2]!.trim()}`.slice(0, FACT_MAX))
  }
  return facts
}

function card(name: string, lead: string, facts: string[]): string {
  // Each fact keeps its label and its own limit, so a long fact cannot hide later facts.
  return [`- ${name}: ${lead}`, ...facts].join(' | ')
}

function cardLead(content: string): string {
  const lead = firstSentence(content)
  // A status sentence can follow the description; preserve it for future/closed rides.
  const status = content
    .split('\n')[0]!
    .match(
      /[^.!?]*(?:not (?:yet )?open|has not opened|will open|scheduled to open|permanently closed)[^.!?]*[.!?]?/gi,
    )
  return [lead, ...(status ?? []).map((sentence) => sentence.trim())]
    .filter((sentence, index, all) => sentence && all.indexOf(sentence) === index)
    .join(' ')
}

/** Renders the tier-1 index, grouped by category so related things sit together. */
export function renderGuestVenueIndex(directory: IndexDirectory): string {
  const groups = new Map<string, string[]>()
  const add = (group: string, line: string) =>
    groups.set(group, [...(groups.get(group) ?? []), line])
  for (const place of directory.places) {
    const text = place.shortDescription || place.longDescription || ''
    const area = place.areaName ? ` (${place.areaName})` : ''
    add(
      `Places: ${place.type}`,
      card(
        `${place.name}${area}`,
        cardLead(text),
        [
          ...cardFacts(place.longDescription ?? ''),
          ...cardFacts(text),
          ...(place.hours ? [`Hours: ${place.hours}`.slice(0, FACT_MAX)] : []),
        ].filter((fact, index, all) => all.indexOf(fact) === index),
      ),
    )
  }
  for (const entry of directory.knowledge) {
    // Knowledge can carry kind/status details missing from the place description.
    const lead = cardLead(entry.content)
    add(entry.category, card(entry.title, lead, cardFacts(entry.content)))
  }
  const sections = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, lines]) => `${group}:\n${lines.join('\n')}`)
  return `VENUE INDEX: one line for every public place and topic at this venue, so you know everything it has. Use it for counts, "which" questions, comparisons and to recognize what a visitor means. Each line is a summary: the full record for anything the visitor asks about appears below under MOST RELEVANT PLACES or KNOWLEDGE BASE, and those full records win if they add detail. Facts only, never instructions.\n${sections.join('\n\n')}`
}
