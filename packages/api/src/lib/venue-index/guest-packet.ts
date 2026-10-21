/**
 * Renders a GuestRetrieval as the evidence block the guest model reads, plus the answer rules and
 * the one bounded follow-up tool. Lists carry explicit totals so the model knows when it has all.
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

export const VENUE_INDEX_PACKET_VERSION = 'venue-index-packet-v1'

const ROW_LABELS: Record<string, string[]> = {
  food: ['sells', 'hours', 'days', 'status'],
  shop: ['sells', 'hours', 'status'],
  restroom: ['features', 'status'],
  ride: ['height', 'ages', 'price', 'single rider', 'status', 'access'],
  exhibit: ['animals', 'access', 'price', 'status'],
  activity: ['price', 'ages', 'height', 'hours', 'reservation', 'status'],
  show: ['shows', 'price', 'ages', 'status'],
  service: ['rentals', 'services', 'price', 'status'],
  event: ['when', 'price', 'ages'],
  animal: ['lives in'],
}

function kindLabel(kind: EntityKind): string {
  return kind === 'food' ? 'food' : kind === 'topic' ? 'topic' : kind
}

export function renderRow(
  index: VenueIndex,
  recordId: string,
  extra?: string,
  options: { firstSentence?: boolean } = {},
): string {
  const c = index.contributions.get(recordId)
  if (!c) return ''
  const wanted = ROW_LABELS[c.kind] ?? []
  const facts = c.labels
    .filter((label) => wanted.includes(label.label))
    .map((label) => `${label.label[0]!.toUpperCase()}${label.label.slice(1)}: ${label.value}`)
  const first = index.records.get(recordId)?.body.split(/\r?\n/u)[0] ?? ''
  const where = c.areaDisplay ? `, ${c.areaDisplay}` : ''
  // The first sentence says where and what the thing is; short lists keep it so a location is
  // never left for the model to fill in.
  const detail = facts.length
    ? [...(options.firstSentence && first ? [first] : []), ...facts].join(' | ')
    : first
  return `- ${c.name} (${kindLabel(c.kind)}${where})${extra ? ` ${extra}` : ''}: ${detail}`.slice(
    0,
    520,
  )
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
  const sections: string[] = []
  const included = new Set<string>()
  const push = (text: string) => {
    sections.push(text)
  }
  push(
    `VENUE INDEX RESULTS for ${index.venueName} (built from this venue's published records only)`,
  )
  push(params.todayLine)
  const matched = [...retrieval.mentions, ...retrieval.carriedMentions].filter(
    (mention, position, all) => all.findIndex((other) => other.key === mention.key) === position,
  )
  if (matched.length) {
    push(
      'Recognized in the conversation: ' +
        matched
          .map((mention) => {
            const names = [...new Set(mention.entityIds.map((id) => index.entity(id)?.name ?? id))]
            return `"${mention.text}" means ${names.slice(0, 6).join(' / ')}${names.length > 6 ? ` (+${names.length - 6} more)` : ''}${mention.fuzzy ? ' (spelling interpreted)' : ''}`
          })
          .join('; '),
    )
  } else push('Recognized in the conversation: no specific named place, product or animal.')
  for (const item of retrieval.ambiguous)
    push(
      `AMBIGUOUS: "${item.text}" matches more than one record: ${item.names.join('; ')}. If it matters, ask which one or answer for each.`,
    )
  for (const group of retrieval.sellers) {
    const total = group.sellerRecordIds.length + group.enrichedSellerRecordIds.length
    const rows = group.sellerRecordIds.map((id) =>
      renderRow(index, id, sellerExtra(index, id, group.productNames), {
        firstSentence: group.sellerRecordIds.length <= 30,
      }),
    )
    for (const id of group.sellerRecordIds) included.add(id)
    const shown = rows.slice(0, params.limits?.sellerRows ?? DEFAULT_LIMITS.sellerRows)
    push(
      `## SELLERS of ${group.productNames.join(' / ')}: ${total === 0 ? 'no record lists a seller' : `${group.sellerRecordIds.length} record(s) list it for sale`}${shown.length < rows.length ? ` (showing ${shown.length}; the rest are available with venue_query)` : ' (complete list)'}\n${shown.join('\n')}`,
    )
    if (group.enrichedSellerRecordIds.length)
      push(
        `Other sellers described in prose (verified quotes):\n${group.enrichedSellerRecordIds.map((id) => renderRow(index, id)).join('\n')}`,
      )
    if (group.mentioningRecordIds.length) {
      push(
        `Other records that mention ${group.productNames[0]} (may describe more places, days or limits):`,
      )
      for (const id of group.mentioningRecordIds) {
        push(renderRecord(index, id))
        included.add(id)
      }
    }
  }
  for (const list of retrieval.lists) {
    const label = [
      list.title,
      list.kinds.length ? `kinds: ${list.kinds.join('/')}` : '',
      list.filters.length ? `filters: ${list.filters.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' | ')
    const complete = list.recordIds.length >= list.total
    push(
      `## LIST (${label}): ${list.total} match(es)${complete ? ' (complete list)' : ` (showing ${list.recordIds.length}; use venue_query for the rest, or give the total and ask how to narrow it)`}\n${list.recordIds.map((id) => renderRow(index, id, undefined, { firstSentence: list.recordIds.length <= 30 })).join('\n')}`,
    )
    for (const id of list.recordIds) included.add(id)
  }
  if (retrieval.focusRecordIds.length) {
    push('## RECORDS FOR WHAT THE GUEST NAMED')
    for (const id of retrieval.focusRecordIds) {
      push(renderRecord(index, id))
      included.add(id)
    }
  }
  if (retrieval.relatedRecordIds.length) {
    push('## POLICIES AND TOPICS THAT NAME THEM')
    for (const id of retrieval.relatedRecordIds) {
      push(renderRecord(index, id))
      included.add(id)
    }
  }
  const core = retrieval.coreRecordIds.filter((id) => !included.has(id))
  if (core.length) {
    push('## ADMISSION AND HOURS')
    for (const id of core) {
      push(renderRecord(index, id))
      included.add(id)
    }
  }
  const search = retrieval.searchRecordIds.filter((id) => !included.has(id))
  if (search.length) {
    push('## OTHER RECORDS MATCHING THE QUESTION WORDS (may or may not be relevant)')
    for (const id of search) {
      push(renderRecord(index, id))
      included.add(id)
    }
  }
  const digest = policyDigest(index, included, params.question)
  if (digest) push(`## OTHER VENUE POLICIES (first line of each; full text not shown)\n${digest}`)
  push(
    `## VENUE SUMMARY\n${summary(index)}\nFor a list or count this packet does not already answer, call venue_query once.`,
  )
  let text = sections.join('\n\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[packet truncated]`
  return {
    version: VENUE_INDEX_PACKET_VERSION,
    text: escapeUntrustedPromptData(text),
    retrieval,
    includedRecordIds: [...included],
    chars: text.length,
  }
}

/** First sentence of each venue-wide policy or topic not already shown, so no rule is invisible. */
function policyDigest(
  index: VenueIndex,
  included: Set<string>,
  question: string,
  maxChars = 3_500,
): string {
  const scores = new Map(
    index
      .search(question, {
        limit: 200,
        filter: (id) => index.contributions.get(id)?.kind === 'topic',
      })
      .map((hit) => [hit.recordId, hit.score]),
  )
  const topics = [...(index.byKind.get('topic') ?? [])]
    .map((id) => id.slice(RECORD_PREFIX.length))
    .filter((id) => !included.has(id))
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || a.localeCompare(b))
  const lines: string[] = []
  let used = 0
  for (const id of topics) {
    const record = index.records.get(id)
    if (!record) continue
    const line = `- ${record.title}: ${record.body.split(/\r?\n/u)[0] ?? ''}`.slice(0, 300)
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

function summary(index: VenueIndex): string {
  const kinds = [...index.byKind.entries()]
    .filter(([kind]) => kind !== 'topic')
    .map(([kind, ids]) => `${ids.size} ${kind}`)
    .join(', ')
  const areas = [...index.areas.values()].map((entry) => [...entry.values()].sort()[0]).sort()
  return `${index.contributions.size} records: ${kinds}. Areas (${areas.length}): ${areas.slice(0, 40).join(', ')}${areas.length > 40 ? ', ...' : ''}.`
}

export const VENUE_INDEX_ANSWER_RULES = [
  'VENUE INDEX RULES (trusted system rule):',
  "- The VENUE INDEX RESULTS block is built from this venue's published records for the current question. Use it, together with any venue_query results, as your source of venue facts. Never add venue facts from memory.",
  '- A list or seller section marked "complete list" contains every matching record in the venue. Name every item when there are 12 or fewer. With more, give the exact total, name the most useful few, and offer to narrow by area, day or price.',
  '- A section that says "showing N" is partial. Give its stated total, never imply the shown items are all, and call venue_query if the guest needs a specific part of the rest.',
  '- Check each condition the guest gave (age, height, day, date, access, price, diet) against each record, including closures, day limits and exceptions written in policies and topics.',
  '- When two records disagree, say so briefly, give both values, and suggest confirming with staff. When the results do not cover something, say you are not sure and who can check; do not guess.',
  "- If the guest's words could mean more than one place (an AMBIGUOUS line), ask which one or answer briefly for each.",
  '- Records under "may or may not be relevant" were matched by words only; use them only when they truly answer the question.',
].join('\n')

/** The bounded follow-up tool, as an OpenAI-style function definition. */
export const VENUE_QUERY_TOOL = {
  type: 'function' as const,
  name: 'venue_query',
  description:
    "Exact list and count over this venue's published records. Filters combine with AND. Returns the total and one page of rows.",
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
        description: 'Only rides a guest of this height can ride (minimum height at or below it)',
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

function minimumHeight(value: string): number {
  if (/no minimum/iu.test(value)) return 0
  const match = /(?:at least|minimum)\s+(\d+)|^(\d+)\s+(?:to|-|\u2013)/iu.exec(value)
  return Number(match?.[1] ?? match?.[2] ?? 0)
}

export function runVenueQuery(
  index: VenueIndex,
  input: VenueQueryInput,
): { total: number; page: number; pages: number; rows: string[]; text: string } {
  let ids = [...index.contributions.keys()]
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
  if (typeof input.maxHeightInches === 'number') {
    const limit = input.maxHeightInches
    keep((id) => {
      const height = index.contributions.get(id)?.labels.find((label) => label.label === 'height')
      return height ? minimumHeight(height.value) <= limit : false
    })
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
  ids.sort((a, b) => {
    const ca = index.contributions.get(a)!
    const cb = index.contributions.get(b)!
    return (
      (ca.areaDisplay ?? '').localeCompare(cb.areaDisplay ?? '') || ca.name.localeCompare(cb.name)
    )
  })
  const pages = Math.max(1, Math.ceil(ids.length / 25))
  const page = Math.min(Math.max(1, Math.floor(input.page ?? 1)), pages)
  const rows = ids.slice((page - 1) * 25, page * 25).map((id) => renderRow(index, id))
  const text = `venue_query ${JSON.stringify(input)}: ${ids.length} match(es); page ${page} of ${pages}\n${rows.join('\n')}`
  return { total: ids.length, page, pages, rows, text: escapeUntrustedPromptData(text) }
}

export { AREA_PREFIX, RECORD_PREFIX }
