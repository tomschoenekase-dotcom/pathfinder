import type { SemanticKnowledgeEntry } from '@pathfinder/db'

const STRICT_LIMIT = 20
const BROAD_LIMIT = 60
const RESULT_LIMIT = 5
const MAX_RESULT_CONTENT_CHARS = 4_000

const STOP_WORDS = new Set([
  'a',
  'about',
  'al',
  'are',
  'can',
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
  'how',
  'i',
  'in',
  'is',
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
  'the',
  'to',
  'un',
  'una',
  'what',
  'where',
  'who',
  'with',
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

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
}

function termsForQuery(query: string): string[][] {
  const tokens = [...new Set(normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [])]
    .map((token) => ({
      token,
      concepts: CONCEPTS.filter((items) =>
        items.some((item) => {
          const term = normalize(item)
          return (
            term === token ||
            (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(term) &&
              token.includes(term))
          )
        }),
      ),
    }))
    .filter(({ token, concepts }) =>
      concepts.length > 0 ? true : token.length > 2 && !STOP_WORDS.has(token),
    )
    .slice(0, 8)
  const groups: string[][] = []
  for (const { token, concepts } of tokens) {
    const tokenGroups =
      concepts.length > 0 ? concepts.map((concept) => concept.map(normalize)) : [[token]]
    for (const group of tokenGroups) {
      if (!groups.some((existing) => existing.join('|') === group.join('|'))) groups.push(group)
    }
  }
  return groups.slice(0, 5)
}

function lexicalScore(row: GuestKnowledgeRow, concepts: string[][]): number {
  const title = normalize(row.title)
  const category = normalize(row.category)
  const content = normalize(row.content)
  let score = 0
  for (const concept of concepts) {
    if (concept.some((term) => title.includes(term))) score += 8
    else if (concept.some((term) => category.includes(term))) score += 5
    else if (concept.some((term) => content.includes(term))) score += 2
  }
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

function boundedRelevantContent(content: string, concepts: string[][]): string {
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

function selectShape() {
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

export async function retrieveGuestKnowledge(params: {
  reader: unknown
  query: string
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  queryEmbedding: number[] | null
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
  const concepts = termsForQuery(params.query)
  const asOf = params.asOf ?? new Date()
  const publicationAuthority = {
    OR: [
      { contentModuleId: null },
      {
        contentPublication: { action: 'PUBLISH' },
        contentRevision: {
          audience: 'PUBLIC',
          AND: [
            { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }] },
            { OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: asOf } }] },
            {
              OR: [
                { kind: { not: 'OPERATIONAL_FACT' } },
                { operationalFact: { expiresAt: null } },
                { operationalFact: { expiresAt: { gt: asOf } } },
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
  const scope = {
    tenantId: params.tenantId,
    venueId: params.venueId,
    isEnabled: true,
    ...(params.includeSecondLayer ? {} : { visibility: 'PUBLIC' }),
    AND: [publicationAuthority, adoptionAuthority],
  }
  const strictWhere = concepts.length
    ? {
        ...scope,
        AND: [
          publicationAuthority,
          adoptionAuthority,
          ...concepts.map((group) => ({
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
  const [strict, broad, semantic, activated] = await Promise.all([
    reader.venueKnowledgeEntry.findMany({
      where: strictWhere,
      select: selectShape(),
      orderBy: [{ lastReviewedAt: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      take: STRICT_LIMIT,
    }),
    reader.venueKnowledgeEntry.findMany({
      where: broadWhere,
      select: selectShape(),
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
  const hasCurrentPublicationAuthority = (row: GuestKnowledgeRow) => {
    if (!row.contentModuleId) return true
    const latest = row.contentPublication?.module.publications[0]
    return Boolean(
      latest &&
      latest.id === row.contentPublicationId &&
      latest.eventOrder === row.contentPublication?.eventOrder,
    )
  }
  const scoredLexical = [...new Map([...strict, ...broad].map((row) => [row.id, row])).values()]
    .filter(hasCurrentPublicationAuthority)
    .filter((row) => !activatedLegacyIds.has(row.id))
    .map((row) => ({ row, score: lexicalScore(row, concepts) }))
  const policyExcludedIds = scoredLexical.filter(({ score }) => score <= 0).map(({ row }) => row.id)
  const lexical = scoredLexical
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.row.updatedAt.getTime() - a.row.updatedAt.getTime() ||
        a.row.id.localeCompare(b.row.id),
    )
  const merged = new Map<string, SemanticKnowledgeEntry>()
  const policyExcluded = new Set(policyExcludedIds)
  for (const entry of semantic) {
    if (!policyExcluded.has(entry.id) && !activatedLegacyIds.has(entry.id)) {
      merged.set(entry.id, {
        ...entry,
        content: boundedRelevantContent(entry.content, concepts),
      })
    }
  }
  for (const { row, score } of lexical) {
    if (!merged.has(row.id)) {
      merged.set(row.id, {
        ...row,
        content: boundedRelevantContent(row.content, concepts),
        distance: Math.max(0, 1 - score / 40),
      })
    }
  }
  const candidates = [...merged.values()]
  const entries = candidates.slice(0, RESULT_LIMIT)
  const lexicalVersions = new Map(lexical.map(({ row }) => [row.id, row.updatedAt.toISOString()]))
  const originalContent = new Map([
    ...semantic.map((entry) => [entry.id, entry.content] as const),
    ...lexical.map(({ row }) => [row.id, row.content] as const),
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
          ...candidates.slice(RESULT_LIMIT).map((entry) => entry.id),
        ]),
      ],
      candidateCounts: { strict: strict.length, broad: broad.length, semantic: semantic.length },
      limits: { strict: STRICT_LIMIT, broad: BROAD_LIMIT, result: RESULT_LIMIT },
      partialCoverage:
        strict.length === STRICT_LIMIT ||
        broad.length === BROAD_LIMIT ||
        truncatedSourceIds.length > 0,
      truncatedSourceIds,
      publicationAuthority: entries.flatMap((entry) => {
        const row = lexical.find((candidate) => candidate.row.id === entry.id)?.row
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
