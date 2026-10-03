import { parse, type DefaultTreeAdapterMap } from 'parse5'

import {
  SOURCE_CONNECTION_LIMITS,
  SourceConnectionConfigSchema,
  SourceConnectionRecordSchema,
  type SourceConnectionConfig,
  type SourceConnectionRecord,
} from '@pathfinder/contracts/source-connections'
import {
  dateOnlyWindowToInstants,
  zonedWallTimeToInstant,
} from '@pathfinder/contracts/operational-update-lifecycle'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
type HtmlField = Extract<SourceConnectionConfig['mappings'][number], { type: 'html' }>['id']

export type SourceConnectionExtraction =
  | { status: 'VALID'; records: SourceConnectionRecord[]; issues: [] }
  | { status: 'REVIEW_REQUIRED'; records: []; issues: string[] }

class ExtractionError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function refuse(code: string): never {
  throw new ExtractionError(code)
}

function text(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function ensureText(value: unknown, max: number): string {
  if (typeof value !== 'string') refuse('FIELD_MISSING')
  const normalized = text(value)
  if (!normalized || normalized.length > max) refuse('FIELD_INVALID')
  return normalized
}

function requiredMapped<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) refuse('MAPPED_FIELD_MISSING')
  return value
}

function validDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) refuse('DATE_INVALID')
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  )
    refuse('DATE_INVALID')
  return value
}

const MONTHS = new Map([
  ['january', 1],
  ['february', 2],
  ['march', 3],
  ['april', 4],
  ['may', 5],
  ['june', 6],
  ['july', 7],
  ['august', 8],
  ['september', 9],
  ['october', 10],
  ['november', 11],
  ['december', 12],
])

function parseDate(
  value: string,
  format: 'iso' | 'english_month_day_year' | 'english_month_day',
  yearAnchor?: number,
): string {
  const normalized = ensureText(value, 80)
  if (format === 'iso') return validDate(normalized)
  const match = /^([a-z]+)\s+(\d{1,2})(st|nd|rd|th)?(?:,?\s+(\d{4}))?$/iu.exec(normalized)
  if (!match) refuse('DATE_INVALID')
  const month = MONTHS.get(match[1]!.toLowerCase())
  const day = Number(match[2])
  const ordinal = match[3]?.toLowerCase()
  const expectedOrdinal =
    day % 100 >= 11 && day % 100 <= 13
      ? 'th'
      : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th')
  if (ordinal && ordinal !== expectedOrdinal) refuse('DATE_INVALID')
  const year = match[4] ? Number(match[4]) : yearAnchor
  if (!month || !year || (format === 'english_month_day_year' && !match[4]))
    refuse('DATE_AMBIGUOUS')
  return validDate(
    `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}`,
  )
}

function wallParts(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const field = (name: string) => parts.find((part) => part.type === name)?.value ?? ''
  return `${field('year')}-${field('month')}-${field('day')}T${field('hour')}:${field('minute')}`
}

function parseLocalTime(value: string, date: string, timezone: string): string {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/iu.exec(ensureText(value, 40))
  if (!match) refuse('SHOWTIME_INVALID')
  const hour12 = Number(match[1]),
    minute = Number(match[2] ?? '0')
  if (hour12 < 1 || hour12 > 12 || minute > 59) refuse('SHOWTIME_INVALID')
  const hour = (hour12 % 12) + (match[3]!.toUpperCase() === 'PM' ? 12 : 0)
  const wall = {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
    hour,
    minute,
  }
  const instant = zonedWallTimeToInstant(wall, timezone)
  const expected = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  if (wallParts(instant, timezone) !== expected) refuse('DST_GAP')
  // The shared helper picks the first occurrence in a fall-back fold; source connections
  // refuse the ambiguity instead of silently choosing an occurrence.
  for (const offset of [-120, -90, -60, -30, 30, 60, 90, 120]) {
    if (wallParts(new Date(instant.getTime() + offset * 60_000), timezone) === expected)
      refuse('DST_AMBIGUOUS')
  }
  return instant.toISOString()
}

function nextDate(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`)
  instant.setUTCDate(instant.getUTCDate() + 1)
  return instant.toISOString().slice(0, 10)
}

function absoluteShowtime(value: string, timezone: string): string {
  const source = ensureText(value, 80)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(source)
  )
    refuse('SHOWTIME_OFFSET_REQUIRED')
  validDate(source.slice(0, 10))
  if (
    Number(source.slice(11, 13)) > 23 ||
    Number(source.slice(14, 16)) > 59 ||
    (source[16] === ':' && Number(source.slice(17, 19)) > 59)
  )
    refuse('SHOWTIME_INVALID')
  const instant = new Date(source)
  if (!Number.isFinite(instant.getTime())) refuse('SHOWTIME_INVALID')
  const wall = wallParts(instant, timezone)
  // A non-UTC numeric offset must describe the venue's wall time. UTC feeds
  // commonly encode only the instant, so derive their venue wall time instead.
  if (!source.endsWith('Z') && wall !== source.slice(0, 16)) refuse('SHOWTIME_ZONE_MISMATCH')
  for (const offset of [-120, -90, -60, -30, 30, 60, 90, 120]) {
    if (wallParts(new Date(instant.getTime() + offset * 60_000), timezone) === wall)
      refuse('DST_AMBIGUOUS')
  }
  return instant.toISOString()
}

function interval(startAt: string, endAt: string) {
  const duration = Date.parse(endAt) - Date.parse(startAt)
  if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 60 * 60_000)
    refuse('SHOWTIME_INTERVAL_INVALID')
  return { startAt, endAt }
}

function effectiveWindow(
  startDate: string | null,
  endDate: string | null,
  timezone: string,
  showtimes: SourceConnectionRecord['showtimes'],
) {
  const range = startDate
    ? dateOnlyWindowToInstants({ startDate, endDate: endDate ?? startDate, timeZone: timezone })
    : null
  const starts = showtimes.map((item) => Date.parse(item.startAt))
  const ends = showtimes.map((item) => Date.parse(item.endAt))
  if (range) {
    starts.push(range.startsAt.getTime())
    ends.push(range.expiresAt.getTime())
  }
  return {
    effectiveFrom: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
    effectiveUntil: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
  }
}

function readPointer(value: unknown, pointer: string): unknown {
  let current = value
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (Array.isArray(current) && /^\d+$/u.test(key)) current = current[Number(key)]
    else if (current && typeof current === 'object' && !Array.isArray(current)) {
      current = Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined
    } else return undefined
  }
  return current
}

function element(node: Node): node is Element {
  return 'tagName' in node
}
function children(node: Node): Node[] {
  return 'childNodes' in node ? [...node.childNodes] : []
}
function attr(node: Element, name: string): string | undefined {
  return node.attrs.find((item) => item.name === name)?.value
}

function matches(node: Element, token: string): boolean {
  const match = /^([a-z][a-z0-9-]*)(?:([.#])([a-z][a-z0-9_-]*))?$/u.exec(token)
  if (!match || node.tagName !== match[1]) return false
  if (match[2] === '#') return attr(node, 'id') === match[3]
  if (match[2] === '.') return (attr(node, 'class') ?? '').split(/\s+/u).includes(match[3]!)
  return true
}

function select(root: Node, selector: string): Element[] {
  const tokens = selector.split(' ')
  const found: Element[] = []
  const visit = (node: Node, ancestors: Element[], depth: number) => {
    if (depth > 100) refuse('HTML_DEPTH_LIMIT')
    if (element(node)) {
      const lineage = [...ancestors, node]
      let cursor = lineage.length - 1
      if (matches(node, tokens[tokens.length - 1]!)) {
        for (let index = tokens.length - 2; index >= 0; index -= 1) {
          cursor -= 1
          while (cursor >= 0 && !matches(lineage[cursor]!, tokens[index]!)) cursor -= 1
          if (cursor < 0) break
        }
        if (cursor >= 0) found.push(node)
      }
      for (const child of children(node)) visit(child, lineage, depth + 1)
      return
    }
    for (const child of children(node)) visit(child, ancestors, depth + 1)
  }
  visit(root, [], 0)
  return found
}

function nodeText(root: Node): string {
  const chunks: string[] = []
  const visit = (node: Node, depth: number) => {
    if (depth > 100) refuse('HTML_DEPTH_LIMIT')
    if ('value' in node) {
      chunks.push(node.value)
      return
    }
    if (element(node) && ['script', 'style', 'noscript', 'template'].includes(node.tagName)) return
    for (const child of children(node)) visit(child, depth + 1)
  }
  visit(root, 0)
  return text(chunks.join(' '))
}

function field(root: Node, spec: HtmlField): string | undefined {
  const found = select(root, spec.selector)
  if (found.length !== 1) return undefined
  return spec.attribute === 'text' ? nodeText(found[0]!) : attr(found[0]!, spec.attribute)
}

function parseHtml(body: string): Node {
  if (Buffer.byteLength(body, 'utf8') > SOURCE_CONNECTION_LIMITS.maxBodyBytes)
    refuse('BODY_TOO_LARGE')
  // Linear scan: a backtracking regex over unterminated tags is quadratic on hostile input.
  let tags = 0
  let close = -2
  for (let at = body.indexOf('<'); at >= 0; at = body.indexOf('<', at + 1)) {
    tags += 1
    if (tags > 5_000) refuse('HTML_COMPLEXITY_LIMIT')
    const next = body.charCodeAt(at + 1)
    if ((next | 0x20) >= 0x61 && (next | 0x20) <= 0x7a) {
      if (close !== -1 && close < at) close = body.indexOf('>', at + 1)
      else if (close === -2) close = body.indexOf('>', at + 1)
      if (close >= 0 && close - at - 2 >= 1024) refuse('HTML_COMPLEXITY_LIMIT')
    }
  }
  return parse(body)
}

function parseRecord(
  input: {
    id: unknown
    kind: SourceConnectionRecord['kind']
    title: unknown
    text: unknown
    startDate?: unknown
    endDate?: unknown
    showtimes?: unknown
    showtimeEnds?: unknown
    cancelled?: unknown
    exceptions?: unknown
    dateFormat: 'iso' | 'english_month_day_year' | 'english_month_day'
    links?: unknown
    yearAnchor?: number | undefined
    fixedEndDate?: string | undefined
    allowCrossMidnight?: boolean | undefined
  },
  config: SourceConnectionConfig,
): SourceConnectionRecord {
  const startDate =
    input.startDate === undefined || input.startDate === null || input.startDate === ''
      ? null
      : parseDate(ensureText(input.startDate, 80), input.dateFormat, input.yearAnchor)
  const endDate =
    input.endDate === undefined || input.endDate === null || input.endDate === ''
      ? (input.fixedEndDate ?? null)
      : parseDate(ensureText(input.endDate, 80), input.dateFormat, input.yearAnchor)
  const showtimes: Array<{ startAt: string; endAt: string }> = []
  if (input.showtimes !== undefined) {
    const starts = Array.isArray(input.showtimes) ? input.showtimes : [input.showtimes]
    const ends = Array.isArray(input.showtimeEnds) ? input.showtimeEnds : [input.showtimeEnds]
    const objectIntervals = starts.every(
      (value) => value && typeof value === 'object' && !Array.isArray(value),
    )
    if (
      starts.length > SOURCE_CONNECTION_LIMITS.maxShowtimes ||
      (!objectIntervals && starts.length !== ends.length)
    )
      refuse('SHOWTIME_STRUCTURE_DRIFT')
    for (let index = 0; index < starts.length; index += 1) {
      if (starts[index] && typeof starts[index] === 'object' && !Array.isArray(starts[index])) {
        const value = starts[index] as Record<string, unknown>
        showtimes.push(
          interval(
            absoluteShowtime(ensureText(value.startAt, 80), config.timezone),
            absoluteShowtime(ensureText(value.endAt, 80), config.timezone),
          ),
        )
        continue
      }
      const rawStart = ensureText(starts[index], 80),
        rawEnd = ensureText(ends[index], 80)
      const absolute = /^\d{4}-\d{2}-\d{2}T/u.test(rawStart)
      if (!absolute && !startDate) refuse('SHOWTIME_DATE_REQUIRED')
      const startAt = absolute
        ? absoluteShowtime(rawStart, config.timezone)
        : parseLocalTime(rawStart, startDate!, config.timezone)
      let endAt = absolute
        ? absoluteShowtime(rawEnd, config.timezone)
        : parseLocalTime(rawEnd, startDate!, config.timezone)
      if (Date.parse(endAt) <= Date.parse(startAt) && !absolute && input.allowCrossMidnight) {
        endAt = parseLocalTime(rawEnd, nextDate(startDate!), config.timezone)
      }
      showtimes.push(interval(startAt, endAt))
    }
  }
  if (input.kind !== 'description' && !startDate && showtimes.length === 0) refuse('DATE_REQUIRED')
  if (input.kind === 'showtime' && showtimes.length === 0) refuse('SHOWTIME_REQUIRED')
  if (endDate && !startDate) refuse('DATE_REQUIRED')
  if (startDate && endDate && endDate < startDate) refuse('DATE_ORDER_INVALID')
  for (const showtime of showtimes) {
    const localStart = wallParts(new Date(showtime.startAt), config.timezone).slice(0, 10)
    const localEnd = wallParts(new Date(showtime.endAt), config.timezone).slice(0, 10)
    if (
      startDate &&
      (localStart < startDate ||
        localStart > (endDate ?? startDate) ||
        localEnd > nextDate(endDate ?? startDate))
    )
      refuse('SHOWTIME_DATE_MISMATCH')
  }
  let cancelled = false
  if (input.cancelled !== undefined) {
    if (typeof input.cancelled === 'boolean') cancelled = input.cancelled
    else if (
      typeof input.cancelled === 'string' &&
      /^(true|yes|cancelled|false|no|scheduled)$/iu.test(text(input.cancelled))
    ) {
      cancelled = /^(true|yes|cancelled)$/iu.test(text(input.cancelled))
    } else refuse('CANCELLATION_INVALID')
  }
  const exceptions =
    input.exceptions === undefined
      ? []
      : (Array.isArray(input.exceptions) ? input.exceptions : [input.exceptions]).map((item) =>
          parseDate(ensureText(item, 80), input.dateFormat, input.yearAnchor),
        )
  if (exceptions.length > SOURCE_CONNECTION_LIMITS.maxExceptions) refuse('EXCEPTION_LIMIT')
  if (exceptions.some((date) => !startDate || date < startDate || date > (endDate ?? startDate)))
    refuse('EXCEPTION_DATE_MISMATCH')
  const links = (
    input.links === undefined ? [] : Array.isArray(input.links) ? input.links : [input.links]
  ).map((value) => {
    const raw = ensureText(value, SOURCE_CONNECTION_LIMITS.maxUrlLength)
    let absolute: string
    try {
      absolute = new URL(raw, config.sourceUrl).toString()
    } catch {
      refuse('LINK_INVALID')
    }
    if (!config.allowedUrls.includes(absolute)) refuse('LINK_NOT_APPROVED')
    return absolute
  })
  if (links.length > SOURCE_CONNECTION_LIMITS.maxAllowedUrls) refuse('LINK_LIMIT')
  const window = effectiveWindow(startDate, endDate, config.timezone, showtimes)
  return SourceConnectionRecordSchema.parse({
    id: ensureText(input.id, 191),
    kind: input.kind,
    title: ensureText(input.title, 240),
    text: ensureText(input.text, SOURCE_CONNECTION_LIMITS.maxTextLength),
    sourceUrl: config.sourceUrl,
    startDate,
    endDate,
    showtimes,
    ...window,
    timezone: config.timezone,
    cancelled,
    exceptions,
    links,
  })
}

/** Pure, deterministic extraction. A single invalid item holds the entire refresh for review. */
export function extractSourceConnection(
  rawConfig: SourceConnectionConfig,
  body: Buffer | string,
  contentType: string,
): SourceConnectionExtraction {
  try {
    const config = SourceConnectionConfigSchema.parse(rawConfig)
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
    if (bytes.byteLength > SOURCE_CONNECTION_LIMITS.maxBodyBytes) refuse('BODY_TOO_LARGE')
    const records: SourceConnectionRecord[] = []
    let htmlTree: Node | undefined
    let json: unknown
    for (const mapping of config.mappings) {
      if (mapping.type === 'html') {
        if (!/^text\/html(?:\s*;|$)|^application\/xhtml\+xml(?:\s*;|$)/iu.test(contentType))
          refuse('CONTENT_TYPE_MISMATCH')
        htmlTree ??= parseHtml(bytes.toString('utf8'))
        const rows = select(htmlTree, mapping.recordSelector)
        if (rows.length === 0 || rows.length > config.validation.maxRecords)
          refuse('RECORD_STRUCTURE_DRIFT')
        const pageDateText = mapping.pageDate
          ? requiredMapped(field(htmlTree, mapping.pageDate))
          : undefined
        const pageDate = pageDateText
          ? parseDate(
              pageDateText,
              /^\d{4}-\d{2}-\d{2}$/u.test(pageDateText) ? 'iso' : 'english_month_day_year',
            )
          : undefined
        const yearAnchor = pageDate ? Number(pageDate.slice(0, 4)) : undefined
        for (const row of rows) {
          records.push(
            parseRecord(
              {
                id: field(row, mapping.id),
                kind: mapping.kind,
                title: field(row, mapping.title),
                text: field(row, mapping.text),
                startDate: mapping.startDate ? field(row, mapping.startDate) : pageDate,
                endDate: mapping.endDate ? field(row, mapping.endDate) : undefined,
                showtimes: mapping.showtime ? field(row, mapping.showtime) : undefined,
                showtimeEnds: mapping.showtimeEnd ? field(row, mapping.showtimeEnd) : undefined,
                cancelled: mapping.cancelled
                  ? requiredMapped(field(row, mapping.cancelled))
                  : undefined,
                links: mapping.link ? field(row, mapping.link) : undefined,
                dateFormat: mapping.startDate ? mapping.dateFormat : 'iso',
                yearAnchor,
                ...(mapping.fixedEndDate ? { fixedEndDate: mapping.fixedEndDate } : {}),
                allowCrossMidnight: mapping.allowCrossMidnight,
              },
              config,
            ),
          )
        }
      } else {
        if (!/^application\/(?:json|feed\+json|jsonfeed\+json)(?:\s*;|$)/iu.test(contentType))
          refuse('CONTENT_TYPE_MISMATCH')
        json ??= JSON.parse(bytes.toString('utf8')) as unknown
        const rows = readPointer(json, mapping.itemsPointer)
        if (!Array.isArray(rows) || rows.length === 0 || rows.length > config.validation.maxRecords)
          refuse('RECORD_STRUCTURE_DRIFT')
        for (const row of rows) {
          records.push(
            parseRecord(
              {
                id: readPointer(row, mapping.idPointer),
                kind: mapping.kind,
                title: readPointer(row, mapping.titlePointer),
                text: readPointer(row, mapping.textPointer),
                startDate: mapping.startDatePointer
                  ? readPointer(row, mapping.startDatePointer)
                  : undefined,
                endDate: mapping.endDatePointer
                  ? readPointer(row, mapping.endDatePointer)
                  : undefined,
                showtimes: mapping.showtimesPointer
                  ? readPointer(row, mapping.showtimesPointer)
                  : undefined,
                showtimeEnds: mapping.showtimeEndsPointer
                  ? readPointer(row, mapping.showtimeEndsPointer)
                  : undefined,
                cancelled: mapping.cancelledPointer
                  ? requiredMapped(readPointer(row, mapping.cancelledPointer))
                  : undefined,
                exceptions: mapping.exceptionsPointer
                  ? requiredMapped(readPointer(row, mapping.exceptionsPointer))
                  : undefined,
                links: mapping.linksPointer ? readPointer(row, mapping.linksPointer) : undefined,
                dateFormat: mapping.dateFormat,
                ...(mapping.fixedEndDate ? { fixedEndDate: mapping.fixedEndDate } : {}),
              },
              config,
            ),
          )
        }
      }
    }
    if (
      records.length < config.validation.minRecords ||
      records.length > config.validation.maxRecords ||
      records.length > SOURCE_CONNECTION_LIMITS.maxRecords
    )
      refuse('RECORD_COUNT_DRIFT')
    const byId = new Map<string, SourceConnectionRecord>()
    for (const record of records) {
      const previous = byId.get(record.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(record))
        refuse('DUPLICATE_RECORD_CONFLICT')
      byId.set(record.id, record)
    }
    if (byId.size < config.validation.minRecords) refuse('RECORD_COUNT_DRIFT')
    return {
      status: 'VALID',
      records: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
      issues: [],
    }
  } catch (error) {
    const code = error instanceof ExtractionError ? error.code : 'STRUCTURE_INVALID'
    return { status: 'REVIEW_REQUIRED', records: [], issues: [code] }
  }
}
