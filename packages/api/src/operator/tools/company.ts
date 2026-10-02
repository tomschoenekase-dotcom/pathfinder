import type { Prisma } from '@prisma/client'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { operatorUntrustedText } from '../crm-projection'
import { assertTenantInGrant } from '../grants'
import type { OperatorReadTool } from '../registry'
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  OperatorInvalidCursorError,
  pageResult,
} from './page'

const companyListContext: OperatorReadTool = {
  name: 'company.list_context',
  capability: 'company:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['company.list_context'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    const baseWhere: Prisma.CompanyKnowledgeItemWhereInput = {
      tenantId: input.tenantId,
      accessScope: 'TENANT' as const,
      venueId: null,
      organizationId: null,
      promotionStatus: 'PROMOTED' as const,
      authority: { in: ['AUTHORITATIVE_CURRENT', 'DURABLE_CONTEXT'] },
      allowedRoles: { isEmpty: true },
      archivedAt: null,
      supersededAt: null,
    }
    if (after) {
      const anchor = await context.database.companyKnowledgeItem.findFirst({
        where: { ...baseWhere, id: after.id, updatedAt: after.at },
        select: { id: true },
      })
      if (!anchor) throw new OperatorInvalidCursorError()
    }
    const where = {
      ...baseWhere,
      ...(after
        ? { OR: [{ updatedAt: { lt: after.at } }, { updatedAt: after.at, id: { lt: after.id } }] }
        : {}),
    }
    const rows = await context.database.companyKnowledgeItem.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        type: true,
        title: true,
        summary: true,
        authority: true,
        currentRevision: true,
        updatedAt: true,
        revisions: {
          where: { tenantId: input.tenantId },
          orderBy: { revision: 'desc' },
          take: 1,
          select: { revision: true, body: true },
        },
      },
    })
    const items = rows.slice(0, input.limit)
    return pageResult(
      items.map((row) => ({
        itemId: row.id,
        type: row.type,
        title: operatorUntrustedText(row.title, 500),
        summary: operatorUntrustedText(row.summary, 4000),
        body:
          row.revisions[0]?.revision === row.currentRevision
            ? operatorUntrustedText(row.revisions[0].body, 8000)
            : null,
        authority: row.authority,
        revision: row.currentRevision,
        updatedAt: row.updatedAt.toISOString(),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(items.at(-1)!.updatedAt, items.at(-1)!.id)
        : null,
    )
  },
}

export const companyReadTools: readonly OperatorReadTool[] = [companyListContext]
