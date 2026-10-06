import type { SemanticKnowledgeEntry } from '@pathfinder/db'

const STRICT_LIMIT = 20
const BROAD_LIMIT = 60
// Specific questions need a handful of sources; broad questions (overview, inventory, counts,
// dining) need enough distinct records to synthesize several choices or a complete count.
const RESULT_LIMIT = 8
const BROAD_RESULT_LIMIT = 12
const SEMANTIC_LIMIT = 20
const PER_CONCEPT_LIMIT = 20
const MAX_RESULT_CONTENT_CHARS = 4_000
const MIN_RESULT_CONTENT_CHARS = 1_200
const TOTAL_RESULT_CONTENT_CHARS = 20_000
// Reciprocal-rank fusion constant. Semantic and lexical lanes contribute equally so a record
// without a stored embedding can still outrank weaker vector neighbours on a strong text match.
const FUSION_RANK_OFFSET = 10
// The previous production result was the top five vector neighbours. They are always kept, so
// the fused result is never a subset of what guests got before. Neighbours past this rank join
// only when a text match corroborates them, so a weak semantic tail cannot crowd out matches.
const SEMANTIC_UNCORROBORATED_LIMIT = 5

const STOP_WORDS = new Set([
  'a',
  'about',
  'al',
  'also',
  'and',
  'any',
  'anything',
  'are',
  'can',
  'could',
  'cuantas',
  'cuantos',
  'de',
  'do',
  'does',
  'el',
  'en',
  'esta',
  'está',
  'for',
  'give',
  'have',
  'here',
  'how',
  'i',
  'in',
  'is',
  'just',
  'know',
  'la',
  'las',
  'los',
  'many',
  'me',
  'of',
  'on',
  'people',
  'personas',
  'please',
  'pueden',
  'que',
  'should',
  'some',
  'tell',
  'that',
  'the',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'un',
  'una',
  'want',
  'what',
  'where',
  'which',
  'who',
  'with',
  'would',
  'you',
  'your',
])

const CONCEPTS: readonly (readonly string[])[] = [
  ['capacity', 'occupancy', 'occupants', 'visitors', 'guests', 'fit', 'hold', 'aforo', 'caben'],
  ['photo', 'photos', 'photography', 'camera', 'pictures', 'fotografia', 'fotografía', 'fotos'],
  [
    'hours',
    'opening',
    'closing',
    'open',
    'close',
    'horario',
    'abre',
    'cierra',
    '营业时间',
    '开放时间',
    '営業時間',
    '開館時間',
  ],
  ['bag', 'bags', 'backpack', 'luggage', 'bolsa', 'mochila', 'equipaje'],
  ['gallery', 'galeria', 'galería', 'galerie'],
  ['north', 'norte', 'nord'],
  ['arrival', 'arrive', 'entrance', 'entry', 'llegada', 'llegar', 'entrada', 'acceso'],
  [
    'eat',
    'eating',
    'food',
    'dining',
    'dine',
    'restaurant',
    'restaurants',
    'meal',
    'meals',
    'snack',
    'snacks',
    'lunch',
    'dinner',
    'breakfast',
    'hungry',
    'menu',
    'cafe',
    'comida',
    'comer',
    'restaurante',
    'bite',
    'bites',
  ],
  ['coaster', 'coasters', 'rollercoaster', 'rollercoasters'],
  [
    'restroom',
    'restrooms',
    'bathroom',
    'bathrooms',
    'toilet',
    'toilets',
    'wc',
    '厕所',
    '洗手间',
    'トイレ',
    'お手洗い',
  ],
] as const

export type GuestKnowledgeReader = {
  venueKnowledgeEntry: {
    findMany(args: Record<string, unknown>): Promise<GuestKnowledgeRow[]>
  }
  legacyKnowledgeAdoptionActivation?: {
    findMany(
      args: Record<string, unknown>,
    ): Promise<Array<{ adoption: { legacyKnowledgeEntryId: string } }>>
  }
}

export type GuestKnowledgeRow = {
  id: string
  title: string
  category: string
  content: string
  sourceType: string
  sourceName: string | null
  sourceUrl: string | null
  updatedAt: Date
  lastReviewedAt: Date | null
  contentModuleId?: string | null
  contentRevisionId?: string | null
  contentPublicationId?: string | null
  contentRevision?: {
    createdBy?: string
    effectiveFrom: Date | null
    effectiveUntil: Date | null
    operationalFact: { expiresAt: Date | null } | null
  } | null
  contentPublication?: {
    eventOrder: bigint
    module: { publications: Array<{ id: string; eventOrder: bigint }> }
  } | null
}

export type GuestKnowledgeRetrievalTrace = {
  path: 'semantic+lexical' | 'lexical-fallback'
  retrievedSourceIds: string[]
  retrievedSources: { id: string; version: string | null }[]
  excludedSourceIds: string[]
  candidateCounts: { strict: number; broad: number; semantic: number }
  limits: { strict: number; broad: number; result: number }
  partialCoverage: boolean
  truncatedSourceIds: string[]
  publicationAuthority: Array<{
    id: string
    moduleId: string
    revisionId: string
    publicationId: string
    effectiveFrom: string | null
    effectiveUntil: string | null
  }>
  retrievalMs: number
}

export function normalizeGuestText(value: string): string {
  return normalize(value)
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
}

const CJK_SCRIPT = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u

// Questions about the place as a whole. Their content words ("place", "park") match nearly
// every record, so they retrieve overview-style records instead.
const OVERVIEW_QUERY =
  /\b(overview|rundown|explain (this|the) (place|park|venue)|(about|describe) (this|the) (place|park|venue|museum|zoo)|what('?s| is) (this|here)( place| park)?\??$|what is (this|the) (place|park)|what (can|is there to) (i|we) do( here)?)\b/u
const OVERVIEW_CONCEPT = ['overview', 'about', 'welcome', 'introduction', 'general information']
const OVERVIEW_GENERIC_TOKENS = new Set([
  'place',
  'park',
  'venue',
  'museum',
  'zoo',
  'garden',
  'explain',
  'describe',
  'here',
  'rundown',
  'overview',
  'whats',
])
const OVERVIEW_SUBJECT = /\b(place|park|venue|museum|zoo|garden|here|rundown|overview)\b/u

// Inventory, count, comparison and open-ended recommendation questions need several distinct
// records; a nearest-neighbour sample of five cannot support a count or a set of choices.
const BROAD_QUERY =
  /\b(how many|number of|list|all (the|of)|every|which|what (are|kinds?|types?|options)|options|recommend|suggest|best|anywhere|places to|where (can|should|do|to) (i|we) )\b/u

// A short referential follow-up ("which one is scariest?") says nothing retrievable on its own.
const FOLLOWUP_QUERY =
  /\b(it|its|that|those|them|they|one|ones|what about|how about|and the|same)\b/u

export function guestQueryIsOverview(query: string): boolean {
  const normalized = normalize(query).trim()
  if (OVERVIEW_QUERY.test(normalized)) return true
  // "what's this park about?": only the place itself remains once filler words are removed.
  const remaining = (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => token.length > 1 && !STOP_WORDS.has(token) && !OVERVIEW_GENERIC_TOKENS.has(token),
  )
  return remaining.length === 0 && OVERVIEW_SUBJECT.test(normalized)
}

export function guestQueryIsBroad(query: string): boolean {
  const normalized = normalize(query)
  if (guestQueryIsOverview(normalized) || BROAD_QUERY.test(normalized)) return true
  // Open-ended dining questions ("where to eat", "I'm hungry") are choice questions.
  const dining = CONCEPTS.find((group) => group.includes('restaurant'))!
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
  const contentTokens = tokens.filter((token) => token.length > 2 && !STOP_WORDS.has(token))
  return contentTokens.length <= 2 && tokens.some((token) => dining.includes(token))
}

export function guestQueryIsFollowup(query: string): boolean {
  const tokens = normalize(query).match(/[\p{L}\p{N}]+/gu) ?? []
  return tokens.length > 0 && tokens.length <= 8 && FOLLOWUP_QUERY.test(normalize(query))
}

/** Matches a term at the start of a word, so "eat" matches "eatery" but not "great". */
export function containsGuestTerm(text: string, term: string): boolean {
  if (CJK_SCRIPT.test(term)) return text.includes(term)
  let index = text.indexOf(term)
  while (index >= 0) {
    const previous = index > 0 ? text[index - 1]! : ''
    if (!previous || !/[\p{L}\p{N}]/u.test(previous)) return true
    index = text.indexOf(term, index + 1)
  }
  return false
}

function stemVariants(token: string): string[] {
  if (token.length > 4 && token.endsWith('ies')) return [token, `${token.slice(0, -3)}y`]
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss'))
    return [token, token.slice(0, -1)]
  return [token]
}

export function guestQueryConcepts(query: string): string[][] {
  const overview = guestQueryIsOverview(query)
  const tokens = [...new Set(normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((token) => !(overview && OVERVIEW_GENERIC_TOKENS.has(token)))
    .map((token) => ({
      token,
      concepts: CONCEPTS.filter((items) =>
        items.some((item) => {
          const term = normalize(item)
          return term === token || (CJK_SCRIPT.test(term) && token.includes(term))
        }),
      ),
    }))
    .filter(({ token, concepts }) =>
      concepts.length > 0 ? true : token.length > 2 && !STOP_WORDS.has(token),
    )
    .slice(0, 8)
  const groups: string[][] = overview ? [OVERVIEW_CONCEPT.map(normalize)] : []
  for (const { token, concepts } of tokens) {
    const tokenGroups =
      concepts.length > 0
        ? concepts.map((concept) => concept.map(normalize))
        : [stemVariants(token)]
    for (const group of tokenGroups) {
      if (!groups.some((existing) => existing.join('|') === group.join('|'))) groups.push(group)
    }
  }
  return groups.slice(0, 5)
}

/**
 * Lexical concept groups for this turn. A short referential follow-up borrows the previous
 * visitor message's concepts so "which one is scariest?" keeps the earlier topic.
 */
export function guestRetrievalConcepts(
  query: string,
  previousQuery?: string | null,
): { ownConcepts: string[][]; concepts: string[][]; broad: boolean } {
  const ownConcepts = guestQueryConcepts(query)
  const followupConcepts =
    previousQuery && guestQueryIsFollowup(query)
      ? guestQueryConcepts(previousQuery).filter(
          (group) => !ownConcepts.some((existing) => existing.join('|') === group.join('|')),
        )
      : []
  return {
    ownConcepts,
    concepts: [...ownConcepts, ...followupConcepts].slice(0, 6),
    broad:
      guestQueryIsBroad(query) ||
      (followupConcepts.length > 0 && Boolean(previousQuery) && guestQueryIsBroad(previousQuery!)),
  }
}

function conceptFieldMatches(row: GuestKnowledgeRow, concept: string[]) {
  return {
    title: concept.some((term) => containsGuestTerm(normalize(row.title), term)),
    category: concept.some((term) => containsGuestTerm(normalize(row.category), term)),
    content: concept.some((term) => containsGuestTerm(normalize(row.content), term)),
  }
}

/**
 * Rarer concepts carry more weight, so "which coasters are open" ranks the few coaster records
 * above the many records that merely mention opening hours.
 */
function conceptWeights(rows: GuestKnowledgeRow[], concepts: string[][]): number[] {
  if (concepts.length < 2 || rows.length === 0) return concepts.map(() => 1)
  return concepts.map((concept) => {
    const matching = rows.filter((row) => {
      const match = conceptFieldMatches(row, concept)
      return match.title || match.category || match.content
    }).length
    return matching === 0 ? 1 : Math.min(4, 1 + Math.log2(rows.length / matching))
  })
}

function lexicalScore(
  row: GuestKnowledgeRow,
  concepts: string[][],
  weights: number[] = concepts.map(() => 1),
): number {
  let score = 0
  concepts.forEach((concept, index) => {
    const match = conceptFieldMatches(row, concept)
    const weight = weights[index] ?? 1
    if (match.title) score += 8 * weight
    if (match.category) score += 5 * weight
    if (match.content) score += 2 * weight
  })
  if (score === 0) return 0
  const reviewed = row.lastReviewedAt?.getTime() ?? 0
  return score + Math.min(1, reviewed / 10 ** 15)
}

function normalizedWithOriginalOffsets(value: string) {
  let text = ''
  const offsets: number[] = []
  let originalOffset = 0
  for (const character of value) {
    const normalizedCharacter = normalize(character)
    text += normalizedCharacter
    for (let index = 0; index < normalizedCharacter.length; index += 1) {
      offsets.push(originalOffset)
    }
    originalOffset += character.length
  }
  offsets.push(value.length)
  return { text, offsets }
}

function boundedRelevantContent(
  content: string,
  concepts: string[][],
  maxChars = MAX_RESULT_CONTENT_CHARS,
): string {
  const MAX_RESULT_CONTENT_CHARS = maxChars
  if (content.length <= MAX_RESULT_CONTENT_CHARS) return content
  const normalizedContent = normalizedWithOriginalOffsets(content)
  const matches = concepts
    .flat()
    .map((term) => {
      const index = normalizedContent.text.indexOf(term)
      if (index < 0) return null
      let occurrences = 0
      let cursor = index
      while (cursor >= 0) {
        occurrences += 1
        cursor = normalizedContent.text.indexOf(term, cursor + term.length)
      }
      return { index: normalizedContent.offsets[index]!, occurrences, termLength: term.length }
    })
    .filter((match): match is { index: number; occurrences: number; termLength: number } =>
      Boolean(match),
    )
  if (matches.length === 0) {
    const marker = '\n...[source excerpt]...\n'
    const available = MAX_RESULT_CONTENT_CHARS - marker.length
    const head = Math.ceil(available / 2)
    return `${content.slice(0, head)}${marker}${content.slice(-(available - head))}`
  }
  const center = [...matches].sort(
    (a, b) => a.occurrences - b.occurrences || b.termLength - a.termLength || a.index - b.index,
  )[0]!.index
  const leadingMarker = '...[source excerpt]...\n'
  const trailingMarker = '\n...[source excerpt]...'
  const hasLeadingMarker = center > Math.floor(MAX_RESULT_CONTENT_CHARS / 3)
  const start = hasLeadingMarker ? center - Math.floor(MAX_RESULT_CONTENT_CHARS / 3) : 0
  const prefix = start > 0 ? leadingMarker : ''
  const availableAfterPrefix = MAX_RESULT_CONTENT_CHARS - prefix.length
  const provisionalEnd = Math.min(content.length, start + availableAfterPrefix)
  const suffix = provisionalEnd < content.length ? trailingMarker : ''
  const end = Math.min(content.length, start + availableAfterPrefix - suffix.length)
  return `${prefix}${content.slice(start, end)}${suffix}`
}

export function guestKnowledgeSelectShape() {
  return {
    id: true,
    title: true,
    category: true,
    content: true,
    sourceType: true,
    sourceName: true,
    sourceUrl: true,
    updatedAt: true,
    lastReviewedAt: true,
    contentModuleId: true,
    contentRevisionId: true,
    contentPublicationId: true,
    contentRevision: {
      select: {
        createdBy: true,
        effectiveFrom: true,
        effectiveUntil: true,
        operationalFact: { select: { expiresAt: true } },
      },
    },
    contentPublication: {
      select: {
        eventOrder: true,
        module: {
          select: {
            publications: {
              select: { id: true, eventOrder: true },
              orderBy: { eventOrder: 'desc' },
              take: 1,
            },
          },
        },
      },
    },
  }
}

function textClause(term: string) {
  return {
    OR: [
      { title: { contains: term, mode: 'insensitive' } },
      { category: { contains: term, mode: 'insensitive' } },
      { content: { contains: term, mode: 'insensitive' } },
    ],
  }
}

/** The guest-visible Knowledge scope: tenant, venue, visibility, publication and source fences. */
export function guestKnowledgeScope(scopeParams: {
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  asOf: Date
}) {
  const publicationAuthority = {
    OR: [
      { contentModuleId: null },
      {
        contentPublication: { action: 'PUBLISH' },
        contentRevision: {
          audience: 'PUBLIC',
          AND: [
            { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: scopeParams.asOf } }] },
            { OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: scopeParams.asOf } }] },
            {
              OR: [
                { kind: { not: 'OPERATIONAL_FACT' } },
                { operationalFact: { expiresAt: null } },
                { operationalFact: { expiresAt: { gt: scopeParams.asOf } } },
              ],
            },
          ],
        },
      },
    ],
  }
  const adoptionAuthority = {
    OR: [
      { contentModuleId: { not: null } },
      { universalContentAdoption: { is: null } },
      { universalContentAdoption: { is: { activation: { is: null } } } },
    ],
  }
  return {
    tenantId: scopeParams.tenantId,
    venueId: scopeParams.venueId,
    isEnabled: true,
    // Connected-source facts have an additional approval/freshness fence. The cached source
    // reader owns that check; lexical or embedding hits must never bypass it.
    sourceType: { not: 'SOURCE_CONNECTION' },
    ...(scopeParams.includeSecondLayer ? {} : { visibility: 'PUBLIC' }),
    AND: [
      publicationAuthority,
      adoptionAuthority,
      {
        OR: [
          // The relation also uses required tenant/venue keys. Prisma's relation-null
          // predicate tests that composite key and excludes ordinary legacy rows.
          // Test the nullable revision key itself; connected revisions remain fenced.
          { contentRevisionId: null },
          { contentRevision: { is: { NOT: { createdBy: { startsWith: 'source-connection:' } } } } },
        ],
      },
    ],
  }
}

/** Rejects connected-source rows and module rows whose publication is no longer the latest. */
export function hasCurrentGuestPublicationAuthority(row: GuestKnowledgeRow): boolean {
  if (
    row.sourceType === 'SOURCE_CONNECTION' ||
    row.contentRevision?.createdBy?.startsWith('source-connection:')
  )
    return false
  if (!row.contentModuleId) return true
  const latest = row.contentPublication?.module.publications[0]
  return Boolean(
    latest &&
    latest.id === row.contentPublicationId &&
    latest.eventOrder === row.contentPublication?.eventOrder,
  )
}

export async function retrieveGuestKnowledge(params: {
  reader: unknown
  query: string
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  queryEmbedding: number[] | null
  /**
   * The visitor's previous message. Used only for lexical matching when the current message is a
   * short referential follow-up, so "which one is scariest?" keeps the earlier coaster topic.
   */
  previousQuery?: string | null
  /** Must apply this exact tenant, venue, and visibility scope before returning candidates. */
  semanticSearch?: (scope: {
    tenantId: string
    venueId: string
    includeSecondLayer: boolean
  }) => Promise<SemanticKnowledgeEntry[]>
  now?: () => number
  asOf?: Date
}): Promise<{ entries: SemanticKnowledgeEntry[]; trace: GuestKnowledgeRetrievalTrace }> {
  const reader = params.reader as GuestKnowledgeReader
  const started = (params.now ?? performance.now.bind(performance))()
  const {
    ownConcepts,
    concepts,
    broad: broadQuestion,
  } = guestRetrievalConcepts(params.query, params.previousQuery)
  const resultLimit = broadQuestion ? BROAD_RESULT_LIMIT : RESULT_LIMIT
  const asOf = params.asOf ?? new Date()
  const scope = guestKnowledgeScope({
    tenantId: params.tenantId,
    venueId: params.venueId,
    includeSecondLayer: params.includeSecondLayer,
    asOf,
  })
  const strictWhere = concepts.length
    ? {
        ...scope,
        AND: [
          ...scope.AND,
          ...(ownConcepts.length ? ownConcepts : concepts).map((group) => ({
            OR: group.map(textClause).flatMap((clause) => clause.OR),
          })),
        ],
      }
    : { ...scope, id: '__no_query_terms__' }
  const broadWhere = concepts.length
    ? {
        ...scope,
        OR: concepts.flatMap((group) => group.map(textClause).flatMap((clause) => clause.OR)),
      }
    : { ...scope, id: '__no_query_terms__' }
  const [strict, broadAll, semantic, activated] = await Promise.all([
    reader.venueKnowledgeEntry.findMany({
      where: strictWhere,
      select: guestKnowledgeSelectShape(),
      orderBy: [{ lastReviewedAt: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      take: STRICT_LIMIT,
    }),
    reader.venueKnowledgeEntry.findMany({
      where: broadWhere,
      select: guestKnowledgeSelectShape(),
      orderBy: [{ lastReviewedAt: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      take: BROAD_LIMIT,
    }),
    params.queryEmbedding && params.semanticSearch
      ? params
          .semanticSearch({
            tenantId: params.tenantId,
            venueId: params.venueId,
            includeSecondLayer: params.includeSecondLayer,
          })
          .catch(() => [])
      : Promise.resolve([]),
    reader.legacyKnowledgeAdoptionActivation
      ? reader.legacyKnowledgeAdoptionActivation.findMany({
          where: { tenantId: params.tenantId, venueId: params.venueId },
          select: { adoption: { select: { legacyKnowledgeEntryId: true } } },
        })
      : Promise.resolve([]),
  ])
  const activatedLegacyIds = new Set(activated.map((row) => row.adoption.legacyKnowledgeEntryId))
  // Revalidate bounded semantic identities after the parallel searches. This
  // also covers sources that disappeared from the public lexical scope and
  // corrections whose old content survives in an earlier semantic result.
  const semanticCandidates = semantic.slice(0, SEMANTIC_LIMIT)
  const semanticRows = semanticCandidates.length
    ? await reader.venueKnowledgeEntry.findMany({
        where: { ...scope, id: { in: semanticCandidates.map((entry) => entry.id) } },
        select: guestKnowledgeSelectShape(),
        take: SEMANTIC_LIMIT,
      })
    : []
  // When several concepts saturate the single recency-ordered OR query, the most common concept
  // can fill the bound. Each concept then gets its own bounded query so rarer concepts keep
  // candidates (for example coaster records in "which coasters are open").
  const perConcept =
    broadAll.length >= BROAD_LIMIT && concepts.length > 1
      ? await Promise.all(
          concepts.map((group) =>
            reader.venueKnowledgeEntry.findMany({
              where: { ...scope, OR: group.map(textClause).flatMap((clause) => clause.OR) },
              select: guestKnowledgeSelectShape(),
              orderBy: [{ lastReviewedAt: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
              take: PER_CONCEPT_LIMIT,
            }),
          ),
        )
      : []
  const broad = [...broadAll, ...perConcept.flatMap((rows) => rows ?? [])]
  const currentSemanticRows = new Map(semanticRows.map((row) => [row.id, row]))
  const changedSemanticIds = new Set(
    semanticCandidates
      .filter((entry) => {
        const current = currentSemanticRows.get(entry.id)
        return (
          current &&
          (current.title !== entry.title ||
            current.category !== entry.category ||
            current.content !== entry.content)
        )
      })
      .map((entry) => entry.id),
  )
  // Concurrent retrieval lanes can observe different publication heads. A
  // rejected authority observation must win over another lane's older hit.
  const authorityExcludedIds = new Set(
    [...strict, ...broad, ...semanticRows]
      .filter((row) => !hasCurrentGuestPublicationAuthority(row))
      .map((row) => row.id),
  )
  for (const entry of semanticCandidates) {
    if (!currentSemanticRows.has(entry.id)) authorityExcludedIds.add(entry.id)
  }
  const lexicalPool = [
    ...new Map(
      [...strict, ...broad, ...semanticRows.filter((row) => changedSemanticIds.has(row.id))].map(
        (row) => [row.id, row],
      ),
    ).values(),
  ]
    .filter((row) => !authorityExcludedIds.has(row.id))
    .filter((row) => !activatedLegacyIds.has(row.id))
  const weights = conceptWeights(lexicalPool, concepts)
  const scoredLexical = lexicalPool.map((row) => ({
    row,
    score: lexicalScore(row, concepts, weights),
  }))
  const policyExcludedIds = [
    ...authorityExcludedIds,
    // A changed semantic snapshot keeps no vector authority; it must earn a current text match.
    // Ordinary substring candidates that fail word matching are simply not lexical hits.
    ...scoredLexical
      .filter(({ row, score }) => score <= 0 && changedSemanticIds.has(row.id))
      .map(({ row }) => row.id),
  ]
  const lexical = scoredLexical
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.row.updatedAt.getTime() - a.row.updatedAt.getTime() ||
        a.row.id.localeCompare(b.row.id),
    )
  const policyExcluded = new Set(policyExcludedIds)
  // Fuse both lanes by rank. Semantic-first concatenation let five vector neighbours crowd out
  // every lexical match, so records without a stored embedding could never reach the guest.
  const fused = new Map<string, { entry: SemanticKnowledgeEntry; score: number; order: number }>()
  let semanticRank = 0
  for (const entry of semanticCandidates) {
    const current = currentSemanticRows.get(entry.id)
    if (
      current &&
      !changedSemanticIds.has(entry.id) &&
      !policyExcluded.has(entry.id) &&
      !activatedLegacyIds.has(entry.id)
    ) {
      if (
        semanticRank >= SEMANTIC_UNCORROBORATED_LIMIT &&
        lexical.length > 0 &&
        !lexical.some(({ row }) => row.id === entry.id)
      )
        continue
      semanticRank += 1
      fused.set(entry.id, {
        entry: { ...current, distance: entry.distance, content: current.content },
        score: 1 / (FUSION_RANK_OFFSET + semanticRank),
        order: fused.size,
      })
    }
  }
  lexical.forEach(({ row, score }, index) => {
    const contribution = 1 / (FUSION_RANK_OFFSET + index + 1)
    const existing = fused.get(row.id)
    if (existing) {
      existing.score += contribution
      return
    }
    fused.set(row.id, {
      entry: { ...row, distance: Math.max(0, 1 - score / 40) },
      score: contribution,
      order: fused.size,
    })
  })
  const candidates = [...fused.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ entry }) => entry)
  const guaranteed = new Set(
    candidates
      .filter((entry) =>
        semanticCandidates
          .slice(0, SEMANTIC_UNCORROBORATED_LIMIT)
          .some((hit) => hit.id === entry.id),
      )
      .map((entry) => entry.id),
  )
  const selected = candidates.slice(0, resultLimit)
  // Restore any guaranteed vector hit that fused ranking pushed past the budget by replacing the
  // lowest-ranked non-guaranteed entries.
  for (const entry of candidates.slice(resultLimit)) {
    if (!guaranteed.has(entry.id)) continue
    let replaceAt = selected.length - 1
    while (replaceAt >= 0 && guaranteed.has(selected[replaceAt]!.id)) replaceAt -= 1
    if (replaceAt < 0) break
    selected.splice(replaceAt, 1)
    selected.push(entry)
  }
  const perEntryChars = Math.max(
    MIN_RESULT_CONTENT_CHARS,
    Math.min(
      MAX_RESULT_CONTENT_CHARS,
      Math.floor(TOTAL_RESULT_CONTENT_CHARS / Math.max(1, selected.length)),
    ),
  )
  const entries = selected.map((entry) => ({
    ...entry,
    content: boundedRelevantContent(entry.content, concepts, perEntryChars),
  }))
  const lexicalVersions = new Map(
    [...lexical.map(({ row }) => row), ...semanticRows].map((row) => [
      row.id,
      row.updatedAt.toISOString(),
    ]),
  )
  const originalContent = new Map([
    ...lexical.map(({ row }) => [row.id, row.content] as const),
    ...semanticRows.map((row) => [row.id, row.content] as const),
  ])
  const truncatedSourceIds = entries
    .filter((entry) => originalContent.get(entry.id) !== entry.content)
    .map((entry) => entry.id)
  return {
    entries,
    trace: {
      path: params.queryEmbedding ? 'semantic+lexical' : 'lexical-fallback',
      retrievedSourceIds: entries.map((entry) => entry.id),
      retrievedSources: entries.map((entry) => ({
        id: entry.id,
        version: lexicalVersions.get(entry.id) ?? null,
      })),
      excludedSourceIds: [
        ...new Set([
          ...policyExcludedIds,
          ...activatedLegacyIds,
          ...semantic.slice(SEMANTIC_LIMIT).map((entry) => entry.id),
          ...candidates.slice(resultLimit).map((entry) => entry.id),
        ]),
      ],
      candidateCounts: { strict: strict.length, broad: broad.length, semantic: semantic.length },
      limits: { strict: STRICT_LIMIT, broad: BROAD_LIMIT, result: resultLimit },
      partialCoverage:
        strict.length === STRICT_LIMIT ||
        broad.length === BROAD_LIMIT ||
        semantic.length >= SEMANTIC_LIMIT ||
        truncatedSourceIds.length > 0,
      truncatedSourceIds,
      publicationAuthority: entries.flatMap((entry) => {
        const row =
          currentSemanticRows.get(entry.id) ??
          lexical.find((candidate) => candidate.row.id === entry.id)?.row
        return row?.contentModuleId && row.contentRevisionId && row.contentPublicationId
          ? [
              {
                id: row.id,
                moduleId: row.contentModuleId,
                revisionId: row.contentRevisionId,
                publicationId: row.contentPublicationId,
                effectiveFrom: row.contentRevision?.effectiveFrom?.toISOString() ?? null,
                effectiveUntil: row.contentRevision?.effectiveUntil?.toISOString() ?? null,
              },
            ]
          : []
      }),
      retrievalMs: Math.max(0, (params.now ?? performance.now.bind(performance))() - started),
    },
  }
}
