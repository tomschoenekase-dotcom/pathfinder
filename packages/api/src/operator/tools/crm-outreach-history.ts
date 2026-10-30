import { randomUUID } from 'node:crypto'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import type { OperatorReadTool } from '../registry'
import {
  readOutreachHistoryState,
  requireOutreachAccount,
  requireOutreachGroupScope,
  publicOutreachEvidence,
  readableOutreachReason,
} from '../outreach-history'
import { OperatorInvalidCursorError } from './page'

export const getOutreachHistory: OperatorReadTool = {
  name: 'crm.get_outreach_history',
  capability: 'crm:read',
  pagePath: ['evidence'],
  async handler(raw, context) {
    const args = OPERATOR_MCP_INPUTS['crm.get_outreach_history'].parse(raw)
    await requireOutreachAccount(args.organizationId, context)
    const { plan, revision } = await readOutreachHistoryState(context.database, args.organizationId)
    await requireOutreachGroupScope(plan.organizationIds, context)
    const position = args.cursor
      ? plan.evidence.findIndex((item) => item.evidenceId === args.cursor)
      : -1
    if (args.cursor && position < 0) throw new OperatorInvalidCursorError()
    const messagePosition = args.messageCursor
      ? plan.messages.findIndex((item) => item.messageId === args.messageCursor)
      : -1
    if (args.messageCursor && messagePosition < 0) throw new OperatorInvalidCursorError()
    const messagePage = plan.messages.slice(messagePosition + 1, messagePosition + 1 + args.limit)
    const messageNextCursor =
      messagePosition + 1 + args.limit < plan.messages.length
        ? (messagePage.at(-1)?.messageId ?? null)
        : null
    const page = plan.evidence.slice(position + 1, position + 1 + args.limit)
    const nextCursor =
      position + 1 + args.limit < plan.evidence.length ? (page.at(-1)?.evidenceId ?? null) : null
    const actionBase = () => ({
      organizationId: args.organizationId,
      expectedRevision: revision,
      operationId: randomUUID(),
    })
    return {
      organizationId: args.organizationId,
      revision,
      projection: plan.projection,
      explanation: readableOutreachReason(plan.projection.eligibilityReason),
      reviewPlan: {
        messageNextCursor,
        messageRecords: plan.messages.length,
        messageCoverage: messageNextCursor
          ? 'more messages remain; call get_outreach_history with messageCursor'
          : 'complete message window',
        historyComplete: plan.projection.historyComplete,
        organizationIds: plan.organizationIds,
        contactIds: plan.contactIds,
        messages: messagePage.map((message) => ({
          messageId: message.messageId,
          direction: message.direction,
          status: message.status,
          occurredAt: message.occurredAt,
          subject: publicOutreachEvidence(message.subject),
          source: {
            providerAccountId: message.providerAccountId,
            providerMessageId: message.providerMessageId,
          },
          review: {
            ...actionBase(),
            change: { kind: 'message', messageId: message.messageId, classification: 'unknown' },
          },
        })),
        mailboxes: plan.mailboxes.map((mailbox) => ({
          providerAccountId: mailbox.id,
          connectionStatus: mailbox.connectionStatus,
          lastSuccessfulSyncAt: mailbox.lastSuccessfulSyncAt?.toISOString() ?? null,
        })),
        completeReview: {
          ...actionBase(),
          change: { kind: 'complete', coverage: [] },
          required:
            'Supply one actual completed full-search receipt for every listed mailbox: providerAccountId, searchedAt, throughAt, query, sourceReceiptId, resultFingerprint. Do not invent coverage.',
        },
        scopeReview:
          'Canonical parent scope requires actual human review through the existing admin owner; agents cannot assert it.',
      },
      evidence: {
        items: page.map((item) => ({
          evidenceId: item.evidenceId,
          currentEvidenceId: item.currentEvidenceId,
          fingerprint: item.fingerprint,
          revision: item.revision,
          active: item.active,
          retracted: item.retracted,
          evidence: publicOutreachEvidence(item.evidence ?? item.originalEvidence),
          originalEvidence: publicOutreachEvidence(item.originalEvidence),
          provenance: { actorId: item.provenance.actorId, occurredAt: item.provenance.occurredAt },
          actions: {
            correct: { ...actionBase(), targetEvidenceId: item.evidenceId },
            retract: { ...actionBase(), targetEvidenceId: item.evidenceId },
          },
        })),
        nextCursor,
        complete: nextCursor === null,
      },
      actions: {
        reviewTool: 'crm.propose_outreach_history_review',
        retractTool: 'crm.propose_outreach_history_retract',
        relationshipReview: {
          tool: 'crm.propose_outreach_history_review',
          args: { ...actionBase(), change: { kind: 'relationship' } },
          allowedValues: ['deferred', 'declined', 'closed'],
          instruction:
            'Choose a relationship value and reason explicitly. Clearing a stop to prospect requires the human owner.',
        },
        reasonRequired: true,
        operationIdRequired:
          'Use a new UUID for a new operation; retry unchanged content with the same UUID.',
        sending:
          'Separate existing approval/release controls; no sending or unsuppression is performed.',
      },
    }
  },
}
export const crmOutreachHistoryReadTools: readonly OperatorReadTool[] = [getOutreachHistory]
