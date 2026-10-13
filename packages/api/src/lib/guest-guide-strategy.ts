import { createHash } from 'node:crypto'
import type { SemanticKnowledgeEntry, SemanticPlace } from '@pathfinder/db'
import { guestQueryIsFollowup, normalizeGuestText } from './guest-knowledge-retrieval'
import { renderGuestVenueIndex } from './guest-venue-index'
import {
  buildGuestVenueGuidePrompt,
  guestDirectoryName,
  type GuestVenueDirectory,
  type GuestVenueGuidePrompt,
} from './guest-venue-directory'

/** Opt in only for the actual primary route, never for a fallback candidate. */
export function useTieredGuestGuide(flag: string | undefined, primaryCostTier?: string): boolean {
  return flag === '1' && primaryCostTier === 'ECONOMY'
}

export function buildGuestGuideStrategy(
  directory: GuestVenueDirectory,
  options: { currentDate: string; tiered: boolean; maxFullChars?: number },
): GuestVenueGuidePrompt {
  if (!options.tiered) return buildGuestVenueGuidePrompt(directory, options)
  const prompt = renderGuestVenueIndex(directory)
  const indexSha256 = createHash('sha256').update(prompt).digest('hex')
  return {
    prompt,
    mode: 'TIERED',
    evidenceText: `\n\nVENUE INDEX (tiered; ${prompt.length} characters; sha256 ${indexSha256})`,
    recordIds: new Set(),
    rendererTruncated: false,
    indexSha256,
  }
}

function aliases(text: string | null | undefined): string[] {
  return [...(text ?? '').matchAll(/^\s*Also called\s*:\s*(.+)$/gimu)]
    .flatMap((match) => match[1]!.split(/\s*(?:;|,|\||\s+or\s+)\s*/iu))
    .map((name) => name.trim().replace(/^['"“]|['"”.]$/gu, ''))
    .filter(Boolean)
}

// Match both boundaries: a mention of Thunderbolt must not match Thunderbolts.
function namedKeys(text: string, names: string[]): Set<string> {
  const normalized = normalizeGuestText(text)
  const matches: Array<{ key: string; start: number; end: number }> = []
  for (const name of names) {
    const key = normalizeGuestText(name.trim())
    if (!key) continue
    let at = normalized.indexOf(key)
    while (at >= 0) {
      const before = normalized[at - 1] ?? ''
      const after = normalized[at + key.length] ?? ''
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) {
        matches.push({ key, start: at, end: at + key.length })
      }
      at = normalized.indexOf(key, at + 1)
    }
  }
  // A mention of Thunderbolt Falls does not also name Thunderbolt. An independent
  // occurrence of the shorter name still counts, and identical names remain ambiguous.
  return new Set(matches.filter((match) => !matches.some((other) =>
    other.key.length > match.key.length && other.start <= match.start && other.end >= match.end,
  )).map((match) => match.key))
}

/** Named records bypass ranking and excerpt budgets, while live retrieved versions win. */
export function addExplicitGuestGuideRecords(params: {
  directory: GuestVenueDirectory
  question: string
  previousQuestion?: string | null
  places: SemanticPlace[]
  knowledgeEntries: SemanticKnowledgeEntry[]
}): { places: SemanticPlace[]; knowledgeEntries: SemanticKnowledgeEntry[] } {
  const allNames = [...new Set([
    ...params.directory.places.flatMap((place) => [place.name, guestDirectoryName(place.name),
      ...aliases(place.shortDescription), ...aliases(place.longDescription)]),
    ...params.directory.knowledge.flatMap((entry) => [entry.title, guestDirectoryName(entry.title),
      ...aliases(entry.content)]),
  ])]
  const currentNames = namedKeys(params.question, allNames)
  const referential = /\b(it|its|them|those|they)\b/u.test(normalizeGuestText(params.question))
  const previousNames = params.previousQuestion && guestQueryIsFollowup(params.question) &&
    (currentNames.size === 0 || referential)
    ? namedKeys(params.previousQuestion, allNames) : new Set<string>()
  const mentioned = (names: string[]) => names.some((name) =>
    currentNames.has(normalizeGuestText(name.trim())) || previousNames.has(normalizeGuestText(name.trim())),
  )
  const namedPlaces = params.directory.places.filter((place) =>
    mentioned([
      place.name,
      guestDirectoryName(place.name),
      ...aliases(place.shortDescription),
      ...aliases(place.longDescription),
    ]),
  )
  const namedPlaceNames = new Set(namedPlaces.map((place) => normalizeGuestText(place.name)))
  const topicMatchesSelectedLocation = (title: string): boolean => {
    const base = guestDirectoryName(title)
    const group = params.directory.places.filter((place) =>
      normalizeGuestText(guestDirectoryName(place.name)) === normalizeGuestText(base),
    )
    if (group.length < 2) return true
    const selected = group.filter((place) => params.places.some((hit) => hit.id === place.id))
    if (selected.length === 0 || selected.length === group.length) return true
    const areas = group.flatMap((place) => place.areaName ? [place.areaName] : [])
    const qualifiers = namedKeys(title.slice(base.length), areas)
    // Only an explicit area qualifier in the title establishes this association.
    // Shared topics and topics with unknown associations remain available.
    if (qualifiers.size === 0 || selected.some((place) => !place.areaName)) return true
    return selected.some((place) => qualifiers.has(normalizeGuestText(place.areaName!.trim())))
  }
  const knowledge = params.directory.knowledge.filter(
    (entry) =>
      (mentioned([entry.title, guestDirectoryName(entry.title), ...aliases(entry.content)]) ||
      namedPlaceNames.has(normalizeGuestText(guestDirectoryName(entry.title)))) &&
      topicMatchesSelectedLocation(entry.title),
  )
  const linkedNames = new Set(
    knowledge.map((entry) => normalizeGuestText(guestDirectoryName(entry.title))),
  )
  const places = params.directory.places.filter(
    (place) =>
      mentioned([
        place.name,
        guestDirectoryName(place.name),
        ...aliases(place.shortDescription),
        ...aliases(place.longDescription),
      ]) || linkedNames.has(normalizeGuestText(place.name)),
  )
  const placeIds = new Set(params.places.map((place) => place.id))
  const retrievedPlaceNames = new Set(params.places.map((place) => normalizeGuestText(place.name)))
  const knowledgeIds = new Set(params.knowledgeEntries.map((entry) => entry.id))
  return {
    places: [
      ...params.places.map((place) => {
        const full = places.find((candidate) => candidate.id === place.id)
        if (!full) return place
        // Place retrieval carries the entire body, including an authoritative null when
        // an operator clears it. Only an omitted projection field may be filled.
        if (full.name !== place.name || full.shortDescription !== place.shortDescription) return place
        return place.longDescription === undefined
          ? { ...place, longDescription: full.longDescription } : place
      }),
      // Identity resolution runs before expansion. A selected same-name place must not
      // regain another cached candidate that the location/floor resolver excluded.
      ...places.filter((place) => !placeIds.has(place.id) && !retrievedPlaceNames.has(normalizeGuestText(place.name))),
    ],
    knowledgeEntries: [
      ...params.knowledgeEntries.map((entry) => {
        const full = params.directory.knowledge.find((candidate) => candidate.id === entry.id)
        // Retrieval can have newer operator edits. Never replace those with cached content.
        const liveUpdatedAt = (entry as SemanticKnowledgeEntry & { updatedAt?: Date }).updatedAt
        if (!full) return entry
        if (liveUpdatedAt instanceof Date && full.updatedAt instanceof Date) {
          if (liveUpdatedAt.getTime() !== full.updatedAt.getTime()) return entry
        } else if (entry.content !== full.content) {
          // The retrieval excerpt marker establishes provenance only when every retained
          // segment appears in order in the cached record. Unversioned different text wins.
          if (!entry.content.includes('...[source excerpt]...')) return entry
          const segments = entry.content.split('...[source excerpt]...').map((part) => part.trim()).filter(Boolean)
          if (segments.length === 0) return entry
          let position = 0
          for (const segment of segments) {
            const found = full.content.indexOf(segment, position)
            if (found < 0) return entry
            position = found + segment.length
          }
        }
        return { ...entry, content: full.content }
      }),
      ...knowledge
        .filter((entry) => !knowledgeIds.has(entry.id))
        .map((entry) => ({ ...entry, distance: 1 })),
    ],
  }
}
