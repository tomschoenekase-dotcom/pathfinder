import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorCallContext, OperatorReadTool } from '../registry'
import { untrusted } from '../content-view'
import { pageResult, requireCursorInScope } from './page'

const PAGE_SIZE = 25
const PREVIEW_CHARS = 300

type SourceRow = NonNullable<
  Awaited<ReturnType<OperatorCallContext['database']['venueSource']['findFirst']>>
>

const DISPOSITIONS = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'UNSUPPORTED', 'SKIPPED'] as const

function summary(row: SourceRow, counts: Map<string, number>) {
  return {
    sourceId: row.id,
    venueId: row.venueId,
    url: row.requestUrl,
    host: row.host,
    status: row.status,
    note: row.note ? untrusted(row.note, 500) : null,
    maxPages: row.maxPages,
    maxBytesPerPage: row.maxBytesPerPage,
    parserVersion: row.parserVersion,
    attempts: row.attempts,
    errorCode: row.errorCode,
    requestedAt: row.requestedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    counts: Object.fromEntries(
      DISPOSITIONS.map((disposition) => [disposition, counts.get(`${row.id}:${disposition}`) ?? 0]),
    ) as Record<(typeof DISPOSITIONS)[number], number>,
  }
}

async function dispositionCounts(
  database: OperatorCallContext['database'],
  scope: { tenantId: string; venueId: string },
  sourceIds: readonly string[],
) {
  const counts = new Map<string, number>()
  if (sourceIds.length === 0) return counts
  const rows = await database.venueSourceInput.groupBy({
    by: ['sourceId', 'disposition'],
    where: { tenantId: scope.tenantId, venueId: scope.venueId, sourceId: { in: [...sourceIds] } },
    _count: { _all: true },
  })
  for (const row of rows) counts.set(`${row.sourceId}:${row.disposition}`, row._count._all)
  return counts
}

const venuesListSources: OperatorReadTool = {
  name: 'venues.list_sources',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.list_sources'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const scope = { tenantId: input.tenantId, venueId: input.venueId }
    await requireCursorInScope(input.cursor, (id) =>
      context.database.venueSource.findFirst({ where: { id, ...scope }, select: { id: true } }),
    )
    const rows = await context.database.venueSource.findMany({
      where: scope,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(input.limit, PAGE_SIZE) + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    })
    const limit = Math.min(input.limit, PAGE_SIZE)
    const page = rows.slice(0, limit)
    const counts = await dispositionCounts(
      context.database,
      scope,
      page.map((row) => row.id),
    )
    return pageResult(
      page.map((row) => summary(row, counts)),
      rows.length > limit ? page.at(-1)!.id : null,
    )
  },
}

const venuesGetSource: OperatorReadTool = {
  name: 'venues.get_source',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.get_source'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const scope = { tenantId: input.tenantId, venueId: input.venueId }
    const row = await context.database.venueSource.findFirst({
      where: { id: input.sourceId, ...scope },
    })
    if (!row) throw new OperatorNotFoundError()
    const inputs = await context.database.venueSourceInput.findMany({
      where: { sourceId: row.id, ...scope },
      orderBy: { ordinal: 'asc' },
      take: 40,
    })
    const counts = await dispositionCounts(context.database, scope, [row.id])
    const chosen =
      input.textOrdinal === undefined
        ? null
        : (inputs.find((entry) => entry.ordinal === input.textOrdinal) ?? null)
    return {
      source: summary(row, counts),
      inputs: inputs.map((entry) => ({
        ordinal: entry.ordinal,
        requestedUrl: entry.requestedUrl,
        finalUrl: entry.finalUrl,
        redirectChain: (Array.isArray(entry.redirectChain) ? entry.redirectChain : []).slice(
          0,
          10,
        ) as Array<{
          from: string
          to: string
          status: number
        }>,
        disposition: entry.disposition,
        reasonCode: entry.reasonCode,
        httpStatus: entry.httpStatus,
        contentType: entry.contentType,
        byteSize: entry.byteSize,
        contentHash: entry.contentHash,
        retrievedAt: entry.retrievedAt.toISOString(),
        parserVersion: entry.parserVersion,
        textTruncated: entry.textTruncated,
        // Captured text comes from an outside page: a short preview, always marked untrusted.
        textPreview: entry.extractedText ? untrusted(entry.extractedText, PREVIEW_CHARS) : null,
      })),
      text: chosen
        ? {
            ordinal: chosen.ordinal,
            content: untrusted(chosen.extractedText ?? '', 20_000),
          }
        : null,
    }
  },
}

export const venueSourceReadTools: readonly OperatorReadTool[] = [
  venuesListSources,
  venuesGetSource,
]
