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

export const updateReadTools: readonly OperatorReadTool[] = [listOperationalUpdates]
