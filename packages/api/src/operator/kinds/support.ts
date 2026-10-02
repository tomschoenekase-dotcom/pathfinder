import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { createHash } from 'node:crypto'

import {
  appendSupportMessageAction,
  ClientNotificationError,
  completeSupportRequestAction,
  createClientNotificationIntent,
  createOperatorSupportRequestAction,
  OperatorSupportRequestError,
  requestSupportInformationAction,
  SupportStatusTransitionError,
  transitionSupportRequestStatusAction,
} from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import {
  dispatchNotificationEmail,
  dispatchQueuedForRequest,
  prepareNotificationEmail,
  type NotificationEmailLabel,
} from '../notifications'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
} from '../proposals'

/**
 * Support follow-up as reviewable proposals over the canonical support actions: each carries the
 * operation id (replay-safe) and the request's version (so a newer customer message or a change
 * since it was read makes the proposal stale instead of overwriting). Customer-facing messages are
 * portal messages. Only an information request (and a new request that asks for it) also records a
 * notification intent: the portal post is immediate and the worker emails the exact member's
 * verified address, behind a default-off deployment switch. Nothing here sends email directly.
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

/** People who can open this conversation and still belong to the tenant. */
async function eligibleRecipients(database: OperatorDatabase, tenantId: string, requestId: string) {
  const request = await database.supportRequest.findFirst({
    where: { id: requestId, tenantId },
    select: {
      requesterUserId: true,
      requesterMembership: { select: { status: true } },
      participants: {
        where: { revokedAt: null },
        select: { userId: true, membership: { select: { status: true } } },
      },
    },
  })
  const people = new Set<string>()
  if (request?.requesterUserId && request.requesterMembership?.status === 'ACTIVE')
    people.add(request.requesterUserId)
  for (const participant of request?.participants ?? [])
    if (participant.membership.status === 'ACTIVE') people.add(participant.userId)
  return people
}

/** The named recipient if eligible; otherwise the only eligible person; otherwise nobody. */
async function informationRecipient(
  database: OperatorDatabase,
  a: { tenantId: string; requestId: string; recipientUserId?: string | undefined },
): Promise<string | null> {
  const people = await eligibleRecipients(database, a.tenantId, a.requestId)
  if (a.recipientUserId !== undefined)
    return people.has(a.recipientUserId) ? a.recipientUserId : null
  return people.size === 1 ? [...people][0]! : null
}

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value

const baseInformationKind = baseKind({
  kind: 'support.information-request',
  tool: 'support.propose_information_request',
  parse: (raw) => infoInput.parse(raw),
  describe: (a) => ({
    title:
      'Ask the customer for information in their portal and, where the deployment allows it, by email to their verified address',
    lines: [
      `request ${a.requestId}`,
      ...(a.recipientUserId
        ? [`recipient ${a.recipientUserId}`]
        : ['recipient: the only eligible person, else portal only']),
      a.body,
      ...a.missingInformation.map((item) => `needs: ${item}`),
    ],
  }),
  apply: async (a, context: OperatorApplyContext) => {
    // Resolve the exact recipient and their verified address first; the identity call never runs
    // inside the transaction. No exact recipient means a portal-only request, never a guess.
    const recipient = await informationRecipient(context.database, a)
    const mail = recipient ? await prepareNotificationEmail(recipient) : null
    const done = await context.database
      .$transaction(
        async (tx) => {
          const inTransaction = {
            $transaction: (work: (transaction: never) => Promise<unknown>) => work(tx as never),
          } as never
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
            inTransaction,
          )
          if (!recipient || !mail) return { saved, intent: null }
          // The revision this message produced, not the request's current one, so a replay after
          // later activity still resolves to the same intent.
          const posted = await tx.supportMessage.findFirst({
            where: { id: saved.message.id, tenantId: a.tenantId },
            select: { requestVersion: true, supportRequest: { select: { subject: true } } },
          })
          if (!posted?.requestVersion)
            throw new OperatorStaleError('Support request changed; refresh it')
          const { intent } = await createClientNotificationIntent(tx, {
            tenantId: a.tenantId,
            venueId: a.venueId,
            supportRequestId: a.requestId,
            supportMessageId: saved.message.id,
            requestVersion: posted.requestVersion,
            questionIds: [],
            recipientUserId: recipient,
            recipientEmail: mail.recipientEmail,
            emailRequested: true,
            emailEnabled: mail.emailEnabled,
            content: {
              version: 1,
              subject: clip(`Information needed: ${posted.supportRequest.subject}`, 200),
              intro: clip(a.body, 4000),
              items: a.missingInformation.map((text) => ({ text, requestId: a.requestId })),
            },
            actor: { actorId: context.actor.id, auditRole: 'PLATFORM_ADMIN' },
          })
          return { saved, intent }
        },
        { timeout: 30_000 },
      )
      .catch((error: unknown) => {
        if (error instanceof ClientNotificationError && error.code === 'NOT_FOUND')
          throw new OperatorStaleError('Support request changed; refresh it')
        throw error
      })
    const email: NotificationEmailLabel | null = done.intent
      ? await dispatchNotificationEmail(context.database, done.intent)
      : null
    return {
      result: {
        messageId: done.saved.message.id,
        requestVersion: done.saved.requestVersion,
        status: done.saved.status,
        replayed: done.saved.replayed,
        portalOnly: done.intent === null,
        portalPosted: true,
        notification: done.intent
          ? { intentId: done.intent.id, portal: 'portal_posted', email }
          : { state: 'no_exact_recipient' },
      },
      after: { messageId: done.saved.message.id },
    }
  },
})

export const supportInformationRequestKind: OperatorProposalKind<
  ReturnType<typeof infoInput.parse>
> = {
  ...baseInformationKind,
  // The recipient, when named, must be able to open this very conversation in this tenant.
  authorize: async (a, context) => {
    await baseInformationKind.authorize?.(a, context)
    if (
      a.recipientUserId !== undefined &&
      (await informationRecipient(context.database, a)) === null
    )
      throw new OperatorNotFoundError()
  },
  currentVersion: async (a, context) => {
    const current = await baseInformationKind.currentVersion(a, context)
    if (current === null) return null
    // A named recipient who has left the tenant since approval makes this stale, not misdirected.
    if (
      a.recipientUserId !== undefined &&
      (await informationRecipient(context.database, a)) === null
    )
      return null
    return current
  },
  reconcile: async (a, context) => {
    const base = await baseInformationKind.reconcile!(a, context)
    if (base.state !== 'applied') return base
    // The apply committed. If it was cut off before the email reached the queue, hand it over
    // now; the job is keyed by intent and generation, so this can never send twice.
    const email = await dispatchQueuedForRequest(context.database, {
      tenantId: a.tenantId,
      supportRequestId: a.requestId,
    })
    return {
      state: 'applied',
      outcome: {
        ...base.outcome,
        result: { ...base.outcome.result, portalOnly: email === null, ...(email ? { email } : {}) },
      },
    }
  },
}

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

const triageInput = OPERATOR_MCP_INPUTS['support.propose_triage']

/**
 * The transition and the optional internal note commit together, so a request never records one
 * without the other. A refusal by the canonical rules (the move is not allowed from here, or the
 * request changed) is a stale proposal, not a failure.
 */
export const supportTriageKind: OperatorProposalKind<ReturnType<typeof triageInput.parse>> = {
  ...baseKind({
    kind: 'support.triage',
    tool: 'support.propose_triage',
    parse: (raw) => triageInput.parse(raw),
    describe: (a) => ({
      title: `Move this support request to ${a.status} (visible in the customer's portal, no email)`,
      lines: [`request ${a.requestId}`, ...(a.note ? [`internal note: ${a.note}`] : [])],
    }),
    apply: async (a, context: OperatorApplyContext) => {
      try {
        const done = await context.database.$transaction(async (tx) => {
          // Both canonical actions join this one transaction instead of opening their own.
          const inTransaction = {
            $transaction: (work: (transaction: never) => Promise<unknown>) => work(tx as never),
          } as never
          const transition = await transitionSupportRequestStatusAction(
            {
              tenantId: a.tenantId,
              venueId: a.venueId,
              requestId: a.requestId,
              expectedVersion: a.expectedVersion,
              toStatus: a.status,
              actor: operatorActor(context),
            },
            inTransaction,
          )
          if (a.note === undefined) return { transition, messageId: null as string | null }
          const note = await appendSupportMessageAction(
            {
              operationId: context.operationId,
              tenantId: a.tenantId,
              venueId: a.venueId,
              requestId: a.requestId,
              expectedVersion: a.expectedVersion + 1,
              visibility: 'INTERNAL_ONLY',
              body: a.note,
              attachments: [],
              actor: operatorActor(context),
            },
            inTransaction,
          )
          return { transition, messageId: note.message.id as string | null }
        })
        const request = await readRequest(context.database, a.tenantId, a.requestId)
        return {
          result: {
            status: request?.status ?? a.status,
            requestVersion: request?.version ?? null,
            messageId: done.messageId,
            portalOnly: true,
          },
          after: { status: request?.status ?? a.status, version: request?.version ?? null },
        }
      } catch (error) {
        if (error instanceof SupportStatusTransitionError) {
          throw new OperatorStaleError(error.message)
        }
        throw error
      }
    },
  }),
  // The transition writes an audit event naming the version it produced and who moved it, so that
  // event proves an interrupted apply happened and its absence proves nothing was written.
  reconcile: async (a, context) => {
    const event = await context.database.supportRequestAuditEvent.findFirst({
      where: {
        tenantId: a.tenantId,
        supportRequestId: a.requestId,
        eventType: 'STATUS_CHANGED',
        requestVersion: a.expectedVersion + 1,
        toStatus: a.status,
        actorId: context.actor.id,
      },
      select: { id: true },
    })
    if (!event) return { state: 'not_applied' }
    const request = await readRequest(context.database, a.tenantId, a.requestId)
    return {
      state: 'applied',
      outcome: {
        result: {
          status: request?.status ?? a.status,
          requestVersion: request?.version ?? null,
          messageId: null,
          portalOnly: true,
        },
        after: { status: request?.status ?? a.status, version: request?.version ?? null },
      },
    }
  },
}

// ---------------------------------------------------------------------------
// support.create-request
// ---------------------------------------------------------------------------

const createRequestInput = OPERATOR_MCP_INPUTS['support.propose_create_request']
type CreateRequestArgs = ReturnType<typeof createRequestInput.parse>

async function createRequestScope(database: OperatorDatabase, a: CreateRequestArgs) {
  const [member, questions] = await Promise.all([
    database.tenantMembership.findFirst({
      where: { tenantId: a.tenantId, userId: a.recipientUserId, status: 'ACTIVE' },
      select: { id: true },
    }),
    a.questionIds.length === 0
      ? Promise.resolve([])
      : database.agentQuestion.findMany({
          where: { tenantId: a.tenantId, venueId: a.venueId, id: { in: a.questionIds } },
          select: { id: true, question: true, status: true, updatedAt: true },
        }),
  ])
  return { member, questions }
}

const createRequestVersion = (
  scope: Awaited<ReturnType<typeof createRequestScope>>,
  a: CreateRequestArgs,
) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        a.recipientUserId,
        scope.questions
          .map((q) => [q.id, q.status, q.updatedAt.toISOString()])
          .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      ]),
    )
    .digest('hex')

function createRequestOutcome(
  saved: { requestId: string; messageId: string; status: string; requestVersion: number },
  a: CreateRequestArgs,
  notification: { intentId: string; email: NotificationEmailLabel } | null,
) {
  return {
    result: {
      requestId: saved.requestId,
      messageId: saved.messageId,
      requestVersion: saved.requestVersion,
      status: saved.status,
      priority: a.priority,
      portalOnly: notification === null,
      portalPosted: true,
      ...(notification ? { notification: { ...notification, portal: 'portal_posted' } } : {}),
    },
    after: { requestId: saved.requestId, messageId: saved.messageId },
  }
}

/**
 * A new conversation the operator opens with one member, with a customer-visible first message.
 * Questions are linked by reference only. The recipient must be an ACTIVE member of this tenant,
 * checked at proposal, at approval and again by the database when access is granted.
 */
export const supportCreateRequestKind: OperatorProposalKind<CreateRequestArgs> = {
  kind: 'support.create-request',
  tool: 'support.propose_create_request',
  capability: 'support:propose',
  parse: (raw) => createRequestInput.parse(raw),
  target: (a) => ({ tenantId: a.tenantId, venueId: a.venueId }),
  authorize: async (a, context) => {
    await assertVenueInGrant(context.grant, a.tenantId, a.venueId, context.database)
    const { member, questions } = await createRequestScope(context.database, a)
    if (questions.length !== a.questionIds.length) throw new OperatorNotFoundError()
    if (!member) {
      // A known member of this tenant who is no longer active (left, removed, re-invited) makes
      // the proposal stale; someone who was never a member here is simply not found.
      const former = await context.database.tenantMembership.findFirst({
        where: { tenantId: a.tenantId, userId: a.recipientUserId },
        select: { id: true },
      })
      if (former) throw new OperatorStaleError('The recipient is no longer an active member')
      throw new OperatorNotFoundError()
    }
  },
  targetVersion: async (a, context) =>
    createRequestVersion(await createRequestScope(context.database, a), a),
  currentVersion: async (a, context) => {
    const scope = await createRequestScope(context.database, a)
    if (
      !scope.member ||
      scope.questions.length !== a.questionIds.length ||
      scope.questions.some((q) => q.status !== 'PENDING')
    )
      return null
    return createRequestVersion(scope, a)
  },
  describe: (a) => ({
    title: a.notifyByEmail
      ? "Open a new support request in the customer's portal and, where the deployment allows it, email their verified address"
      : "Open a new support request in the customer's portal (no email is sent)",
    lines: [
      `venue ${a.venueId}`,
      `recipient ${a.recipientUserId}`,
      `category ${a.category}, priority ${a.priority}`,
      `subject: ${a.subject}`,
      a.body,
      ...a.questionIds.map((id) => `about question ${id}`),
    ],
  }),
  snapshot: async (a, context) => {
    const { questions } = await createRequestScope(context.database, a)
    return {
      questions: questions.map((q) => ({
        questionId: q.id,
        status: q.status,
        updatedAt: q.updatedAt.toISOString(),
      })),
    }
  },
  apply: async (a, context: OperatorApplyContext) => {
    const mail = a.notifyByEmail ? await prepareNotificationEmail(a.recipientUserId) : null
    try {
      const done = await context.database.$transaction(
        async (tx) => {
          const inTransaction = {
            $transaction: (work: (transaction: never) => Promise<unknown>) => work(tx as never),
          } as never
          const saved = await createOperatorSupportRequestAction(
            {
              operationId: context.operationId,
              tenantId: a.tenantId,
              venueId: a.venueId,
              category: a.category,
              subject: a.subject,
              body: a.body,
              priority: a.priority,
              recipientUserId: a.recipientUserId,
              questionIds: a.questionIds,
              actor: { actorId: context.actor.id, auditRole: 'PLATFORM_ADMIN' },
            },
            inTransaction,
          )
          if (!mail || saved.replayed) return { saved, intent: null }
          const { intent } = await createClientNotificationIntent(tx, {
            tenantId: a.tenantId,
            venueId: a.venueId,
            supportRequestId: saved.requestId,
            supportMessageId: saved.messageId,
            requestVersion: saved.requestVersion,
            questionIds: a.questionIds,
            recipientUserId: a.recipientUserId,
            recipientEmail: mail.recipientEmail,
            emailRequested: true,
            emailEnabled: mail.emailEnabled,
            content: {
              version: 1,
              subject: clip(a.subject, 200),
              intro: clip(a.body, 4000),
              items:
                saved.questionTexts.length > 0
                  ? saved.questionTexts.map((text, index) => ({
                      text: clip(text, 2000),
                      requestId: saved.requestId,
                      questionId: a.questionIds[index]!,
                    }))
                  : [{ text: clip(a.subject, 500), requestId: saved.requestId }],
            },
            actor: { actorId: context.actor.id, auditRole: 'PLATFORM_ADMIN' },
          })
          return { saved, intent }
        },
        { timeout: 30_000 },
      )
      const email = done.intent
        ? await dispatchNotificationEmail(context.database, done.intent)
        : null
      return createRequestOutcome(
        done.saved,
        a,
        done.intent && email ? { intentId: done.intent.id, email } : null,
      )
    } catch (error) {
      if (
        (error instanceof OperatorSupportRequestError &&
          (error.code === 'CONFLICT' || error.code === 'NOT_FOUND')) ||
        (error instanceof ClientNotificationError && error.code === 'NOT_FOUND')
      )
        throw new OperatorStaleError('The recipient or a linked question changed; refresh it')
      throw error
    }
  },
  reconcile: async (a, context) => {
    const message = await receiptMessage(context.database, a.tenantId, context.operationId)
    if (!message) return { state: 'not_applied' }
    const request = await readRequest(context.database, a.tenantId, message.supportRequestId)
    const email = await dispatchQueuedForRequest(context.database, {
      tenantId: a.tenantId,
      supportRequestId: message.supportRequestId,
    })
    const intent = email
      ? await context.database.clientNotificationIntent.findFirst({
          where: { tenantId: a.tenantId, supportRequestId: message.supportRequestId },
          select: { id: true },
        })
      : null
    return {
      state: 'applied',
      outcome: createRequestOutcome(
        {
          requestId: message.supportRequestId,
          messageId: message.id,
          status: request?.status ?? 'OPEN',
          requestVersion: message.requestVersion ?? 1,
        },
        a,
        intent && email ? { intentId: intent.id, email } : null,
      ),
    }
  },
}

// ---------------------------------------------------------------------------
// support.client-reply
// ---------------------------------------------------------------------------

const replyInput = OPERATOR_MCP_INPUTS['support.propose_client_reply']
/**
 * An ordinary customer-visible message on an existing conversation. The request's version is the
 * guard: any newer message, from the customer or anyone else, makes the proposal stale, so a reply
 * never lands on a conversation that has moved on since it was read. Portal only.
 */
export const supportClientReplyKind = baseKind({
  kind: 'support.client-reply',
  tool: 'support.propose_client_reply',
  parse: (raw) => replyInput.parse(raw),
  describe: (a) => ({
    title: 'Reply to the customer in their portal (they see this message; no email is sent)',
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
        visibility: 'CLIENT_VISIBLE',
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
        status: saved.status,
        replayed: saved.replayed,
        portalOnly: true,
      },
      after: { messageId: saved.message.id },
    }
  },
})

export const SUPPORT_KINDS = [
  supportCreateRequestKind,
  supportClientReplyKind,
  supportTriageKind,
  supportInternalNoteKind,
  supportInformationRequestKind,
  supportCompletionKind,
]
