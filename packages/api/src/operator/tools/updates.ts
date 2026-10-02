import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { buildOperationalUpdatePreview } from '@pathfinder/db'

import { operatorUntrustedText } from '../crm-projection'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'
import { decodeKeysetCursor, encodeKeysetCursor, pageResult, requireCursorInScope } from './page'

/** A venue's visitor notices with what visitors see right now and the version writes expect. */
const listOperationalUpdates: OperatorReadTool = {
  name: 'venues.list_operational_updates',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.list_operational_updates'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const database = context.database
    const base = {
      tenantId: input.tenantId,
      venueId: input.venueId,
      ...(input.status ? { status: input.status } : {}),
    }
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      database.operationalUpdate.findFirst({
        where: { ...base, id, updatedAt: after!.at },
        select: { id: true },
      }),
    )
    const rows = await database.operationalUpdate.findMany({
      where: {
        ...base,
        ...(after
          ? {
              OR: [{ updatedAt: { lt: after.at } }, { updatedAt: after.at, id: { lt: after.id } }],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        placeId: true,
        updateType: true,
        severity: true,
        priority: true,
        title: true,
        body: true,
        redirectTo: true,
        startsAt: true,
        expiresAt: true,
        status: true,
        isActive: true,
        updatedAt: true,
      },
    })
    if (rows.length === 0 && after === null) {
      // An empty first page is only trustworthy for a venue that exists in this tenant.
      const venue = await database.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true },
      })
      if (!venue) throw new OperatorNotFoundError()
    }
    const page = rows.slice(0, input.limit)
    const now = context.now
    return pageResult(
      page.map((row) => ({
        updateId: row.id,
        placeId: row.placeId,
        updateType: row.updateType,
        severity: row.severity,
        priority: row.priority,
        title: operatorUntrustedText(row.title),
        body: row.body === null ? null : operatorUntrustedText(row.body),
        redirectTo: row.redirectTo === null ? null : operatorUntrustedText(row.redirectTo),
        startsAt: row.startsAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        status: row.status,
        isActive: row.isActive,
        lifecycle: buildOperationalUpdatePreview(row, now).lifecycle,
        updatedAt: row.updatedAt.toISOString(),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.updatedAt, page.at(-1)!.id)
        : null,
    )
  },
}

const DAY_MS = 86_400_000

/** Counts only, from the same tables the admin analytics page reads. No visitor text leaves. */
const getVisitorSummary: OperatorReadTool = {
  name: 'venues.get_visitor_summary',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.get_visitor_summary'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const database = context.database
    const windowStart = new Date(context.now.getTime() - input.days * DAY_MS)
    const sessionWhere = {
      tenantId: input.tenantId,
      venueId: input.venueId,
      experienceScope: 'PUBLIC',
      startedAt: { gte: windowStart },
    }
    const messageWhere = {
      tenantId: input.tenantId,
      venueId: input.venueId,
      role: 'user' as const,
      createdAt: { gte: windowStart },
      session: { experienceScope: 'PUBLIC' },
    }
    const [venue, sessions, visitorMessages, visitors, last, topics, unclassified] =
      await Promise.all([
        database.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        }),
        database.visitorSession.count({ where: sessionWhere }),
        database.message.count({ where: messageWhere }),
        database.visitorSession.findMany({
          where: { ...sessionWhere, visitorId: { not: null } },
          select: { visitorId: true },
          distinct: ['visitorId'],
        }),
        database.message.findFirst({
          where: messageWhere,
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        database.message.groupBy({
          by: ['topic'],
          where: { ...messageWhere, topic: { not: null } },
          _count: { _all: true },
          orderBy: { _count: { topic: 'desc' } },
          take: 10,
        }),
        database.message.count({ where: { ...messageWhere, topic: null } }),
      ])
    if (!venue) throw new OperatorNotFoundError()
    return {
      tenantId: input.tenantId,
      venueId: input.venueId,
      days: input.days,
      windowStart: windowStart.toISOString(),
      sessions,
      visitorMessages,
      uniqueVisitors: visitors.length,
      lastVisitorMessageAt: last?.createdAt.toISOString() ?? null,
      topTopics: topics.flatMap((row) =>
        row.topic === null ? [] : [{ topic: row.topic, messages: row._count._all }],
      ),
      unclassifiedMessages: unclassified,
    }
  },
}

export const updateReadTools: readonly OperatorReadTool[] = [
  listOperationalUpdates,
  getVisitorSummary,
]
