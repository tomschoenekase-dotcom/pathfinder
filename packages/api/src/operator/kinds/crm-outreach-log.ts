import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { writeAuditLogStrict } from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { OperatorNotFoundError } from '../grants'
import type { OperatorApplyContext, OperatorKindContext, OperatorProposalKind } from '../proposals'

const input = OPERATOR_MCP_INPUTS['crm.log_outreach_sent']
type LogArgs = ReturnType<typeof input.parse>

/**
 * Records in the CRM history that an email went out from Gmail. It writes one ProspectActivity row
 * and nothing else: the Gmail connector sent the email, Torchiko sent nothing, and the ProspectSend
 * tables are never touched. There is no canonical domain action for this; the CRM's own timeline
 * write (ProspectActivity, as noteworthy events elsewhere do) is the record.
 */
async function findLogged(database: OperatorDatabase, args: LogArgs) {
  return database.prospectActivity.findFirst({
    where: {
      organizationId: args.organizationId,
      type: 'OUTREACH_SENT',
      evidence: { path: ['gmailMessageId'], equals: args.gmailMessageId },
    },
    select: { id: true, occurredAt: true },
  })
}

export const crmOutreachLogKind: OperatorProposalKind<LogArgs> = {
  kind: 'crm.outreach-log',
  tool: 'crm.log_outreach_sent',
  capability: 'crm:log',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ ref: args.organizationId }),
  authorize: async (args, context: OperatorKindContext) => {
    const contact = await context.database.prospectContact.findFirst({
      where: { id: args.contactId, organizationId: args.organizationId },
      select: { id: true },
    })
    if (!contact) throw new OperatorNotFoundError()
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
    const existing = await findLogged(context.database, args)
    if (existing) {
      return {
        result: { activityId: existing.id, organizationId: args.organizationId, replayed: true },
        after: { activityId: existing.id, replayed: true },
      }
    }
    const sentAt = new Date(args.sentAt)
    const activity = await context.database.$transaction(async (tx) => {
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
            sentAt: args.sentAt,
            proposalId: context.proposalId,
          },
          actorId: context.actor.id,
          occurredAt: sentAt,
        },
        select: { id: true },
      })
      await tx.prospectOpportunity.updateMany({
        where: { organizationId: args.organizationId },
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
    return {
      result: { activityId: activity.id, organizationId: args.organizationId, replayed: false },
      after: { activityId: activity.id, replayed: false },
    }
  },
}
