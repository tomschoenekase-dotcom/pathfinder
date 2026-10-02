import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { operatorUntrustedText } from '../crm-projection'
import { assertTenantInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  OperatorInvalidCursorError,
  pageResult,
} from './page'

const reportsList: OperatorReadTool = {
  name: 'reports.list',
  capability: 'reports:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['reports.list'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const baseWhere = {
      tenantId: input.tenantId,
      ...(input.venueId ? { venueId: input.venueId } : {}),
    }
    if (input.venueId) {
      const venue = await context.database.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true },
      })
      if (!venue) throw new OperatorNotFoundError()
    }
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    const where = {
      ...baseWhere,
      ...(after
        ? { OR: [{ weekStart: { lt: after.at } }, { weekStart: after.at, id: { lt: after.id } }] }
        : {}),
    }
    if (after) {
      const anchor = await context.database.weeklyReport.findFirst({
        where: { ...baseWhere, id: after.id, weekStart: after.at },
        select: { id: true },
      })
      if (!anchor) throw new OperatorInvalidCursorError()
    }
    const rows = await context.database.weeklyReport.findMany({
      where,
      orderBy: [{ weekStart: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        venueId: true,
        weekStart: true,
        weekEnd: true,
        status: true,
        title: true,
        content: true,
        answerCount: true,
        sessionCount: true,
        generatedAt: true,
        publishedAt: true,
        updatedAt: true,
      },
    })
    const items = rows.slice(0, input.limit)
    return pageResult(
      items.map((row) => ({
        reportId: row.id,
        venueId: row.venueId,
        weekStart: row.weekStart.toISOString(),
        weekEnd: row.weekEnd.toISOString(),
        status: row.status,
        title: operatorUntrustedText(row.title, 500),
        content: row.content === null ? null : operatorUntrustedText(row.content),
        answerCount: row.answerCount,
        sessionCount: row.sessionCount,
        generatedAt: row.generatedAt?.toISOString() ?? null,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(items.at(-1)!.weekStart, items.at(-1)!.id)
        : null,
    )
  },
}

const reportsGetStatus: OperatorReadTool = {
  name: 'reports.get_status',
  capability: 'reports:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['reports.get_status'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    if (input.venueId) {
      const venue = await context.database.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true },
      })
      if (!venue) throw new OperatorNotFoundError()
    }
    const where = {
      tenantId: input.tenantId,
      ...(input.venueId ? { venueId: input.venueId } : {}),
    }
    const [groups, latest, configurations, venueCount] = await Promise.all([
      context.database.weeklyReport.groupBy({ by: ['status'], where, _count: { _all: true } }),
      context.database.weeklyReport.findFirst({
        where,
        orderBy: [{ weekStart: 'desc' }, { id: 'desc' }],
        select: { id: true, weekStart: true, status: true, updatedAt: true },
      }),
      context.database.venueReportConfiguration.groupBy({
        by: ['enabled'],
        where: { tenantId: input.tenantId, ...(input.venueId ? { venueId: input.venueId } : {}) },
        _count: { _all: true },
      }),
      input.venueId
        ? Promise.resolve(1)
        : context.database.venue.count({ where: { tenantId: input.tenantId } }),
    ])
    const reportCount = (status: string) =>
      groups.find((group) => group.status === status)?._count._all ?? 0
    const configCount = (enabled: boolean) =>
      configurations.find((group) => group.enabled === enabled)?._count._all ?? 0
    return {
      tenantId: input.tenantId,
      reportCounts: {
        generating: reportCount('GENERATING'),
        draft: reportCount('DRAFT'),
        published: reportCount('PUBLISHED'),
        failed: reportCount('FAILED'),
      },
      latest: latest
        ? {
            reportId: latest.id,
            weekStart: latest.weekStart.toISOString(),
            status: latest.status,
            updatedAt: latest.updatedAt.toISOString(),
          }
        : null,
      configurations: {
        enabled: configCount(true),
        disabled: Math.max(0, venueCount - configCount(true)),
      },
    }
  },
}

export const reportReadTools: readonly OperatorReadTool[] = [reportsList, reportsGetStatus]
