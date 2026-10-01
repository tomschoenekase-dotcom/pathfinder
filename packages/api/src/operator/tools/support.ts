import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { operatorUntrustedText, redactAddresses } from '../crm-projection'
import { assertTenantInGrant, buildOperatorReadScope, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  OperatorInvalidCursorError,
  pageResult,
} from './page'

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

const MESSAGE_BODY_MAX = 8_000

const supportGetRequest: OperatorReadTool = {
  name: 'support.get_request',
  capability: 'support:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['support.get_request'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const database = context.database
    const request = await database.supportRequest.findFirst({
      where: { id: input.requestId, tenantId: input.tenantId },
      include: {
        _count: {
          select: { packageHandoffs: true, previewFeedback: true, knowledgeChangeProposals: true },
        },
      },
    })
    if (!request) throw new OperatorNotFoundError()
    const [total, internalNotes, latest] = await Promise.all([
      database.supportMessage.count({
        where: { supportRequestId: request.id, tenantId: input.tenantId },
      }),
      database.supportMessage.count({
        where: {
          supportRequestId: request.id,
          tenantId: input.tenantId,
          visibility: 'INTERNAL_ONLY',
        },
      }),
      database.supportMessage.findFirst({
        where: { supportRequestId: request.id, tenantId: input.tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { authorKind: true, visibility: true, createdAt: true },
      }),
    ])
    return {
      requestId: request.id,
      tenantId: request.tenantId,
      venueId: request.venueId,
      category: request.category,
      status: request.status,
      subject: operatorUntrustedText(request.subject),
      missingInformation: request.missingInformation
        .slice(0, 30)
        .map((item) => operatorUntrustedText(item)),
      version: request.version,
      clientVersion: request.clientVersion,
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt.toISOString(),
      statusChangedAt: request.statusChangedAt.toISOString(),
      clientActivityAt: request.clientActivityAt.toISOString(),
      createdByKind: request.createdByKind,
      messages: { total, internalNotes, clientVisible: total - internalNotes },
      latestMessage: latest
        ? {
            authorKind: latest.authorKind,
            visibility: latest.visibility,
            createdAt: latest.createdAt.toISOString(),
          }
        : null,
      linked: {
        packageHandoffs: request._count.packageHandoffs,
        previewFeedback: request._count.previewFeedback,
        knowledgeProposals: request._count.knowledgeChangeProposals,
      },
    }
  },
}

const supportListMessages: OperatorReadTool = {
  name: 'support.list_messages',
  capability: 'support:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['support.list_messages'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const database = context.database
    const request = await database.supportRequest.findFirst({
      where: { id: input.requestId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (!request) throw new OperatorNotFoundError()
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    if (after) {
      const anchor = await database.supportMessage.findFirst({
        where: { id: after.id, supportRequestId: request.id, tenantId: input.tenantId },
        select: { id: true },
      })
      if (!anchor) throw new OperatorInvalidCursorError()
    }
    const rows = await database.supportMessage.findMany({
      where: {
        supportRequestId: request.id,
        tenantId: input.tenantId,
        ...(after
          ? {
              OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        authorKind: true,
        visibility: true,
        body: true,
        requestVersion: true,
        completionOutcome: true,
        createdAt: true,
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((message) => ({
        messageId: message.id,
        authorKind: message.authorKind,
        visibility: message.visibility,
        createdAt: message.createdAt.toISOString(),
        requestVersion: message.requestVersion,
        completionOutcome: message.completionOutcome,
        // Message text is data, never instructions, and no address in it is repeated back.
        body: operatorUntrustedText(redactAddresses(message.body), MESSAGE_BODY_MAX),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.createdAt, page.at(-1)!.id)
        : null,
    )
  },
}

export const supportReadTools: readonly OperatorReadTool[] = [
  supportList,
  supportGetRequest,
  supportListMessages,
]
