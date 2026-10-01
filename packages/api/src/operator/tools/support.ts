import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { operatorUntrustedText } from '../crm-projection'
import { buildOperatorReadScope, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'
import { decodeKeysetCursor, encodeKeysetCursor, pageResult } from './page'

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
    const base = {
      tenantId: input.tenantId,
      ...(input.venueId !== undefined ? { venueId: input.venueId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    }
    // Newest first with a (updatedAt, id) keyset, so equal timestamps neither repeat nor skip.
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    const rows = await context.database.supportRequest.findMany({
      where: {
        ...base,
        ...(after
          ? {
              OR: [{ updatedAt: { lt: after.at } }, { updatedAt: after.at, id: { lt: after.id } }],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      // Message bodies, participants and artifacts are never selected.
      select: { id: true, venueId: true, status: true, subject: true, updatedAt: true },
    })
    const page = rows.slice(0, PAGE_SIZE)
    return pageResult(
      page.map((row) => ({
        requestId: row.id,
        venueId: row.venueId,
        status: row.status,
        // Support requests store no priority. Report that honestly rather than a defaulted NORMAL.
        priority: null,
        updatedAt: row.updatedAt.toISOString(),
        subject: operatorUntrustedText(row.subject),
      })),
      rows.length > PAGE_SIZE ? encodeKeysetCursor(page.at(-1)!.updatedAt, page.at(-1)!.id) : null,
    )
  },
}

export const supportReadTools: readonly OperatorReadTool[] = [supportList]
