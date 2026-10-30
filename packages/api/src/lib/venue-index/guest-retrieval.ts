/**
 * Guest-turn retrieval over a VenueIndex. No model call: link what the guest names, follow the
 * index's relationships, build complete lists with counts, then add related policies and text
 * search hits for narrative questions.
 */
import { isStopword, phraseKey, singleDeletions, stemTokens } from './text'
import {
  AREA_PREFIX,
  PRODUCT_PREFIX,
  RECORD_PREFIX,
  SPECIES_PREFIX,
  type EntityKind,
  type VenueIndex,
} from './venue-index'

export type Mention = {
  text: string
  key: string
  start: number
  end: number
  entityIds: string[]
  fuzzy: boolean
  containment: boolean
}

const GENERIC_HEADS = new Set(
  'cup bowl slice set pack bag card box kit ticket pass plate combo meal drink food snack item water tea'.split(
    ' ',
  ),
)

/** Guest words for entity kinds (stemmed). A closed vocabulary: the kinds themselves are closed. */
const KIND_WORDS: Record<string, EntityKind[]> = {
  restroom: ['restroom'],
  bathroom: ['restroom'],
  toilet: ['restroom'],
  washroom: ['restroom'],
  ride: ['ride'],
  coaster: ['ride'],
  rollercoaster: ['ride'],
  attraction: ['ride', 'exhibit', 'show', 'activity'],
  food: ['food'],
  restaurant: ['food'],
  eat: ['food'],
  snack: ['food'],
  cafe: ['food'],
  truck: ['food'],
  vendor: ['food', 'shop'],
  shop: ['shop'],
  store: ['shop'],
  souvenir: ['shop'],
  gift: ['shop'],
  booth: ['shop', 'service'],
  exhibit: ['exhibit'],
  gallery: ['exhibit'],
  habitat: ['exhibit'],
  animal: ['exhibit', 'animal'],
  show: ['show', 'event'],
  event: ['event', 'show'],
  talk: ['event'],
  performance: ['event'],
  concert: ['event'],
  stage: ['stage'],
  rental: ['service'],
  activity: ['activity'],
  experience: ['activity'],
  encounter: ['activity'],
}

/** Category words (stemmed); an alias ending in one names a kind of thing, not one thing. */
export const GUEST_KIND_WORD_SET: ReadonlySet<string> = new Set([
  ...Object.keys(KIND_WORDS),
  'cafeteria',
  'diner',
  'bar',
  'kiosk',
  'cart',
  'counter',
  'grill',
  'kitchen',
  'ride',
  'slide',
  'flume',
  'carousel',
  'theater',
  'theatre',
  'zoo',
  'museum',
  'park',
  'thing',
  'place',
  'area',
])

const NEAR_CUES = new Set(['near', 'nearby', 'close', 'closest', 'nearest', 'around', 'here'])

const LIST_CUES = new Set([
  'which',
  'all',
  'every',
  'list',
  'any',
  'many',
  'what',
  'where',
  'options',
  'anything',
])

function tokenCandidates(
  index: VenueIndex,
  token: string,
): Array<{ token: string; fuzzy: boolean }> {
  const out = [{ token, fuzzy: false }]
  if (token.length < 5 || /\d/u.test(token)) return out
  const vocabulary = index.fuzzyVocabulary()
  const seen = new Set([token])
  for (const key of [token, ...singleDeletions(token)])
    for (const match of vocabulary.get(key) ?? [])
      if (!seen.has(match)) {
        seen.add(match)
        out.push({ token: match, fuzzy: true })
      }
  return out
}

function nameTokensFor(index: VenueIndex, prefix: string): Array<{ id: string; tokens: string[] }> {
  const registry = prefix === PRODUCT_PREFIX ? index.products : index.species
  return [...registry.keys()].map((key) => ({ id: prefix + key, tokens: key.split(' ') }))
}

function containsRun(haystack: string[], needle: string[]): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1)
      if (haystack[start + offset] !== needle[offset]) continue outer
    return true
  }
  return false
}

/** Find every venue name, alias, product or species the text mentions. Longest match wins. */
export function linkText(index: VenueIndex, text: string): Mention[] {
  const tokens = stemTokens(text)
  const candidates = tokens.map((token) => tokenCandidates(index, token))
  const byFirst = index.aliasesByFirstToken()
  const found: Mention[] = []
  for (let start = 0; start < tokens.length; start += 1) {
    for (const first of candidates[start] ?? []) {
      for (const key of byFirst.get(first.token) ?? []) {
        const parts = key.split(' ')
        let fuzzy = first.fuzzy
        let ok = start + parts.length <= tokens.length
        for (let offset = 1; ok && offset < parts.length; offset += 1) {
          const hit = (candidates[start + offset] ?? []).find(
            (candidate) => candidate.token === parts[offset],
          )
          if (!hit) ok = false
          else fuzzy ||= hit.fuzzy
        }
        if (!ok) continue
        if (parts.every((part) => isStopword(part))) continue
        const entityIds = index.resolveKey(key)
        if (!entityIds.length) continue
        found.push({
          text: tokens.slice(start, start + parts.length).join(' '),
          key,
          start,
          end: start + parts.length,
          entityIds,
          fuzzy,
          containment: false,
        })
      }
    }
  }
  // Products and species also match a run of their own words ("pretzel" -> "soft pretzel",
  // "dippin dots" -> "dippin dots souvenir cup"); product variants join the exact product.
  const named = [...nameTokensFor(index, PRODUCT_PREFIX), ...nameTokensFor(index, SPECIES_PREFIX)]
  for (let start = 0; start < tokens.length; start += 1) {
    for (let length = 1; length <= 4 && start + length <= tokens.length; length += 1) {
      const run = tokens.slice(start, start + length)
      if (run.every((token) => isStopword(token))) continue
      if (
        length === 1 &&
        ((run[0] ?? '').length < 4 || GENERIC_HEADS.has(run[0] ?? '') || isStopword(run[0] ?? ''))
      )
        continue
      const ids = named
        .filter((entry) =>
          length === 1
            ? entry.tokens[entry.tokens.length - 1] === run[0] && entry.tokens.length > 1
            : containsRun(entry.tokens, run) && entry.tokens.length > length,
        )
        .map((entry) => entry.id)
      if (ids.length)
        found.push({
          text: run.join(' '),
          key: run.join(' '),
          start,
          end: start + length,
          entityIds: ids,
          fuzzy: false,
          containment: true,
        })
    }
  }
  found.sort(
    (a, b) =>
      b.end - b.start - (a.end - a.start) ||
      Number(a.fuzzy) - Number(b.fuzzy) ||
      Number(a.containment) - Number(b.containment),
  )
  const kept: Mention[] = []
  for (const mention of found) {
    const overlap = kept.find((other) => mention.start < other.end && other.start < mention.end)
    if (!overlap) {
      kept.push({ ...mention })
      continue
    }
    // Same span: merge product/species variants into the exact mention.
    if (overlap.start === mention.start && overlap.end === mention.end && mention.containment)
      overlap.entityIds = [...new Set([...overlap.entityIds, ...mention.entityIds])].sort()
  }
  return kept.sort((a, b) => a.start - b.start)
}

export type RetrievalList = {
  title: string
  kinds: EntityKind[]
  filters: string[]
  total: number
  recordIds: string[]
}

export type SellerGroup = {
  productNames: string[]
  sellerRecordIds: string[]
  enrichedSellerRecordIds: string[]
  mentioningRecordIds: string[]
}

export type GuestRetrieval = {
  mentions: Mention[]
  carriedMentions: Mention[]
  focusRecordIds: string[]
  sellers: SellerGroup[]
  lists: RetrievalList[]
  relatedRecordIds: string[]
  proposalRecordIds: string[]
  searchRecordIds: string[]
  coreRecordIds: string[]
  kindWords: EntityKind[]
  listIntent: boolean
  ambiguous: Array<{ text: string; names: string[] }>
}

export type RetrievalLimits = {
  listRows: number
  sellerRows: number
  related: number
  search: number
  focus: number
}

export const DEFAULT_LIMITS: RetrievalLimits = {
  listRows: 100,
  sellerRows: 100,
  related: 8,
  search: 6,
  focus: 10,
}

function kindWordsIn(tokens: string[]): EntityKind[] {
  const kinds = new Set<EntityKind>()
  for (const token of tokens) for (const kind of KIND_WORDS[token] ?? []) kinds.add(kind)
  return [...kinds]
}

function valueFilters(
  index: VenueIndex,
  tokens: string[],
): Array<{ key: string; recordIds: Set<string> }> {
  const out: Array<{ key: string; recordIds: Set<string> }> = []
  const used = new Set<number>()
  for (let length = 4; length >= 1; length -= 1)
    for (let start = 0; start + length <= tokens.length; start += 1) {
      if ([...Array(length).keys()].some((offset) => used.has(start + offset))) continue
      const key = tokens.slice(start, start + length).join(' ')
      if (length === 1 && ((tokens[start] ?? '').length < 5 || isStopword(tokens[start] ?? '')))
        continue
      const recordIds = index.byValue.get(key)
      if (!recordIds) continue
      out.push({ key, recordIds })
      for (let offset = 0; offset < length; offset += 1) used.add(start + offset)
    }
  return out
}

function orderedRecords(index: VenueIndex, ids: Iterable<string>): string[] {
  return [...ids]
    .filter((id) => index.contributions.has(id))
    .sort((a, b) => {
      const ca = index.contributions.get(a)!
      const cb = index.contributions.get(b)!
      return (
        (ca.areaDisplay ?? '').localeCompare(cb.areaDisplay ?? '') ||
        ca.name.localeCompare(cb.name) ||
        a.localeCompare(b)
      )
    })
}

function membersOfCollection(index: VenueIndex, recordId: string): string[] {
  const record = index.records.get(recordId)
  if (!record) return []
  const members: string[] = []
  for (const mention of linkText(index, record.body))
    for (const id of mention.entityIds)
      if (id.startsWith(RECORD_PREFIX) && id !== RECORD_PREFIX + recordId)
        members.push(id.slice(RECORD_PREFIX.length))
  return [...new Set(members)]
}

export function retrieveForGuest(
  index: VenueIndex,
  params: { question: string; history?: string[]; limits?: Partial<RetrievalLimits> },
): GuestRetrieval {
  const limits = { ...DEFAULT_LIMITS, ...params.limits }
  const tokens = stemTokens(params.question)
  const mentions = linkText(index, params.question)
  const kindWords = kindWordsIn(tokens)
  const listIntent = kindWords.length > 0 && tokens.some((token) => LIST_CUES.has(token))
  const filters = valueFilters(index, tokens)
  // Follow-ups ("is it open today?") inherit what the previous turns named.
  const carriedMentions =
    mentions.some((mention) => !mention.entityIds.every((id) => id.startsWith(AREA_PREFIX))) ||
    !params.history?.length
      ? []
      : params.history
          .slice(-3)
          .reverse()
          .flatMap((text) => linkText(index, text))
          .slice(0, 6)
  const focus: string[] = []
  const addFocus = (recordId: string) => {
    if (index.contributions.has(recordId) && !focus.includes(recordId)) focus.push(recordId)
  }
  const sellers: SellerGroup[] = []
  const lists: RetrievalList[] = []
  const ambiguous: Array<{ text: string; names: string[] }> = []
  const areaKeys: string[] = []
  for (const mention of [...mentions, ...carriedMentions]) {
    const recordIds = mention.entityIds.filter((id) => id.startsWith(RECORD_PREFIX))
    if (recordIds.length > 1 && !mention.containment)
      ambiguous.push({
        text: mention.text,
        names: recordIds.map((id) => index.entity(id)?.name ?? id),
      })
    const products = mention.entityIds.filter((id) => id.startsWith(PRODUCT_PREFIX))
    if (products.length) {
      // Variants of a named product ("Dippin' Dots souvenir cup") are sold under the same name.
      const named = products.map((id) => id.slice(PRODUCT_PREFIX.length).split(' '))
      const keys = [...index.products.keys()].filter((key) =>
        named.some((run) => containsRun(key.split(' '), run)),
      )
      const sellerIds = new Set<string>()
      const enriched = new Set<string>()
      for (const key of keys) {
        for (const id of index.sellersByProduct.get(key) ?? []) sellerIds.add(id)
        for (const id of index.enrichmentSellers.get(key) ?? []) enriched.add(id)
      }
      const mentioning = new Set<string>()
      for (const key of keys)
        for (const id of index.recordsMentioning(key, 20))
          if (!sellerIds.has(id)) mentioning.add(id)
      sellers.push({
        productNames: keys.map((key) => index.entity(PRODUCT_PREFIX + key)?.name ?? key),
        sellerRecordIds: orderedRecords(index, sellerIds),
        enrichedSellerRecordIds: orderedRecords(
          index,
          [...enriched].filter((id) => !sellerIds.has(id)),
        ),
        mentioningRecordIds: orderedRecords(index, mentioning).slice(0, 6),
      })
    }
    const species = mention.entityIds.filter((entityId) => entityId.startsWith(SPECIES_PREFIX))
    if (species.length) {
      const homes = orderedRecords(
        index,
        species.flatMap((id) => [...(index.bySpecies.get(id.slice(SPECIES_PREFIX.length)) ?? [])]),
      )
      lists.push({
        title: `Records listing ${species.map((id) => index.entity(id)?.name ?? id).join(' / ')} among their animals`,
        kinds: [],
        filters: [],
        total: homes.length,
        recordIds: homes.slice(0, limits.listRows),
      })
      for (const recordId of homes.slice(0, 3)) addFocus(recordId)
    }
    for (const id of mention.entityIds.filter((entityId) => entityId.startsWith(AREA_PREFIX)))
      areaKeys.push(id.slice(AREA_PREFIX.length))
    for (const id of recordIds) {
      const recordId = id.slice(RECORD_PREFIX.length)
      addFocus(recordId)
      const c = index.contributions.get(recordId)
      if (!c) continue
      for (const key of c.livesInKeys)
        for (const target of index.resolveKey(key))
          if (target.startsWith(RECORD_PREFIX)) addFocus(target.slice(RECORD_PREFIX.length))
      if (c.kind === 'collection') {
        const members = membersOfCollection(index, recordId)
        lists.push({
          title: `Named in ${c.name}`,
          kinds: [],
          filters: [],
          total: members.length,
          recordIds: members,
        })
      }
    }
  }
  // Lists: kind words, value filters and areas combine into one complete, counted list.
  if (listIntent || filters.length || (areaKeys.length && kindWords.length)) {
    let pool: Set<string> | null = null
    const intersect = (ids: Iterable<string>) => {
      const next = new Set(ids)
      pool = pool === null ? next : new Set([...(pool as Set<string>)].filter((id) => next.has(id)))
    }
    if (kindWords.length)
      intersect(
        kindWords.flatMap((kind) =>
          [...(index.byKind.get(kind) ?? [])].map((id) => id.slice(RECORD_PREFIX.length)),
        ),
      )
    for (const filter of filters) intersect(filter.recordIds)
    if (areaKeys.length)
      intersect(
        areaKeys.flatMap((key) =>
          [...(index.byArea.get(key) ?? [])].map((id) => id.slice(RECORD_PREFIX.length)),
        ),
      )
    const final: Set<string> = pool ?? new Set<string>()
    if (pool !== null && (kindWords.length || filters.length) && (listIntent || final.size > 0)) {
      const ordered = orderedRecords(index, final)
      lists.push({
        title: 'Matching records',
        kinds: kindWords,
        filters: [
          ...filters.map((filter) => filter.key),
          ...areaKeys.map((key) => `area: ${index.entity(AREA_PREFIX + key)?.name ?? key}`),
        ],
        total: ordered.length,
        recordIds: ordered.slice(0, limits.listRows),
      })
    }
  } else if (areaKeys.length) {
    for (const key of areaKeys) {
      const ordered = orderedRecords(
        index,
        [...(index.byArea.get(key) ?? [])].map((id) => id.slice(RECORD_PREFIX.length)),
      )
      lists.push({
        title: `In ${index.entity(AREA_PREFIX + key)?.name ?? key}`,
        kinds: [],
        filters: [],
        total: ordered.length,
        recordIds: ordered.slice(0, limits.listRows),
      })
    }
  }
  // "Is there food nearby?" after naming a place: the same kind of thing in that place's area.
  const nearCue = tokens.some((token) => NEAR_CUES.has(token))
  if (
    kindWords.length &&
    !areaKeys.length &&
    (nearCue || carriedMentions.length) &&
    !lists.some((list) => list.kinds.length)
  ) {
    for (const recordId of focus.slice(0, 2)) {
      const c = index.contributions.get(recordId)
      if (!c?.areaKey) continue
      const ids = kindWords
        .flatMap((kind) => [...(index.byKind.get(kind) ?? [])])
        .map((id) => id.slice(RECORD_PREFIX.length))
      const same = orderedRecords(
        index,
        ids.filter((id) => index.contributions.get(id)?.areaKey === c.areaKey && id !== recordId),
      )
      lists.push({
        title: `${kindWords.join('/')} in ${c.areaDisplay} (same area as ${c.name})`,
        kinds: kindWords,
        filters: [`area: ${c.areaDisplay}`],
        total: same.length,
        recordIds: same.slice(0, limits.listRows),
      })
      break
    }
  }
  const focusRecordIds = focus.slice(0, limits.focus)
  // Related policies and topics: explicit "Applies to" first, then knowledge records naming the focus.
  const related: string[] = []
  const query = [
    params.question,
    ...(carriedMentions.length ? (params.history ?? []).slice(-1) : []),
  ].join(' ')
  const scores = new Map(
    index.search(query, { limit: 400 }).map((hit) => [hit.recordId, hit.score]),
  )
  const relatedCandidates: Array<{ id: string; rank: number }> = []
  for (const recordId of [
    ...focusRecordIds,
    ...sellers.flatMap((group) => group.sellerRecordIds.slice(0, 3)),
  ]) {
    const c = index.contributions.get(recordId)
    if (!c) continue
    for (const key of c.aliasKeys) {
      for (const id of index.appliesTo.get(key) ?? []) relatedCandidates.push({ id, rank: 0 })
      for (const id of index.recordsMentioning(key, 30))
        if (index.records.get(id)?.source === 'knowledge')
          relatedCandidates.push({ id, rank: 1 - (scores.get(id) ?? 0) / 100 })
    }
    if (c.areaKey)
      for (const id of index.recordsMentioning(c.areaKey, 30))
        if (index.contributions.get(id)?.kind === 'topic')
          relatedCandidates.push({ id, rank: 2 - (scores.get(id) ?? 0) / 100 })
  }
  relatedCandidates.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
  for (const candidate of relatedCandidates) {
    if (related.length >= limits.related) break
    if (!focusRecordIds.includes(candidate.id) && !related.includes(candidate.id))
      related.push(candidate.id)
  }
  const shown = new Set([
    ...focusRecordIds,
    ...related,
    ...lists.flatMap((list) => list.recordIds),
    ...sellers.flatMap((group) => [...group.sellerRecordIds, ...group.mentioningRecordIds]),
  ])
  const searchLimit =
    focusRecordIds.length || sellers.length || lists.length
      ? Math.min(3, limits.search)
      : limits.search
  const searchRecordIds = index
    .search(query, { limit: searchLimit + shown.size })
    .map((hit) => hit.recordId)
    .filter((id) => !shown.has(id))
    .slice(0, searchLimit)
  const coreRecordIds = orderedRecords(
    index,
    [...index.contributions.values()]
      .filter(
        (c) =>
          c.kind !== 'event' &&
          /\b(admission|hours|tickets?)\b/iu.test(c.name) &&
          index.records.get(c.recordId)?.source === 'knowledge',
      )
      .map((c) => c.recordId),
  ).slice(0, 2)
  return {
    mentions,
    carriedMentions,
    focusRecordIds,
    sellers,
    lists,
    relatedRecordIds: related,
    proposalRecordIds: index.proposalRecordIds(query, limits.search),
    searchRecordIds,
    coreRecordIds,
    kindWords,
    listIntent,
    ambiguous,
  }
}

export { phraseKey }
