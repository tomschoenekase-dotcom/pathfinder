import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { writeAuditLogStrict } from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { OperatorNotFoundError } from '../grants'
import type { OperatorApplyContext, OperatorKindContext, OperatorProposalKind } from '../proposals'

const input = OPERATOR_MCP_INPUTS['crm.log_outreach_sent']
const SENT_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000
type LogArgs = ReturnType<typeof input.parse>

/**
 * Records in the CRM history that an email went out from Gmail. It writes one ProspectActivity row
 * and nothing else: the Gmail connector sent the email, Torchiko sent nothing, and the ProspectSend
 * tables are never touched. There is no canonical domain action for this; the CRM's own timeline
 * write (ProspectActivity, as noteworthy events elsewhere do) is the record.
 */
/**
 * The provider-namespaced identity of the message: provider, mailbox, provider message id. The
 * database holds it unique, so two writers logging the same message cannot both succeed. A log
 * without a mailbox is namespaced `unspecified`, matching how earlier rows were backfilled.
 */
export function outreachReceiptKey(args: Pick<LogArgs, 'gmailMessageId' | 'mailbox'>): string {
  return `gmail:${args.mailbox ?? 'unspecified'}:${args.gmailMessageId}`
}

async function findLogged(database: OperatorDatabase, args: LogArgs) {
  return database.prospectActivity.findFirst({
    where: {
      OR: [
        { externalReceiptKey: outreachReceiptKey(args) },
        // Rows written before receipts existed carry the id only in their evidence.
        {
          organizationId: args.organizationId,
          type: 'OUTREACH_SENT',
          evidence: { path: ['gmailMessageId'], equals: args.gmailMessageId },
        },
      ],
    },
    select: { id: true, occurredAt: true, organizationId: true },
  })
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  )
}

export const crmOutreachLogKind: OperatorProposalKind<LogArgs> = {
  kind: 'crm.outreach-log',
  tool: 'crm.log_outreach_sent',
  capability: 'crm:log',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ ref: args.organizationId }),
  authorize: async (args, context: OperatorKindContext) => {
    const contact = await context.database.prospectContact.findFirst({
      where: {
        id: args.contactId,
        organizationId: args.organizationId,
        organization: { archivedAt: null },
      },
      select: { id: true },
    })
    if (!contact) throw new OperatorNotFoundError()
    // The same provider message cannot be claimed by two organizations.
    const claimed = await findLogged(context.database, args)
    if (claimed && claimed.organizationId !== args.organizationId) {
      throw Object.assign(new Error('This message is already logged for another organization.'), {
        code: 'RECEIPT_CONFLICT',
      })
    }
    // A send cannot be logged ahead of time; a future date would hide the org from follow-ups.
    if (new Date(args.sentAt).getTime() > Date.now() + SENT_AT_FUTURE_TOLERANCE_MS) {
      throw Object.assign(new Error('sentAt is in the future.'), { code: 'SENT_AT_IN_FUTURE' })
    }
  },
  // Logging the same Gmail message twice is a no-op, so "already logged" is the version.
  targetVersion: async (args, context) =>
    (await findLogged(context.database, args)) ? 'logged' : 'unlogged',
  currentVersion: async (args, context) =>
    (await findLogged(context.database, args)) ? 'logged' : 'unlogged',
  describe: (args) => ({
    title: 'Record an email sent from Gmail in the CRM history',
    lines: [
      `organization ${args.organizationId}`,
      `contact ${args.contactId}`,
      `Gmail message ${args.gmailMessageId}`,
      `sent ${args.sentAt}`,
    ],
  }),
  snapshot: async (args, context) =>
    ({
      organizationId: args.organizationId,
      logged: (await findLogged(context.database, args)) !== null,
    }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const replayed = (existing: { id: string; organizationId: string }) => {
      // The same provider message is already recorded: never a second row, and never under a
      // different organization, which would be a different claim about who was emailed.
      if (existing.organizationId !== args.organizationId) {
        throw Object.assign(new Error('This message is already logged for another organization.'), {
          code: 'RECEIPT_CONFLICT',
        })
      }
      return {
        result: {
          activityId: existing.id,
          organizationId: args.organizationId,
          replayed: true,
          receipt: { key: outreachReceiptKey(args), verification: 'unverified' },
        },
        after: { activityId: existing.id, replayed: true },
      }
    }
    const existing = await findLogged(context.database, args)
    if (existing) return replayed(existing)
    const sentAt = new Date(args.sentAt)
    let activity: { id: string }
    try {
      activity = await context.database.$transaction(async (tx) => {
        const contact = await tx.prospectContact.findFirst({
          where: { id: args.contactId, organizationId: args.organizationId },
          select: { id: true, venueId: true },
        })
        if (!contact) throw new OperatorNotFoundError()
        const created = await tx.prospectActivity.create({
          data: {
            organizationId: args.organizationId,
            venueId: contact.venueId,
            contactId: contact.id,
            type: 'OUTREACH_SENT',
            summary: 'Outreach email sent from Gmail (logged by the operator)',
            evidence: {
              source: 'operator-gmail',
              gmailMessageId: args.gmailMessageId,
              ...(args.mailbox ? { mailbox: args.mailbox } : {}),
              sentAt: args.sentAt,
              proposalId: context.proposalId,
              // The operator reports the send; nothing has read the provider's copy back yet.
              verification: 'unverified',
            },
            externalReceiptKey: outreachReceiptKey(args),
            actorId: context.actor.id,
            occurredAt: sentAt,
          },
          select: { id: true },
        })
        // Last activity only moves forward. Logging an older send must not rewind the account.
        await tx.prospectOpportunity.updateMany({
          where: {
            organizationId: args.organizationId,
            OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: sentAt } }],
          },
          data: { lastActivityAt: sentAt, updatedBy: context.actor.id },
        })
        await writeAuditLogStrict(
          {
            actorId: context.actor.id,
            actorRole: context.actor.role,
            action: 'admin.prospect.outreach_logged',
            targetType: 'ProspectActivity',
            targetId: created.id,
            afterState: { organizationId: args.organizationId, contactId: contact.id },
          },
          tx,
        )
        return created
      })
    } catch (error) {
      // A concurrent writer won the unique receipt: this call is the replay.
      if (!isUniqueViolation(error)) throw error
      const winner = await findLogged(context.database, args)
      if (!winner) throw error
      return replayed(winner)
    }
    return {
      result: {
        activityId: activity.id,
        organizationId: args.organizationId,
        replayed: false,
        receipt: { key: outreachReceiptKey(args), verification: 'unverified' },
      },
      after: { activityId: activity.id, replayed: false },
    }
  },
}
