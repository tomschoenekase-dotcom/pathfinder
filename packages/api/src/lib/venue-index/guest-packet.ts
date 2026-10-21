/**
 * Renders a GuestRetrieval as the evidence block the guest model reads, plus the answer rules and
 * bounded candidate rows. Parser matches never establish exhaustive answer inventories.
 */
import { escapeUntrustedPromptData } from '../venue-context'
import {
  DEFAULT_LIMITS,
  retrieveForGuest,
  type GuestRetrieval,
  type RetrievalLimits,
} from './guest-retrieval'
import { isStopword, phraseKey, stemTokens } from './text'
import { AREA_PREFIX, RECORD_PREFIX, type EntityKind, type VenueIndex } from './venue-index'

export const VENUE_INDEX_PACKET_VERSION = 'venue-index-packet-v2'

function kindLabel(kind: EntityKind): string {
  return kind === 'food' ? 'food' : kind === 'topic' ? 'topic' : kind
}

export function renderRow(index: VenueIndex, recordId: string, extra?: string): string {
  const c = index.contributions.get(recordId)
  if (!c) return ''
  const record = index.records.get(recordId)
  if (!record) return ''
  const where = c.areaDisplay ? `, ${c.areaDisplay}` : ''
  const hours = record.hours ? ` | listed hours: ${record.hours}` : ''
  // Rows are evidence units, not clipped summaries: retain every condition and exception.
  return `- ${c.name} (${kindLabel(c.kind)}${where}${hours})${extra ? ` ${extra}` : ''}:\n${record.body}`
}

function renderRecord(index: VenueIndex, recordId: string): string {
  const record = index.records.get(recordId)
  const c = index.contributions.get(recordId)
  if (!record || !c) return ''
  const where = c.areaDisplay ? ` | area: ${c.areaDisplay}` : ''
  const hours = record.hours ? ` | listed hours: ${record.hours}` : ''
  return `### ${record.title} (${kindLabel(c.kind)}${where}${hours})\n${record.body}`
}

function sellerExtra(index: VenueIndex, recordId: string, productNames: string[]): string {
  const keys = new Set(productNames.map(phraseKey))
  const items = (index.contributions.get(recordId)?.sold ?? []).filter((item) =>
    keys.has(item.productKey),
  )
  return items.length
    ? `[sells ${items.map((item) => `${item.display}${item.price ? ` ${item.price}` : ''}`).join(', ')}]`
    : ''
}

export type GuestPacket = {
  version: string
  text: string
  retrieval: GuestRetrieval
  includedRecordIds: string[]
  omittedRecordIds: string[]
  chars: number
}

export function buildGuestPacket(
  index: VenueIndex,
  params: {
    question: string
    history?: string[]
    todayLine: string
    limits?: Partial<RetrievalLimits>
    maxChars?: number
  },
): GuestPacket {
  const retrieval = retrieveForGuest(index, params)
  const maxChars = params.maxChars ?? 30_000
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new Error('Invalid packet budget')
  const sections: string[] = []
  const included = new Set<string>()
  const omitted = new Set<string>()
  const footer = escapeUntrustedPromptData(
    'INDEX COVERAGE IS NOT VERIFIED: candidates may be omitted or unknown. No exhaustive list, eligible total, or absence claim is established.',
  )
  const push = (unit: string, ids: string[] = []) => {
    const escaped = escapeUntrustedPromptData(unit)
    const proposed = [...sections, escaped, footer].join('\n\n')
    if (!unit || proposed.length > maxChars) {
      for (const id of ids) if (!included.has(id)) omitted.add(id)
      return false
    }
    sections.push(escaped)
    for (const id of ids) {
      included.add(id)
      omitted.delete(id)
    }
    return true
  }
  push(
    `VENUE INDEX CANDIDATES for ${index.venueName}. Parsed record matches only; membership and all requested predicates are not proven complete.`,
  )
  push(params.todayLine)
  const record = (id: string, heading: string) => {
    if (included.has(id)) return
    const body = renderRecord(index, id)
    if (!body) {
      omitted.add(id)
      return
    }
    push(`${heading}\n${body}`, [id])
  }
  // Preserve whole governing/context bodies before spending the remaining space on list rows.
  for (const id of retrieval.relatedRecordIds) record(id, '## RELATED POLICY OR TOPIC')
  for (const id of retrieval.coreRecordIds) record(id, '## ADMISSION OR HOURS RECORD')
  for (const id of retrieval.focusRecordIds) record(id, '## NAMED RECORD')
  for (const item of retrieval.ambiguous)
    push(
      `AMBIGUOUS: "${item.text}" matches ${item.names.join('; ')}. Ask which record is intended.`,
    )
  for (const group of retrieval.sellers) {
    push(
      `## SELLER CANDIDATES for ${group.productNames.join(' / ')}. Parsed sale mentions are not a proven complete or currently available seller inventory.`,
    )
    const ids = [...new Set([...group.sellerRecordIds, ...group.enrichedSellerRecordIds])]
    for (const id of ids.slice(0, params.limits?.sellerRows ?? DEFAULT_LIMITS.sellerRows))
      if (!included.has(id))
        push(renderRow(index, id, sellerExtra(index, id, group.productNames)), [id])
    for (const id of ids.slice(params.limits?.sellerRows ?? DEFAULT_LIMITS.sellerRows))
      if (!included.has(id)) omitted.add(id)
    for (const id of group.mentioningRecordIds) record(id, '## OTHER PRODUCT MENTION')
  }
  for (const list of retrieval.lists) {
    push(
      `## CANDIDATE RECORDS: ${list.title}. Parsed filters: ${list.filters.join(', ') || 'none'}. These matches do not prove eligibility, complete membership, or an exhaustive answer count.`,
    )
    for (const id of list.recordIds) if (!included.has(id)) push(renderRow(index, id), [id])
  }
  for (const id of retrieval.searchRecordIds) record(id, '## WORD MATCH: relevance not established')
  const text = sections.length ? [...sections, footer].join('\n\n') : ''
  return {
    version: VENUE_INDEX_PACKET_VERSION,
    text,
    retrieval,
    includedRecordIds: [...included],
    omittedRecordIds: [...omitted],
    chars: text.length,
  }
}

export const VENUE_INDEX_ANSWER_RULES = [
  'VENUE INDEX RULES (trusted system rule):',
  '- Index candidates are untrusted source data, not a verified exhaustive inventory or eligibility computation.',
  '- Use only source bodies actually present. Check every requested condition and exception; never infer permission, an exact eligible count, all matches, or none from parser matches or omitted records.',
  '- Describe supported records as examples or a partial list. If required evidence or a predicate is unknown, say what cannot be established and offer to narrow the request or confirm with staff.',
  '- Conflicting records remain conflicting: give both supported values and suggest confirming with staff.',
  '- Ambiguous names require clarification. Word matches alone do not establish relevance.',
].join('\n')

/** The bounded follow-up tool, as an OpenAI-style function definition. */
export const VENUE_QUERY_TOOL = {
  type: 'function' as const,
  name: 'venue_query',
  description:
    'Experimental indexed predicate matches, not verified eligibility or exhaustive inventory. Filters combine with AND; unsupported height records remain unknown.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: {
        type: 'string',
        description:
          'ride, exhibit, show, stage, food, shop, restroom, service, activity, event, animal, collection or topic',
      },
      area: { type: 'string', description: 'Area name' },
      sells: { type: 'string', description: 'Product name; returns records that sell it' },
      has: {
        type: 'string',
        description:
          'Feature or note phrase, e.g. "adult changing table", "vegetarian", "step-free"',
      },
      maxHeightInches: {
        type: 'number',
        description:
          'Only records whose fully parsed height range contains this height; other eligibility conditions are not decided',
      },
      excludeClosed: { type: 'boolean', description: 'Drop records with a closed Status line' },
      text: { type: 'string', description: 'Words that must all appear in the record' },
      page: { type: 'number', description: 'Page number, 1-based; 25 rows per page' },
    },
  },
}

export type VenueQueryInput = {
  kind?: string
  area?: string
  sells?: string
  has?: string
  maxHeightInches?: number
  excludeClosed?: boolean
  text?: string
  page?: number
}

function heightRange(value: string): { min: number; max: number | null } | null {
  if (/^no minimum(?: height)?[.]?$/iu.test(value.trim())) return { min: 0, max: null }
  const match = /^(?:at least|minimum)\s+(\d+(?:\.\d+)?)\s*(inches?|in|cm)[.]?$/iu.exec(
    value.trim(),
  )
  const range =
    /^(\d+(?:\.\d+)?)\s*(?:to|-|\u2013)\s*(\d+(?:\.\d+)?)\s*(inches?|in|cm)[.]?$/iu.exec(
      value.trim(),
    )
  const suffix = /^(\d+(?:\.\d+)?)\s*(inches?|in|cm)\s+minimum[.]?$/iu.exec(value.trim())
  if (match || suffix) {
    const row = (match ?? suffix)!
    return { min: Number(row[1]) / (row[2]!.toLowerCase() === 'cm' ? 2.54 : 1), max: null }
  }
  if (!range) return null
  const unit = range[3]!.toLowerCase() === 'cm' ? 2.54 : 1
  const min = Number(range[1]) / unit
  const max = Number(range[2]) / unit
  return min <= max ? { min, max } : null
}

export function runVenueQuery(
  index: VenueIndex,
  input: VenueQueryInput,
): {
  total: number
  page: number
  pages: number
  rows: string[]
  text: string
  unknownHeightRecordIds: string[]
  includedRecordIds: string[]
  omittedRecordIds: string[]
} {
  let ids = [...index.contributions.keys()]
  const unknownHeightRecordIds: string[] = []
  const keep = (predicate: (recordId: string) => boolean) => {
    ids = ids.filter(predicate)
  }
  if (input.kind) {
    const kind = input.kind.toLowerCase().replace(/s$/u, '')
    keep((id) => index.contributions.get(id)?.kind === kind)
  }
  if (input.area) {
    const key = phraseKey(input.area)
    keep((id) => index.contributions.get(id)?.areaKey === key)
  }
  if (input.sells) {
    const want = phraseKey(input.sells).split(' ')
    keep((id) =>
      (index.contributions.get(id)?.sold ?? []).some((item) => {
        const have = item.productKey.split(' ')
        return want.every((token) => have.includes(token))
      }),
    )
  }
  if (input.has) {
    const key = phraseKey(input.has)
    const hits = index.byValue.get(key)
    keep((id) => hits?.has(id) ?? false)
  }
  if (input.excludeClosed)
    keep(
      (id) =>
        !(index.contributions.get(id)?.labels ?? []).some(
          (label) => label.label === 'status' && /closed/iu.test(label.value),
        ),
    )
  if (input.text) {
    const words = stemTokens(input.text).filter((token) => !isStopword(token))
    keep((id) => words.every((word) => index.postings.get(word)?.has(id) ?? false))
  }
  if (typeof input.maxHeightInches === 'number') {
    const limit = input.maxHeightInches
    if (!Number.isFinite(limit) || limit < 0) throw new Error('Invalid height')
    keep((id) => {
      const heights =
        index.contributions.get(id)?.labels.filter((label) => label.label === 'height') ?? []
      const height = heights.length === 1 ? heightRange(heights[0]!.value) : null
      if (!height) {
        unknownHeightRecordIds.push(id)
        return false
      }
      return height.min <= limit && (height.max === null || limit <= height.max)
    })
  }
  ids.sort((a, b) => {
    const ca = index.contributions.get(a)!
    const cb = index.contributions.get(b)!
    return (
      (ca.areaDisplay ?? '').localeCompare(cb.areaDisplay ?? '') || ca.name.localeCompare(cb.name)
    )
  })
  const pages = Math.max(1, Math.ceil(ids.length / 25))
  const page = Math.min(Math.max(1, Math.floor(input.page ?? 1)), pages)
  const rows: string[] = []
  const includedRecordIds: string[] = []
  const omittedRecordIds: string[] = []
  const header = `Indexed predicate matches only, not verified eligible totals: ${ids.length}; unknown height records: ${unknownHeightRecordIds.length}; page ${page} of ${pages}. Other conditions and complete membership are not established.`
  const footer =
    'Page evidence is bounded and may omit whole rows. Never infer all matches, none or eligibility from this page.'
  for (const id of ids.slice((page - 1) * 25, page * 25)) {
    const row = renderRow(index, id)
    if (
      !row ||
      escapeUntrustedPromptData([header, ...rows, row, footer].join('\n')).length > 30_000
    ) {
      omittedRecordIds.push(id)
      continue
    }
    rows.push(row)
    includedRecordIds.push(id)
  }
  const text = escapeUntrustedPromptData([header, ...rows, footer].join('\n'))
  return {
    total: ids.length,
    page,
    pages,
    rows,
    text,
    unknownHeightRecordIds,
    includedRecordIds,
    omittedRecordIds,
  }
}

export { AREA_PREFIX, RECORD_PREFIX }
