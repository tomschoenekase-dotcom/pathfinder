import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  appendSupportMessageAction,
  completeSupportRequestAction,
  requestSupportInformationAction,
} from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorApplyContext, OperatorKindContext, OperatorProposalKind } from '../proposals'

/**
 * Support follow-up as reviewable proposals over the canonical support actions: each carries the
 * operation id (replay-safe) and the request's version (so a newer customer message or a change
 * since it was read makes the proposal stale instead of overwriting). Customer-facing messages are
 * portal messages: nothing here sends email, and the result says so.
 */

const operatorActor = (context: OperatorApplyContext) =>
  ({
    actorType: 'HUMAN',
    participantKind: 'OPERATOR',
    actorId: context.actor.id,
    auditRole: 'PLATFORM_ADMIN',
  }) as const

async function readRequest(database: OperatorDatabase, tenantId: string, requestId: string) {
  return database.supportRequest.findFirst({
    where: { id: requestId, tenantId },
    select: { id: true, venueId: true, status: true, version: true },
  })
}

/** The message a prior apply of this exact operation left, found by the operation id it carries. */
async function receiptMessage(database: OperatorDatabase, tenantId: string, operationId: string) {
  return database.supportMessage.findFirst({
    where: { tenantId, submissionRequestId: operationId },
    select: { id: true, supportRequestId: true, requestVersion: true, visibility: true },
  })
}

type SupportArgs = Readonly<{
  tenantId: string
  venueId: string
  requestId: string
  expectedVersion: number
}>

function baseKind<Args extends SupportArgs>(args: {
  kind: string
  tool: OperatorProposalKind<Args>['tool']
  parse: (raw: unknown) => Args
  describe: OperatorProposalKind<Args>['describe']
  apply: OperatorProposalKind<Args>['apply']
}): OperatorProposalKind<Args> {
  return {
    kind: args.kind,
    tool: args.tool,
    capability: 'support:propose',
    parse: args.parse,
    target: (a) => ({ tenantId: a.tenantId, venueId: a.venueId }),
    authorize: async (a, context: OperatorKindContext) => {
      await assertVenueInGrant(context.grant, a.tenantId, a.venueId, context.database)
      const request = await readRequest(context.database, a.tenantId, a.requestId)
      if (!request || request.venueId !== a.venueId) throw new OperatorNotFoundError()
    },
    targetVersion: async (a) => String(a.expectedVersion),
    currentVersion: async (a, context) => {
      const request = await readRequest(context.database, a.tenantId, a.requestId)
      return request ? String(request.version) : null
    },
    describe: args.describe,
    snapshot: async (a, context) =>
      (await readRequest(context.database, a.tenantId, a.requestId)) as unknown as JsonValue,
    apply: args.apply,
    reconcile: async (a, context) => {
      const message = await receiptMessage(context.database, a.tenantId, context.operationId)
      if (!message) return { state: 'not_applied' }
      const request = await readRequest(context.database, a.tenantId, a.requestId)
      return {
        state: 'applied',
        outcome: {
          result: {
            messageId: message.id,
            requestVersion: message.requestVersion ?? request?.version ?? null,
            status: request?.status ?? null,
            portalOnly: true,
          },
          after: { messageId: message.id },
        },
      }
    },
  }
}

const noteInput = OPERATOR_MCP_INPUTS['support.propose_internal_note']
export const supportInternalNoteKind = baseKind({
  kind: 'support.internal-note',
  tool: 'support.propose_internal_note',
  parse: (raw) => noteInput.parse(raw),
  describe: (a) => ({
    title: 'Add an internal note (the customer never sees it)',
    lines: [`request ${a.requestId}`, a.body],
  }),
  apply: async (a, context: OperatorApplyContext) => {
    const saved = await appendSupportMessageAction(
      {
        operationId: context.operationId,
        tenantId: a.tenantId,
        venueId: a.venueId,
        requestId: a.requestId,
        expectedVersion: a.expectedVersion,
        visibility: 'INTERNAL_ONLY',
        body: a.body,
        attachments: [],
        actor: operatorActor(context),
      },
      context.database,
    )
    return {
      result: {
        messageId: saved.message.id,
        requestVersion: saved.requestVersion,
        replayed: saved.replayed,
        portalOnly: true,
      },
      after: { messageId: saved.message.id },
    }
  },
})

const infoInput = OPERATOR_MCP_INPUTS['support.propose_information_request']
export const supportInformationRequestKind = baseKind({
  kind: 'support.information-request',
  tool: 'support.propose_information_request',
  parse: (raw) => infoInput.parse(raw),
  describe: (a) => ({
    title: 'Ask the customer for information in their portal (no email is sent)',
    lines: [
      `request ${a.requestId}`,
      a.body,
      ...a.missingInformation.map((item) => `needs: ${item}`),
    ],
  }),
  apply: async (a, context: OperatorApplyContext) => {
    const saved = await requestSupportInformationAction(
      {
        operationId: context.operationId,
        tenantId: a.tenantId,
        venueId: a.venueId,
        requestId: a.requestId,
        expectedVersion: a.expectedVersion,
        body: a.body,
        missingInformation: a.missingInformation,
        actor: operatorActor(context),
      },
      context.database,
    )
    return {
      result: {
        messageId: saved.message.id,
        requestVersion: saved.requestVersion,
        status: saved.status,
        replayed: saved.replayed,
        portalOnly: true,
      },
      after: { messageId: saved.message.id },
    }
  },
})

const completeInput = OPERATOR_MCP_INPUTS['support.propose_completion']
export const supportCompletionKind = baseKind({
  kind: 'support.completion',
  tool: 'support.propose_completion',
  parse: (raw) => completeInput.parse(raw),
  describe: (a) => ({
    title: 'Close this support request with a message in the customer portal (no email is sent)',
    lines: [
      `request ${a.requestId}`,
      a.body,
      ...(a.expectedCompletionOutcome
        ? [`outcome ${a.expectedCompletionOutcome}, fulfillment ${a.expectedFulfillmentDigest}`]
        : ['no content-fix evidence supplied']),
    ],
  }),
  apply: async (a, context: OperatorApplyContext) => {
    const saved = await completeSupportRequestAction(
      {
        operationId: context.operationId,
        tenantId: a.tenantId,
        venueId: a.venueId,
        requestId: a.requestId,
        expectedVersion: a.expectedVersion,
        body: a.body,
        ...(a.expectedCompletionOutcome !== undefined
          ? {
              expectedCompletionOutcome: a.expectedCompletionOutcome as never,
              expectedFulfillmentDigest: a.expectedFulfillmentDigest!,
            }
          : {}),
        actor: operatorActor(context),
      },
      context.database,
    )
    return {
      result: {
        messageId: saved.message.id,
        requestVersion: saved.requestVersion,
        status: saved.status,
        replayed: saved.replayed,
        portalOnly: true,
      },
      after: { messageId: saved.message.id },
    }
  },
})

export const SUPPORT_KINDS = [
  supportInternalNoteKind,
  supportInformationRequestKind,
  supportCompletionKind,
]
