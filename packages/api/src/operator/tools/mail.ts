import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { operatorUntrustedText, redactAddresses } from '../crm-projection'
import { assertTenantInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'
import { decodeKeysetCursor, encodeKeysetCursor, pageResult, requireCursorInScope } from './page'

export const tenantOrganizationWhere = (tenantId: string) => ({
  // Prospect CRM rows have no tenantId column. Their canonical tenant ownership comes from
  // a conversion or a customer relationship; keep this predicate on every platform row read.
  OR: [{ conversion: { is: { tenantId } } }, { customerRelationships: { some: { tenantId } } }],
})

const mailboxes: OperatorReadTool = {
  name: 'crm.list_mailboxes',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_mailboxes'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const org = tenantOrganizationWhere(input.tenantId)
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.correspondenceProviderAccount.findFirst({
        where: { id, threadMappings: { some: { thread: { organization: org } } } },
        select: { id: true },
      }),
    )
    const rows = await context.database.correspondenceProviderAccount.findMany({
      where: {
        threadMappings: { some: { thread: { organization: org } } },
        ...(after
          ? { OR: [{ updatedAt: { lt: after.at } }, { updatedAt: after.at, id: { lt: after.id } }] }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        provider: true,
        mailboxAddress: true,
        displayName: true,
        connectionStatus: true,
        capabilities: true,
        lastSuccessfulSyncAt: true,
        lastHealthCheckAt: true,
        healthErrorCode: true,
        healthErrorSummary: true,
        updatedAt: true,
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        mailboxId: row.id,
        provider: row.provider,
        mailboxAddress: row.mailboxAddress,
        displayName: row.displayName
          ? operatorUntrustedText(redactAddresses(row.displayName))
          : null,
        connectionStatus: row.connectionStatus,
        capabilities: row.capabilities,
        lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
        lastHealthCheckAt: row.lastHealthCheckAt?.toISOString() ?? null,
        healthErrorCode: row.healthErrorCode,
        healthErrorSummary: row.healthErrorSummary
          ? operatorUntrustedText(redactAddresses(row.healthErrorSummary), 1000)
          : null,
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.updatedAt, page.at(-1)!.id)
        : null,
    )
  },
}

const mailThreads: OperatorReadTool = {
  name: 'crm.list_mail_threads',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_mail_threads'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.prospectEmailThread.findFirst({
        where: { id, organization: tenantOrganizationWhere(input.tenantId) },
        select: { id: true },
      }),
    )
    const rows = await context.database.prospectEmailThread.findMany({
      where: {
        organization: tenantOrganizationWhere(input.tenantId),
        ...(after
          ? { OR: [{ updatedAt: { lt: after.at } }, { updatedAt: after.at, id: { lt: after.id } }] }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        organizationId: true,
        venueId: true,
        contactId: true,
        subject: true,
        lastMessageAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
        providerMappings: {
          where: { providerAccount: { provider: 'GMAIL' } },
          take: 21,
          orderBy: { id: 'asc' },
          select: { providerAccountId: true, providerThreadId: true },
        },
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        threadId: row.id,
        gmailThreads: row.providerMappings.slice(0, 20).map((mapping) => ({
          gmailMailboxId: mapping.providerAccountId,
          gmailThreadId: mapping.providerThreadId,
        })),
        gmailThreadsTruncated: row.providerMappings.length > 20,
        organizationId: row.organizationId,
        venueId: row.venueId,
        contactId: row.contactId,
        subject: row.subject === null ? null : operatorUntrustedText(redactAddresses(row.subject)),
        messageCount: row._count.messages,
        lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.updatedAt, page.at(-1)!.id)
        : null,
    )
  },
}

const mailMessages: OperatorReadTool = {
  name: 'crm.list_mail_messages',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_mail_messages'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const thread = await context.database.prospectEmailThread.findFirst({
      where: { id: input.threadId, organization: tenantOrganizationWhere(input.tenantId) },
      select: { id: true },
    })
    if (!thread) throw new OperatorNotFoundError()
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.prospectEmailMessage.findFirst({
        where: { id, threadId: thread.id, organization: tenantOrganizationWhere(input.tenantId) },
        select: { id: true },
      }),
    )
    const rows = await context.database.prospectEmailMessage.findMany({
      where: {
        threadId: thread.id,
        organization: tenantOrganizationWhere(input.tenantId),
        ...(after
          ? {
              OR: [
                { occurredAt: { lt: after.at } },
                { occurredAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        direction: true,
        status: true,
        toAddresses: true,
        subject: true,
        textBody: true,
        bodyPreview: true,
        bodyRetentionState: true,
        occurredAt: true,
        providerAccountId: true,
        providerMessageId: true,
        providerAccount: { select: { provider: true } },
        thread: {
          select: {
            providerMappings: {
              where: { providerAccount: { provider: 'GMAIL' } },
              select: { providerAccountId: true, providerThreadId: true },
            },
          },
        },
        events: {
          where: { eventType: 'DELIVERED' },
          orderBy: { occurredAt: 'desc' },
          take: 1,
          select: { occurredAt: true },
        },
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => {
        const body = row.textBody ?? row.bodyPreview
        return {
          messageId: row.id,
          gmailMailboxId: row.providerAccount?.provider === 'GMAIL' ? row.providerAccountId : null,
          gmailMessageId: row.providerAccount?.provider === 'GMAIL' ? row.providerMessageId : null,
          gmailThreadId:
            row.providerAccount?.provider === 'GMAIL'
              ? (row.thread.providerMappings.find(
                  (mapping) => mapping.providerAccountId === row.providerAccountId,
                )?.providerThreadId ?? null)
              : null,
          verifiedDeliveredAt: row.events[0]?.occurredAt.toISOString() ?? null,
          direction: row.direction,
          status: row.status,
          participantCount: row.toAddresses.length + 1,
          subject: operatorUntrustedText(redactAddresses(row.subject)),
          body: body ? operatorUntrustedText(redactAddresses(body), 8000) : null,
          bodyRetentionState: row.bodyRetentionState,
          occurredAt: row.occurredAt.toISOString(),
        }
      }),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.occurredAt, page.at(-1)!.id)
        : null,
    )
  },
}

const mailReceipts: OperatorReadTool = {
  name: 'crm.list_mail_receipts',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_mail_receipts'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.prospectEmailEvent.findFirst({
        where: {
          id,
          emailMessage: { is: { organization: tenantOrganizationWhere(input.tenantId) } },
        },
        select: { id: true },
      }),
    )
    const rows = await context.database.prospectEmailEvent.findMany({
      where: {
        emailMessage: { is: { organization: tenantOrganizationWhere(input.tenantId) } },
        ...(after
          ? {
              OR: [
                { occurredAt: { lt: after.at } },
                { occurredAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        emailMessageId: true,
        providerEventId: true,
        eventType: true,
        occurredAt: true,
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.flatMap((row) =>
        row.emailMessageId
          ? [
              {
                receiptId: row.id,
                messageId: row.emailMessageId,
                providerEventId: operatorUntrustedText(row.providerEventId),
                eventType: operatorUntrustedText(row.eventType),
                occurredAt: row.occurredAt.toISOString(),
              },
            ]
          : [],
      ),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.occurredAt, page.at(-1)!.id)
        : null,
    )
  },
}

const activityReceipts: OperatorReadTool = {
  name: 'crm.list_activity_receipts',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_activity_receipts'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const tenantOrg = tenantOrganizationWhere(input.tenantId)
    const where = { organization: tenantOrg, externalReceiptKey: { not: null } }
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.prospectActivity.findFirst({
        where: { ...where, id },
        select: { id: true },
      }),
    )
    const rows = await context.database.prospectActivity.findMany({
      where: {
        ...where,
        ...(after
          ? {
              OR: [
                { occurredAt: { lt: after.at } },
                { occurredAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        organizationId: true,
        type: true,
        externalReceiptKey: true,
        occurredAt: true,
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        activityId: row.id,
        organizationId: row.organizationId,
        activityType: row.type,
        externalReceiptKey: operatorUntrustedText(row.externalReceiptKey!),
        occurredAt: row.occurredAt.toISOString(),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.occurredAt, page.at(-1)!.id)
        : null,
    )
  },
}

/**
 * Quarantine and webhook receipts have no tenant owner, so they are platform data: only a
 * connection that reaches every customer may read them. Raw payloads and message snapshots are
 * never returned; the sender's words are marked untrusted like any other retrieved text.
 */
function requirePlatformReach(context: Parameters<OperatorReadTool['handler']>[1]) {
  if (!context.grant.allTenants) throw new OperatorNotFoundError()
}

const mailQuarantine: OperatorReadTool = {
  name: 'crm.list_mail_quarantine',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_mail_quarantine'].parse(raw)
    requirePlatformReach(context)
    const base = input.status ? { status: input.status } : {}
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.prospectInboundQuarantine.findFirst({
        where: { ...base, id, occurredAt: after!.at },
        select: { id: true },
      }),
    )
    const rows = await context.database.prospectInboundQuarantine.findMany({
      where: {
        ...base,
        ...(after
          ? {
              OR: [
                { occurredAt: { lt: after.at } },
                { occurredAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        reason: true,
        detail: true,
        status: true,
        providerAccountId: true,
        receiptId: true,
        candidateThreadIds: true,
        occurredAt: true,
        resolvedAt: true,
        resolvedBy: true,
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        quarantineId: row.id,
        reason: row.reason,
        detail: operatorUntrustedText(redactAddresses(row.detail)),
        status: row.status,
        mailboxId: row.providerAccountId,
        receiptId: row.receiptId,
        candidateThreadCount: row.candidateThreadIds.length,
        occurredAt: row.occurredAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        resolvedBy: row.resolvedBy === null ? null : operatorUntrustedText(row.resolvedBy),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.occurredAt, page.at(-1)!.id)
        : null,
    )
  },
}

const mailWebhookReceipts: OperatorReadTool = {
  name: 'crm.list_mail_webhook_receipts',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_mail_webhook_receipts'].parse(raw)
    requirePlatformReach(context)
    const base = input.status ? { status: input.status } : {}
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      context.database.prospectEmailWebhookReceipt.findFirst({
        where: { ...base, id, createdAt: after!.at },
        select: { id: true },
      }),
    )
    const rows = await context.database.prospectEmailWebhookReceipt.findMany({
      where: {
        ...base,
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
        provider: true,
        providerAccountId: true,
        providerEventId: true,
        eventType: true,
        status: true,
        attemptCount: true,
        nextAttemptAt: true,
        quarantineReason: true,
        processingError: true,
        processedAt: true,
        createdAt: true,
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        receiptId: row.id,
        provider: row.provider,
        mailboxId: row.providerAccountId,
        providerEventId: operatorUntrustedText(row.providerEventId),
        eventType: operatorUntrustedText(row.eventType),
        status: row.status,
        attemptCount: row.attemptCount,
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
        quarantineReason:
          row.quarantineReason === null
            ? null
            : operatorUntrustedText(redactAddresses(row.quarantineReason)),
        processingError:
          row.processingError === null
            ? null
            : operatorUntrustedText(redactAddresses(row.processingError)),
        processedAt: row.processedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.createdAt, page.at(-1)!.id)
        : null,
    )
  },
}

export const mailReadTools: readonly OperatorReadTool[] = [
  mailQuarantine,
  mailWebhookReceipts,
  mailboxes,
  mailThreads,
  mailMessages,
  mailReceipts,
  activityReceipts,
]
