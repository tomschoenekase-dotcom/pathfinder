import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { operatorUntrustedText } from '../crm-projection'
import { buildOperatorReadScope, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'

const PAGE_SIZE = 25

/**
 * The existing MCP support read is per venue, has no status filter and no tenant-wide form, so
 * this query is written directly. Its tenant predicate is explicit and the tenant is checked
 * against the grant by `buildOperatorReadScope` first.
 */
const supportList: OperatorReadTool = {
  name: 'support.list',
  capability: 'support:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['support.list'].parse(raw)
    const scope = await buildOperatorReadScope(
      context.grant,
      input.tenantId,
      ['support:read'],
      context.database,
    )
    if (input.venueId !== undefined && !scope.venueIds.includes(input.venueId)) {
      throw new OperatorNotFoundError()
    }
    const rows = await context.database.supportRequest.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.venueId !== undefined ? { venueId: input.venueId } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      // Message bodies, participants and artifacts are never selected.
      select: { id: true, venueId: true, status: true, subject: true, updatedAt: true },
    })
    const page = rows.slice(0, PAGE_SIZE)
    return {
      items: page.map((row) => ({
        requestId: row.id,
        venueId: row.venueId,
        status: row.status,
        // Support requests store no priority; every request reads as NORMAL until one exists.
        priority: 'NORMAL' as const,
        updatedAt: row.updatedAt.toISOString(),
        subject: operatorUntrustedText(row.subject),
      })),
      nextCursor: rows.length > PAGE_SIZE ? page.at(-1)!.id : null,
    }
  },
}

export const supportReadTools: readonly OperatorReadTool[] = [supportList]
