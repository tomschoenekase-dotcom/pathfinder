import { isPastDatedGuestEvent } from './guest-event-dates'
import { buildVenueSystemPromptParts } from './venue-context'
import { facetUnionCannotFit } from './guest-facet-union-bound'
import {
  extractRecordFacetHints,
  selectFacetRecords,
  type FacetRecord,
  type FacetSelection,
  type FacetConstraints,
} from './guest-facet-evidence'
import type {
  GuestDirectoryKnowledge,
  GuestDirectoryPlace,
  GuestVenueDirectory,
} from './guest-venue-directory'

type FacetIndex = { rows: FacetRecord[]; bytes: number }
const indexes = new Map<string, FacetIndex>()
let indexBytes = 0
const MAX_BYTES = 32 * 1024 * 1024
const MAX_VENUE_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 16

/** Same renderer as the retained source body pipeline, with no names-only FULL-guide suppression. */
function renderedRecordChars(
  knowledge: GuestDirectoryKnowledge[],
  places: GuestDirectoryPlace[],
): number {
  return buildVenueSystemPromptParts({
    venue: { name: '', description: null, category: null },
    relevantPlaces: places,
    knowledgeEntries: knowledge,
    userLat: null,
    userLng: null,
  }).recordContext.chars
}

// Formatting-only process constant, never a content/authority cache. Both exact measurements
// include nonnegative body text, so their maximum bounds each standalone shared wrapper.
let standaloneRecordOverhead: number | undefined
function getStandaloneRecordOverhead(): number {
  if (standaloneRecordOverhead === undefined)
    standaloneRecordOverhead = Math.max(
      renderedRecordChars(
        [
          {
            id: '',
            title: '',
            category: 'GENERAL',
            content: '',
            sourceType: 'MANUAL',
            sourceName: null,
            sourceUrl: null,
          },
        ],
        [],
      ),
      renderedRecordChars(
        [],
        [
          {
            id: '',
            name: '',
            type: 'ATTRACTION',
            itemType: null,
            shortDescription: null,
            longDescription: null,
            lat: null,
            lng: null,
            tags: [],
            areaName: null,
            hours: null,
            photoUrl: null,
            sourceType: 'MANUAL',
            sourceName: null,
            sourceUrl: null,
          },
        ],
      ),
    )
  return standaloneRecordOverhead
}

/** Authorized projected index only; caller owns tenant/venue/authority and current version. */
export function guestFacetIndex(
  directory: GuestVenueDirectory,
  currentDate: string,
): FacetRecord[] {
  const knowledge = directory.knowledge.filter((row) => !isPastDatedGuestEvent(row, currentDate))
  const membership = JSON.stringify([
    knowledge.map((row) => row.id),
    directory.places.map((row) => row.id),
    currentDate,
  ])
  const key = directory.searchVersion ? `${directory.searchVersion}:${membership}` : null
  const hit = key ? indexes.get(key) : undefined
  if (hit && key) {
    indexes.delete(key)
    indexes.set(key, hit)
    return hit.rows
  }
  const rows: FacetRecord[] = [
    ...knowledge.map((row) => {
      // Include title/category as whole source context: unsupported prose cannot grant hard proof.
      const facets = extractRecordFacetHints(`${row.title}\n${row.category}\n${row.content}`)
      return {
        key: `knowledge:${row.id}`,
        facets: facets.hard,
        softFacets: facets.soft,
        chars: renderedRecordChars([row], []),
      }
    }),
    ...directory.places.map((row) => {
      const facets = extractRecordFacetHints(
        [
          row.name,
          row.type,
          row.itemType,
          row.shortDescription,
          row.longDescription,
          row.areaName,
          row.hours,
          ...(row.tags ?? []),
        ]
          .filter(Boolean)
          .join('\n'),
      )
      // Source type is useful SOFT kind metadata, never proof of eligibility or complete grammar.
      const sourceKind = [row.itemType, row.type]
        .map((value) => value?.toLowerCase())
        .find(
          (value) =>
            value === 'ride' || value === 'exhibit' || value === 'food' || value === 'show',
        ) as 'ride' | 'exhibit' | 'food' | 'show' | undefined
      if (!facets.soft.kind && sourceKind) facets.soft.kind = sourceKind
      return {
        key: `place:${row.id}`,
        facets: facets.hard,
        softFacets: facets.soft,
        chars: renderedRecordChars([], [row]),
      }
    }),
  ]
  const bytes = JSON.stringify(rows).length * 2 + (key?.length ?? 0) * 2
  if (key && !directory.incomplete && bytes <= MAX_VENUE_BYTES) {
    indexes.set(key, { rows, bytes })
    indexBytes += bytes
    while (indexBytes > MAX_BYTES || indexes.size > MAX_ENTRIES) {
      const oldest = indexes.keys().next().value!
      indexBytes -= indexes.get(oldest)!.bytes
      indexes.delete(oldest)
    }
  }
  return rows
}

export function selectGuestFacetCollection(params: {
  directory: GuestVenueDirectory
  currentDate: string
  constraints: FacetConstraints
  governingKeys: string[]
  maxChars: number
}): {
  selection: FacetSelection
  index: FacetRecord[]
  knowledge: GuestDirectoryKnowledge[]
  places: GuestDirectoryPlace[]
} {
  const index = guestFacetIndex(params.directory, params.currentDate)
  const all = selectFacetRecords({
    records: index,
    constraints: params.constraints,
    governingKeys: params.governingKeys,
    maxChars: Number.MAX_SAFE_INTEGER,
  })
  const allKeys = new Set(all.requiredKeys)
  // A proven lower bound can reject an oversized union without constructing/rendering it.
  // Failure to prove overflow is never proof of fit: retain the existing exact renderer.
  const cannotFit = facetUnionCannotFit(
    index,
    allKeys,
    params.maxChars,
    getStandaloneRecordOverhead(),
  )
  const finiteUnionFits =
    !cannotFit &&
    renderedRecordChars(
      params.directory.knowledge.filter((row) => allKeys.has(`knowledge:${row.id}`)),
      params.directory.places.filter((row) => allKeys.has(`place:${row.id}`)),
    ) <= params.maxChars &&
    all.selectionComplete
  const selection = finiteUnionFits
    ? all
    : selectFacetRecords({
        records: index,
        constraints: params.constraints,
        governingKeys: params.governingKeys,
        maxChars: params.maxChars,
      })
  const knowledgeById = new Map(
    params.directory.knowledge.map((row) => [`knowledge:${row.id}`, row]),
  )
  const placesById = new Map(params.directory.places.map((row) => [`place:${row.id}`, row]))
  return {
    selection,
    index,
    knowledge: selection.selectedKeys.flatMap((key) =>
      knowledgeById.has(key) ? [knowledgeById.get(key)!] : [],
    ),
    places: selection.selectedKeys.flatMap((key) =>
      placesById.has(key) ? [placesById.get(key)!] : [],
    ),
  }
}

/** Final current-body admission; supports non-facet DIRECTORY paths too. No stale predecessor fallback. */
export function admitGuestDynamicRecords<
  K extends { id: string },
  P extends { id: string },
>(params: {
  knowledge: K[]
  places: P[]
  priorityKeys: readonly string[]
  maxChars: number
  measure: (knowledge: K[], places: P[]) => { chars: number; fullBodyKeys: string[] }
}): { knowledge: K[]; places: P[]; excludedKeys: string[]; fullBodyKeys: string[]; chars: number } {
  const knowledgeById = new Map(params.knowledge.map((row) => [`knowledge:${row.id}`, row]))
  const placeById = new Map(params.places.map((row) => [`place:${row.id}`, row]))
  const order = [...new Set([...params.priorityKeys, ...knowledgeById.keys(), ...placeById.keys()])]
  const knowledge: K[] = []
  const places: P[] = []
  const excludedKeys: string[] = []
  for (const key of order) {
    const k = knowledgeById.get(key)
    const p = placeById.get(key)
    if (!k && !p) {
      excludedKeys.push(key)
      continue
    }
    const nextKnowledge = k ? [...knowledge, k] : knowledge
    const nextPlaces = p ? [...places, p] : places
    if (params.measure(nextKnowledge, nextPlaces).chars > params.maxChars) excludedKeys.push(key)
    else if (k) knowledge.push(k)
    else if (p) places.push(p)
  }
  const rendered = params.measure(knowledge, places)
  return { knowledge, places, excludedKeys, ...rendered }
}
