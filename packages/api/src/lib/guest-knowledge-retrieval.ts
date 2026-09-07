import type { SemanticKnowledgeEntry } from '@pathfinder/db'

const STRICT_LIMIT = 20
const BROAD_LIMIT = 60
const RESULT_LIMIT = 5

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
  ['hours', 'opening', 'closing', 'open', 'close', 'horario', 'abre', 'cierra'],
  ['bag', 'bags', 'backpack', 'luggage', 'bolsa', 'mochila', 'equipaje'],
  ['gallery', 'galeria', 'galería', 'galerie'],
  ['north', 'norte', 'nord'],
] as const

export type GuestKnowledgeReader = {
  venueKnowledgeEntry: {
    findMany(args: Record<string, unknown>): Promise<GuestKnowledgeRow[]>
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
}

export type GuestKnowledgeRetrievalTrace = {
  path: 'semantic+lexical' | 'lexical-fallback'
  retrievedSourceIds: string[]
  retrievedSources: { id: string; version: string | null }[]
  excludedSourceIds: string[]
  candidateCounts: { strict: number; broad: number; semantic: number }
  limits: { strict: number; broad: number; result: number }
  partialCoverage: boolean
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
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .slice(0, 8)
  const groups: string[][] = []
  for (const token of tokens) {
    const concept = CONCEPTS.find((items) => items.some((item) => normalize(item) === token))
    const group = concept ? concept.map(normalize) : [token]
    if (!groups.some((existing) => existing.join('|') === group.join('|'))) groups.push(group)
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
  if (/\b(current|latest|effective|approved)\b/.test(`${title} ${category}`)) score += 3
  if (/\b(stale|superseded|archived|obsolete|expired)\b/.test(`${title} ${category}`)) score -= 20
  const reviewed = row.lastReviewedAt?.getTime() ?? 0
  return score + Math.min(1, reviewed / 10 ** 15)
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
  semanticSearch?: () => Promise<SemanticKnowledgeEntry[]>
  now?: () => number
}): Promise<{ entries: SemanticKnowledgeEntry[]; trace: GuestKnowledgeRetrievalTrace }> {
  const reader = params.reader as GuestKnowledgeReader
  const started = (params.now ?? performance.now.bind(performance))()
  const concepts = termsForQuery(params.query)
  const scope = {
    tenantId: params.tenantId,
    venueId: params.venueId,
    isEnabled: true,
    ...(params.includeSecondLayer ? {} : { visibility: 'PUBLIC' }),
  }
  const strictWhere = concepts.length
    ? {
        ...scope,
        AND: concepts.map((group) => ({
          OR: group.map(textClause).flatMap((clause) => clause.OR),
        })),
      }
    : scope
  const broadWhere = concepts.length
    ? {
        ...scope,
        OR: concepts.flatMap((group) => group.map(textClause).flatMap((clause) => clause.OR)),
      }
    : { ...scope, id: '__no_query_terms__' }
  const [strict, broad, semantic] = await Promise.all([
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
      ? params.semanticSearch().catch(() => [])
      : Promise.resolve([]),
  ])
  const scoredLexical = [
    ...new Map([...strict, ...broad].map((row) => [row.id, row])).values(),
  ].map((row) => ({ row, score: lexicalScore(row, concepts) }))
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
    if (!policyExcluded.has(entry.id)) merged.set(entry.id, entry)
  }
  for (const { row, score } of lexical) {
    if (!merged.has(row.id)) merged.set(row.id, { ...row, distance: Math.max(0, 1 - score / 40) })
  }
  const candidates = [...merged.values()]
  const entries = candidates.slice(0, RESULT_LIMIT)
  const lexicalVersions = new Map(lexical.map(({ row }) => [row.id, row.updatedAt.toISOString()]))
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
          ...candidates.slice(RESULT_LIMIT).map((entry) => entry.id),
        ]),
      ],
      candidateCounts: { strict: strict.length, broad: broad.length, semantic: semantic.length },
      limits: { strict: STRICT_LIMIT, broad: BROAD_LIMIT, result: RESULT_LIMIT },
      partialCoverage: strict.length === STRICT_LIMIT || broad.length === BROAD_LIMIT,
      retrievalMs: Math.max(0, (params.now ?? performance.now.bind(performance))() - started),
    },
  }
}
