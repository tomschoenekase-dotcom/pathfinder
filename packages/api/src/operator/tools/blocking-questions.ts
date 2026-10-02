import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { supportRequestPortalPath } from '@pathfinder/db'

import { operatorUntrustedText, redactAddresses } from '../crm-projection'
import { assertTenantInGrant, assertVenueInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'
import { notificationIntentSelect, notificationSummary } from './notification-summary'
import { decodeKeysetCursor, encodeKeysetCursor, pageResult, requireCursorInScope } from './page'

/**
 * The exact blocking questions behind customers.get_onboarding's counts. Every row is an existing
 * AgentQuestion read through its canonical routing link; nothing here has state of its own, so it
 * cannot drift from the portal or from customers.propose_onboarding_questions, which needs the
 * ids and `expectedUpdatedAt` returned here.
 */

const TEXT_MAX = 2000

const questionSelect = {
  id: true,
  venueId: true,
  status: true,
  question: true,
  context: true,
  category: true,
  urgency: true,
  questionType: true,
  blocking: true,
  dueAt: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
  answer: true,
  answeredAt: true,
  agentRunId: true,
  agentRun: { select: { id: true, status: true, requestedOperation: true } },
  onboardingLink: {
    select: {
      id: true,
      supportRequestId: true,
      recipientUserId: true,
      createdAt: true,
      answeredSupportMessageId: true,
      resumedAt: true,
      supportRequest: { select: { status: true, version: true, artifacts: true } },
    },
  },
} as const

type QuestionRow = {
  id: string
  venueId: string
  status: 'PENDING' | 'ANSWERED' | 'DISMISSED' | 'EXPIRED' | 'CANCELLED'
  question: string
  context: string | null
  category: string
  urgency: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
  questionType: string
  blocking: boolean
  dueAt: Date | null
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
  answer: string | null
  answeredAt: Date | null
  agentRunId: string | null
  agentRun: { id: string; status: string; requestedOperation: string } | null
  onboardingLink: {
    id: string
    supportRequestId: string
    recipientUserId: string
    createdAt: Date
    answeredSupportMessageId: string | null
    resumedAt: Date | null
    supportRequest: { status: string; version: number; artifacts: unknown }
  } | null
}

const text = (value: string | null | undefined, max = TEXT_MAX) =>
  value ? operatorUntrustedText(redactAddresses(value), max) : null

/** The why, effect and finding recorded when the question was routed, when it was. */
function routedContext(artifacts: unknown) {
  const raw =
    artifacts && typeof artifacts === 'object'
      ? (artifacts as { onboardingQuestionContext?: unknown }).onboardingQuestionContext
      : null
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pick = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : null)
  return { why: pick('why'), effect: pick('effect'), whatWasFound: pick('whatWasFound') }
}

function stateOf(row: QuestionRow, now: Date) {
  if (row.status === 'ANSWERED') return 'answered' as const
  if (row.status === 'DISMISSED') return 'declined' as const
  if (row.status === 'EXPIRED') return 'expired' as const
  if (row.status === 'CANCELLED') return 'superseded' as const
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return 'expired' as const
  // The work it blocked has moved on without it, so asking it is no longer meaningful.
  if (row.agentRun && row.agentRun.status !== 'AWAITING_INPUT') return 'superseded' as const
  if (row.onboardingLink)
    return row.onboardingLink.answeredSupportMessageId
      ? ('answered' as const)
      : ('routed_awaiting_answer' as const)
  return 'awaiting_routing' as const
}

function questionView(row: QuestionRow, now: Date) {
  const state = stateOf(row, now)
  const routed = routedContext(row.onboardingLink?.supportRequest.artifacts)
  const link = row.onboardingLink
  return {
    questionId: row.id,
    venueId: row.venueId,
    status: row.status,
    state,
    question: operatorUntrustedText(redactAddresses(row.question), TEXT_MAX),
    // An unrouted question has only its own context; a routed one has the reviewed explanation.
    why: text(routed.why ?? row.context),
    effect: text(routed.effect),
    whatWasFound: text(routed.whatWasFound),
    category: row.category,
    urgency: row.urgency,
    questionType: row.questionType,
    blocking: row.blocking,
    dueAt: row.dueAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    expectedUpdatedAt: row.updatedAt.toISOString(),
    proposable:
      state === 'awaiting_routing' &&
      row.blocking &&
      row.agentRunId !== null &&
      row.agentRun?.status === 'AWAITING_INPUT',
    blockedWork: {
      agentRunId: row.agentRun?.id ?? null,
      status: row.agentRun?.status ?? null,
      requestedOperation: row.agentRun?.requestedOperation ?? null,
    },
    routing: link
      ? {
          linkId: link.id,
          supportRequestId: link.supportRequestId,
          recipientUserId: link.recipientUserId,
          routedAt: link.createdAt.toISOString(),
          requestStatus: link.supportRequest.status,
          requestVersion: link.supportRequest.version,
          answeredMessageId: link.answeredSupportMessageId,
          resumedAt: link.resumedAt?.toISOString() ?? null,
          portalPath: supportRequestPortalPath(row.venueId, link.supportRequestId),
        }
      : null,
    answer: text(row.answer, 1000),
    answeredAt: row.answeredAt?.toISOString() ?? null,
  }
}

const customersListBlockingQuestions: OperatorReadTool = {
  name: 'customers.list_blocking_questions',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['customers.list_blocking_questions'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    if (input.venueId !== undefined)
      await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const base = {
      tenantId: input.tenantId,
      blocking: true,
      ...(input.venueId !== undefined ? { venueId: input.venueId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    }
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    // A cursor must name a row this very query could return, never another tenant's or filter's.
    await requireCursorInScope(after?.id, (id) =>
      context.database.agentQuestion.findFirst({ where: { ...base, id }, select: { id: true } }),
    )
    const rows = await context.database.agentQuestion.findMany({
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
      select: questionSelect,
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => questionView(row as QuestionRow, context.now)),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.createdAt, page.at(-1)!.id)
        : null,
    )
  },
}

const customersGetBlockingQuestion: OperatorReadTool = {
  name: 'customers.get_blocking_question',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['customers.get_blocking_question'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const row = await context.database.agentQuestion.findFirst({
      where: { id: input.questionId, tenantId: input.tenantId, blocking: true },
      select: questionSelect,
    })
    if (!row) throw new OperatorNotFoundError()
    const [discussionMessages, intents] = await Promise.all([
      context.database.agentQuestionDiscussionMessage.count({
        where: { tenantId: input.tenantId, questionId: row.id },
      }),
      context.database.clientNotificationIntent.findMany({
        where: {
          tenantId: input.tenantId,
          OR: [
            { questionIds: { has: row.id } },
            ...(row.onboardingLink
              ? [{ supportRequestId: row.onboardingLink.supportRequestId }]
              : []),
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
        select: notificationIntentSelect,
      }),
    ])
    return {
      ...questionView(row as QuestionRow, context.now),
      discussionMessages,
      notifications: intents.map(notificationSummary),
    }
  },
}

export const blockingQuestionReadTools: readonly OperatorReadTool[] = [
  customersListBlockingQuestions,
  customersGetBlockingQuestion,
]
