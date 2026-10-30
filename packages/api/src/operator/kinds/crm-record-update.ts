import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  readProspectCrmRecord,
  prospectCrmRecordExpectedRevision,
  updateProspectCrmRecordAction,
} from '@pathfinder/db'
import { OperatorNotFoundError } from '../grants'
import type { OperatorProposalKind, OperatorKindContext } from '../proposals'
import { requireOutreachAccount } from '../outreach-history'
const schema = OPERATOR_MCP_INPUTS['crm.propose_record_update']
type Args = ReturnType<typeof schema.parse>
const targetId = (r: Args['record']) =>
  r.type === 'draft'
    ? r.draftId
    : r.type === 'campaign'
      ? r.campaignId
      : r.type === 'member'
        ? r.memberId
        : r.noteId
export async function requireCrmRecordScope(record: Args['record'], context: OperatorKindContext) {
  if (record.type === 'note') {
    await requireOutreachAccount(record.organizationId, context)
    return
  }
  if (record.type === 'campaign') {
    if (!context.grant.allTenants) throw new OperatorNotFoundError()
    const members = await context.database.prospectCampaignMember.findMany({
      where: { campaignId: record.campaignId },
      select: { organizationId: true },
    })
    for (const id of new Set(members.map((m) => m.organizationId)))
      await requireOutreachAccount(id, context)
    return
  }
  const row =
    record.type === 'draft'
      ? await context.database.prospectOutreachDraft.findUnique({
          where: { id: record.draftId },
          select: { organizationId: true },
        })
      : await context.database.prospectCampaignMember.findUnique({
          where: { id: record.memberId },
          select: { organizationId: true },
        })
  if (!row) throw new OperatorNotFoundError()
  await requireOutreachAccount(row.organizationId, context)
}
export const crmRecordUpdateKind: OperatorProposalKind<Args> = {
  kind: 'crm.record-update',
  tool: 'crm.propose_record_update',
  capability: 'crm:propose',
  parse: (raw) => schema.parse(raw),
  target: (args) => ({ ref: targetId(args.record) }),
  authorize: async (args, context) => {
    await requireCrmRecordScope(args.record, context)
    if (!(await readProspectCrmRecord(context.database, args.record)))
      throw new OperatorNotFoundError()
  },
  targetVersion: async (args) => prospectCrmRecordExpectedRevision(args.record),
  currentVersion: async (args, context) =>
    (await readProspectCrmRecord(context.database, args.record))?.revision ?? null,
  describe: (args) => ({
    title: `${args.record.action} ${args.record.type} (history retained)`,
    lines: [`record ${targetId(args.record)}`, args.reason],
  }),
  snapshot: async (args, context) =>
    (await readProspectCrmRecord(context.database, args.record))?.state as unknown as JsonValue,
  apply: async (args, context) => {
    await requireCrmRecordScope(args.record, context)
    const result = await updateProspectCrmRecordAction(
      {
        record: args.record,
        reason: args.reason,
        operationId: context.operationId,
        actor: {
          type: 'AGENT',
          id: `operator:${context.grant.grantId}`,
          capabilities: ['prospects:crm:maintain', 'prospects:draft'],
        },
      },
      context.database,
    )
    return { result: result as Record<string, JsonValue>, after: result as JsonValue }
  },
  reconcile: async (args, context) => {
    await requireCrmRecordScope(args.record, context)
    if (args.record.type === 'draft' && args.record.action === 'edit') {
      const draft = await context.database.prospectOutreachDraft.findFirst({
        where: {
          groundingSnapshot: { path: ['crmRecordOperationId'], equals: context.operationId },
        },
      })
      return draft
        ? {
            state: 'applied',
            outcome: {
              result: {
                draftId: draft.id,
                status: draft.status,
                version: draft.version,
                contentHash: draft.contentHash,
              },
              after: { draftId: draft.id },
            },
          }
        : { state: 'not_applied' }
    }
    const receipt = await context.database.auditLog.findUnique({
      where: { id: `crm-record:${context.operationId}` },
    })
    return receipt
      ? {
          state: 'applied',
          outcome: {
            result: receipt.afterState as Record<string, JsonValue>,
            after: receipt.afterState as JsonValue,
          },
        }
      : { state: 'not_applied' }
  },
}
